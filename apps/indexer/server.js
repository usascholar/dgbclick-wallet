// Indexer façade (#4): the wallet's indexer seam. Answers address-level DGB
// queries (UTXOs, history) by translating addresses to Electrum scripthashes
// and asking a stock ElectrumX. The wallet never learns which backend is
// behind this API — the M3 DigiDollar-positions scanner lands here too.
//
// Privacy (AC): queries are per-address only; xpubs never reach this service.

import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { decodeWitnessAddress, parseDDVersion, parseMintMetadata, parseTransferMetadata, parseRedeemMetadata, ddTokenOutputKey, LOCK_TIERS } from 'digidollar-js';

export function configFromEnv() {
  return {
    port: Number(process.env.PORT) || 8789,
    hrp: process.env.DGB_HRP || 'dgbt', // dgb | dgbt | dgbrt
    electrum: {
      host: process.env.ELECTRUM_HOST || '127.0.0.1',
      port: Number(process.env.ELECTRUM_PORT) || 50001,
    },
    // Pool size and per-session request budget before recycling (ElectrumPool):
    // ElectrumX throttles per session, so spreading load across a few sessions
    // and retiring them before they accrue cost is what keeps reads fast.
    electrumPool: Number(process.env.ELECTRUM_POOL) || 6,
    electrumRecycleAfter: Number(process.env.ELECTRUM_RECYCLE_AFTER) || 40,
    // Bind address (security F7). Default LOOPBACK: the wallet server reaches
    // the façade over loopback, and it has no per-IP rate limit of its own —
    // if the firewall ever opened, a public 0.0.0.0 bind would be a free,
    // unthrottled ElectrumX proxy. Containers set BIND_HOST=0.0.0.0.
    bindHost: process.env.BIND_HOST || '127.0.0.1',
    // Scan budget (security F3): one HTTP request to /positions or /dd-utxos
    // (or a 200-address bulk read) used to fan out to ONE ElectrumX call per
    // history entry — thousands of upstream calls per request on a hot
    // address. The budget caps upstream calls, items examined, and wall time
    // per REQUEST (shared across all addresses of a bulk read — a per-address
    // budget × 200 is not a budget). Sized as an ABUSE CEILING, not a page
    // size: no real wallet should ever trip it; if one does, log it and
    // raise the number rather than let money scans truncate.
    scanBudget: {
      maxUpstream: Number(process.env.SCAN_MAX_UPSTREAM) || 4000,
      maxItems: Number(process.env.SCAN_MAX_ITEMS) || 5000,
      deadlineMs: Number(process.env.SCAN_DEADLINE_MS) || 20_000,
    },
    // Global admission ceiling (security F3): the per-session in-flight cap
    // bounds what is ON THE WIRE, but its FIFO wait queue was unbounded — a
    // flood could queue unlimited requests in indexer memory. Past this many
    // admitted (in-flight + queued) requests pool-wide, answer 503 cleanly.
    maxAdmitted: Number(process.env.MAX_ADMITTED) || 1200,
  };
}

// ---- Minimal Electrum client: newline-delimited JSON-RPC over TCP ----
// Cap the unframed read buffer: a compromised/broken ElectrumX must not be able
// to exhaust indexer memory with an endless line that never sends a newline (#55).
const MAX_ELECTRUM_FRAME = 16 * 1024 * 1024;

// Per-session in-flight ceiling. ElectrumX budgets per session and meets
// excess pipelining with per-session throttling, so an unbounded login burst
// just builds an invisible queue INSIDE ElectrumX whose latency we can neither
// see nor shed. Cap it here so bursts queue visibly (FIFO) on our side instead.
const MAX_IN_FLIGHT_PER_SESSION = 100;

class ElectrumClient {
  constructor({ host, port }) {
    this.host = host;
    this.port = port;
    this.sock = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = []; // FIFO queue for the in-flight ceiling (see request())
    // Frame assembly buffers RAW chunks and rescans only NEW bytes for '\n'
    // (see #onData) — never flatten-then-rescan the whole buffer per chunk.
    this.chunks = [];
    this.chunksLength = 0;
    this.scanChunk = 0;  // first chunk not yet fully scanned for '\n'
    this.scanOffset = 0; // byte offset within that chunk where scanning resumes
    this.served = 0;
  }

  connect() {
    if (this.sock) return this.ready;
    // The server.version handshake is part of CONNECTING, not of the process
    // lifetime: ElectrumX ≥1.4 kills any connection whose first message is
    // something else, so every reconnect must re-handshake (#32).
    this.ready = new Promise((resolve, reject) => {
      const sock = createConnection(this.port, this.host);
      sock.setNoDelay(true);
      // An idle upstream socket must not hold the process open: the HTTP
      // listener owns the lifetime. (With a POOL this became visible — six
      // live sockets kept node:test from ever exiting.)
      sock.unref();
      sock.on('connect', () => resolve());
      // Guard every socket event by IDENTITY: recycle() destroys the old socket
      // and a fresh session can start before the old one's async 'close' fires.
      // A dying socket must never null its live successor, reject requests the
      // new session is carrying, or feed its late bytes into the frame parser.
      sock.on('data', (d) => { if (this.sock === sock) this.#onData(d); });
      const fail = (err) => {
        if (this.sock !== sock) return; // a newer session owns this client now
        this.sock = null;
        // a transport failure (closed/refused socket) — tag it so the HTTP
        // layer answers a generic "backend unreachable" instead of leaking the
        // node:net error string (security F4)
        const e = err ?? new Error('electrum connection closed');
        e.upstream = true;
        reject(e);
        for (const { reject: rj } of this.pending.values()) rj(e);
        this.pending.clear();
        for (const w of this.waiters) w.reject(e);
        this.waiters = [];
      };
      sock.on('error', fail);
      sock.on('close', () => fail());
      this.sock = sock;
    }).then(() => this.#send('server.version', ['dd-indexer 0.1', '1.4']));
    return this.ready;
  }

  #send(method, params) {
    const id = this.nextId++;
    this.sock.write(JSON.stringify({ id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      // Every settle frees an in-flight slot, so wake any queued FIFO waiter.
      const settle = (fn, v) => { fn(v); this.#releaseWaiter(); };
      this.pending.set(id, { resolve: (v) => settle(resolve, v), reject: (e) => settle(reject, e) });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          const te = new Error(`electrum timeout: ${method}`); te.upstream = true;
          reject(te);
          this.#releaseWaiter();
        }
      }, 15_000).unref();
    });
  }

  #releaseWaiter() {
    // Wake as many FIFO waiters as there are free slots. Each woken waiter
    // re-checks the cap before sending, so a slot grabbed by a newer request
    // in between simply re-queues it rather than breaching the ceiling.
    while (this.waiters.length && this.pending.size < MAX_IN_FLIGHT_PER_SESSION) {
      this.waiters.shift().resolve();
    }
  }

  #onData(d) {
    // Frame assembly: buffer raw chunks and scan only NEW bytes for the frame
    // terminator. Electrum frames are single-line JSON; a multi-MB verbose-tx
    // response arrives in ~64KB chunks with no newline until the end, and the
    // old `buf += d` + `buf.indexOf('\n')` re-flattened and re-scanned the
    // ENTIRE buffer per chunk — O(n²) work that blocked the event loop for ~1s
    // and stalled every pool socket behind it. This costs one concat per
    // COMPLETED frame instead. (Searching for byte 0x0a is UTF-8-safe:
    // continuation bytes are ≥0x80, so a split multi-byte char can't fake a
    // newline.)
    this.chunks.push(d);
    this.chunksLength += d.length;
    if (this.chunksLength > MAX_ELECTRUM_FRAME) {
      // Overflow: reject everything pending AND destroy the socket. After a
      // dropped partial frame the byte stream is desynchronized — leaving the
      // socket live in the pool would pair every later response with the
      // wrong request.
      this.chunks = [];
      this.chunksLength = 0;
      this.scanChunk = 0;
      this.scanOffset = 0;
      const err = new Error('electrum response exceeded frame limit'); err.upstream = true;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.sock?.destroy();
      return;
    }
    for (;;) {
      // Find the next '\n', resuming where the previous scan stopped.
      let nlChunk = -1;
      let nlPos = -1;
      for (let i = this.scanChunk; i < this.chunks.length; i++) {
        const from = i === this.scanChunk ? this.scanOffset : 0;
        const p = this.chunks[i].indexOf(0x0a, from);
        if (p >= 0) { nlChunk = i; nlPos = p; break; }
        this.scanChunk = i;
        this.scanOffset = this.chunks[i].length;
      }
      if (nlChunk < 0) return;
      // Assemble the completed frame ONCE, drop the consumed bytes, and let
      // the string go out of scope right after the parse below.
      const line = Buffer.concat([
        ...this.chunks.slice(0, nlChunk),
        this.chunks[nlChunk].subarray(0, nlPos),
      ]).toString('utf8');
      const rest = this.chunks[nlChunk].subarray(nlPos + 1);
      let consumed = this.chunksLength - rest.length;
      for (let i = nlChunk + 1; i < this.chunks.length; i++) consumed -= this.chunks[i].length;
      this.chunks = rest.length ? [rest, ...this.chunks.slice(nlChunk + 1)] : this.chunks.slice(nlChunk + 1);
      this.chunksLength -= consumed;
      // The remainder of the newline chunk (from nlPos+1) was never scanned —
      // indexOf stopped at the first match — so scanning restarts at 0.
      this.scanChunk = 0;
      this.scanOffset = 0;
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A malformed line from a malicious/broken backend must not crash the
        // indexer process (#55) — skip it; the pending request will time out.
        continue;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) continue; // subscription notification — not used yet
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        // The SERVER answered: this is an RPC-level failure ("unknown
        // transaction" & co.), not a transport problem. The mark lets the pool
        // propagate it without recycling a healthy session or retrying a
        // request that would deterministically fail again.
        err.electrumRpc = true;
        err.upstream = true; // an upstream (ElectrumX) failure — see the F4 classifier
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  async request(method, params = []) {
    await this.connect();
    // In-flight ceiling: past MAX_IN_FLIGHT_PER_SESSION, wait here (FIFO) for
    // a pending request to settle instead of pipelining the burst into
    // ElectrumX's opaque per-session throttle.
    while (this.pending.size >= MAX_IN_FLIGHT_PER_SESSION) {
      await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      await this.connect(); // the socket may have died while we queued
    }
    this.served += 1;
    return this.#send(method, params);
  }

  /** Drop the socket so the next request opens a fresh session. */
  recycle() {
    const sock = this.sock;
    this.sock = null;
    this.ready = null;
    this.served = 0;
    // Partial frames belong to the dying socket (its late 'data'/'close'
    // events are identity-guarded away in connect()) — reset the assembler.
    this.chunks = [];
    this.chunksLength = 0;
    this.scanChunk = 0;
    this.scanOffset = 0;
    // Fail this session's in-flight requests and queued waiters ourselves: the
    // identity guard (correctly) stops the dying socket's 'close' from doing
    // it, and pending entries must not hang until the 15s timeout. Callers see
    // a transport failure, which the pool may retry on a fresh session.
    const err = new Error('electrum session recycled'); err.upstream = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    for (const w of this.waiters) w.reject(err);
    this.waiters = [];
    try { sock?.destroy(); } catch { /* already gone */ }
  }
}

// ---- Session pool ----
// ElectrumX budgets per SESSION: it limits concurrent requests and accrues a
// per-session "cost" that it throttles against (observed: ~1s pauses, a
// 4-chain wallet login crawling to 90s). One shared socket therefore makes
// every wallet on the deployment queue behind a single allowance. A small
// pool spreads load across sessions, and recycling a session after a set
// number of requests resets its accrued cost — so throttling cannot creep
// back the way it did with a single long-lived connection.
class ElectrumPool {
  constructor(target, size = Number(process.env.ELECTRUM_POOL) || 6,
    recycleAfter = Number(process.env.ELECTRUM_RECYCLE_AFTER) || 40,
    maxAdmitted = Number(process.env.MAX_ADMITTED) || 1200) {
    this.clients = Array.from({ length: Math.max(1, size) }, () => new ElectrumClient(target));
    this.recycleAfter = recycleAfter;
    // Requests currently admitted: in flight on a session OR queued on a
    // session's FIFO waiter list. MAX_IN_FLIGHT_PER_SESSION bounds the wire;
    // this bounds the QUEUE, which was unbounded (security F3) — a flood
    // otherwise parked unlimited closures in indexer memory.
    this.maxAdmitted = maxAdmitted;
    this.admitted = 0;
    // Per-client thresholds, NOT one shared number: round-robin keeps served
    // counts in lockstep, so a shared threshold made every session exhaust its
    // budget at once and all 6 reconnected in a thundering herd every ~N
    // requests. A per-client random draw (base + 0..30) spreads recycles out.
    for (const c of this.clients) c.recycleAfter = this.#drawThreshold();
    this.next = 0;
  }

  #drawThreshold() {
    return this.recycleAfter + Math.floor(Math.random() * 31);
  }

  /** Recycle one client and redraw its threshold (see constructor). */
  #recycle(client) {
    client.recycle();
    client.recycleAfter = this.#drawThreshold();
  }

  /** Drop every session — the owning server is going away. Without this a
   * torn-down instance keeps its ElectrumX sessions open (and in tests, the
   * accepted sockets on the fake backend keep the process from exiting). */
  closeAll() {
    for (const c of this.clients) c.recycle();
  }

  async request(method, params = []) {
    // Admission ceiling: refuse cleanly rather than queue without bound. The
    // busy marker maps to a 503 at the HTTP boundary — never the F4 502
    // classifier, because the backend is healthy; WE are shedding load.
    if (this.admitted >= this.maxAdmitted) {
      const e = new Error('index busy — admission ceiling reached');
      e.busy = true;
      throw e;
    }
    this.admitted += 1;
    try {
      const client = this.clients[this.next++ % this.clients.length];
      // Never recycle a session with requests in flight — the destroy would fail
      // them. It stays over budget until a later selection finds it idle.
      if (client.served >= client.recycleAfter && client.pending.size === 0) this.#recycle(client);
      try {
        return await client.request(method, params);
      } catch (err) {
        // RPC-level errors are the server ANSWERING: the session is healthy and
        // a retry would deterministically fail again — propagate immediately
        // (recycling here would also kill unrelated in-flight requests on the
        // session). Only TRANSPORT failures (timeout, closed/broken socket)
        // earn one reconnect + retry: a dead/kicked session must not poison the
        // slot.
        if (err?.electrumRpc) throw err;
        this.#recycle(client);
        return client.request(method, params);
      }
    } finally {
      this.admitted -= 1;
    }
  }
}

// ---- Shared short-TTL cache for verbose tx bodies ----
// The wallet polls every 8s and scanPositions / scanDDUtxos / enrichTx all
// re-fetch the SAME verbose blockchain.transaction.get results each time. Tx
// bodies are immutable, so the only field that can go stale inside the TTL is
// `confirmations` — it may lag by up to one block. That is acceptable here:
// these paths feed classification and prevout DISPLAY, never signing freshness
// (utxos/listunspent stay uncached), so ~15s (≈ one DigiByte block) is safe.
// get_history, listunspent and headers.subscribe are NOT cached — they change
// with chain state.
const TX_CACHE_TTL_MS = 15_000;
// Bounded (FIFO-ish, Map iterates in insertion order) so long uptime can't
// grow the cache unboundedly.
const TX_CACHE_MAX = 500;
const txCache = new Map(); // txid → { at, promise }

/** Verbose tx.get through the shared cache: concurrent callers for the same
 * txid share ONE upstream Electrum call (in-flight dedupe). */
function cachedVerboseTx(withElectrum, txid) {
  const hit = txCache.get(txid);
  if (hit && Date.now() - hit.at < TX_CACHE_TTL_MS) return hit.promise;
  const promise = withElectrum('blockchain.transaction.get', [txid, true]);
  txCache.set(txid, { at: Date.now(), promise });
  if (txCache.size > TX_CACHE_MAX) txCache.delete(txCache.keys().next().value);
  // A failed upstream call must not poison the cache for the whole TTL (the
  // pre-cache behavior was to retry next time): evict it once it settles. The
  // shared promise still dedupes callers while the attempt is in flight.
  promise.catch(() => { if (txCache.get(txid)?.promise === promise) txCache.delete(txid); });
  return promise;
}

// ---- Per-request scan budget (security F3) ----
// One HTTP request may not fan out to unbounded ElectrumX work. THE HARD
// CONSTRAINT: a money field is either COMPLETE or ABSENT — never a short list
// under the name of a full one. The wallet renders an empty `positions` array
// as "No open positions" and rebuilds its redeem source-of-truth from it, so a
// truncated scan that returned `positions: []` would make an old vault VANISH
// from the UI. A budget-exhausted scan therefore throws scanIncomplete, and
// the route boundary answers `{ complete: false, reason }` with the money
// arrays OMITTED ENTIRELY — the client treats that as "unknown, retry",
// never as "empty".
function createScanBudget({ maxUpstream = 4000, maxItems = 5000, deadlineMs = 20_000, signal } = {}) {
  const startedAt = Date.now(); // wall-clock deadline — fine in the server
  let upstream = 0;
  let scanned = 0;
  let trippedReason = null; // once tripped, every later check re-throws the same reason
  const stop = (reason) => {
    trippedReason = trippedReason ?? reason;
    const e = new Error(`scan budget exhausted (${trippedReason})`);
    e.scanIncomplete = true;
    e.reason = trippedReason;
    throw e;
  };
  return {
    note() { // one history/unspent item examined
      if (trippedReason) stop(trippedReason);
      if (++scanned > maxItems) stop('items');
    },
    debit() { // one upstream Electrum call about to happen
      if (trippedReason) stop(trippedReason);
      if (signal?.aborted) stop('client-gone');
      if (Date.now() - startedAt > deadlineMs) stop('deadline');
      if (++upstream > maxUpstream) stop('calls');
    },
  };
}

/** Wrap an upstream caller so every call it makes debits the budget. */
function meteredCaller(withElectrum, budget) {
  return (method, params) => {
    budget.debit();
    return withElectrum(method, params);
  };
}

/** The incomplete-scan response shape. Money keys are ABSENT by construction —
 * the sendJson assertion below is the belt-and-braces insurance that no call
 * site ever ships a partial array under a full field's name. */
const incompleteScan = (address, reason) => ({ ...(address ? { address } : {}), complete: false, reason });

const MONEY_KEYS = ['positions', 'ddUtxos', 'utxos'];
function assertNoMoneyOnIncomplete(body) {
  const check = (o) => {
    if (o && typeof o === 'object' && o.complete === false) {
      for (const k of MONEY_KEYS) {
        if (k in o) throw new Error(`defect: an incomplete scan response must omit '${k}' (complete-or-absent, F3)`);
      }
    }
  };
  check(body);
  // bulk responses nest one entry per address under `results`
  if (body && typeof body === 'object' && body.results && typeof body.results === 'object') {
    for (const entry of Object.values(body.results)) check(entry);
  }
}

// ---- Bulk address reads ----
// A wallet watches many addresses, and asking about each over its own HTTP
// round trip is what made a multi-chain login slow: hundreds of requests, each
// able to catch a stall. One POST covering the whole watch set collapses that.
// FUSED, not just batched: each address does ONE get_history and ONE
// listunspent, and every answer that needs them (utxos, history, positions,
// dd-utxos) is derived from those — the per-endpoint GETs each re-fetch the
// same data. Verbose tx bodies go through the shared cachedVerboseTx.
const BULK_MAX_ADDRESSES = 200;  // a whole wallet's watch set, not an open door
const BULK_CONCURRENCY = 8;      // addresses in flight; the pool spreads further
const BULK_BODY_MAX = 64 * 1024;

async function bulkMapLimited(items, fn, limit = BULK_CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}

async function handleBulkAddresses(req, res, withElectrum, hrp, budgetOpts) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > BULK_BODY_MAX) return sendJson(res, 413, { error: 'request body too large' });
  }
  let parsed;
  try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'malformed JSON' }); }
  const addresses = Array.isArray(parsed.addresses) ? parsed.addresses : [];
  const want = new Set(Array.isArray(parsed.want) && parsed.want.length ? parsed.want : ['utxos', 'history']);
  if (!addresses.length || !addresses.every((a) => typeof a === 'string')) {
    return sendJson(res, 400, { error: 'addresses[] of strings required' });
  }
  if (addresses.length > BULK_MAX_ADDRESSES) {
    return sendJson(res, 400, { error: `at most ${BULK_MAX_ADDRESSES} addresses per request` });
  }
  // ONE budget for the whole request, shared by every address (F3): a
  // 200-address bulk read is 200× the fan-out of a single-address read.
  // Once it trips, the remaining addresses answer incomplete WITHOUT further
  // upstream work — their first metered call re-throws the tripped reason.
  const budget = createScanBudget(budgetOpts);
  const metered = meteredCaller(withElectrum, budget);
  const tip = await metered('blockchain.headers.subscribe', []);
  const entries = await bulkMapLimited(addresses, async (address) => {
    // One bad address fails ITS entry, not the whole request — the caller
    // decides whether a partial answer is usable.
    try {
      const { programHex } = decodeWitnessAddress(address);
      const scripthash = addressToScripthash(address, hrp);
      const out = {};
      const wantsUnspent = want.has('utxos') || want.has('dd-utxos');
      const wantsHistory = want.has('history') || want.has('positions');
      const [unspent, history] = await Promise.all([
        wantsUnspent ? metered('blockchain.scripthash.listunspent', [scripthash]) : null,
        wantsHistory ? metered('blockchain.scripthash.get_history', [scripthash]) : null,
      ]);
      if (want.has('utxos')) {
        out.utxos = unspent.map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, valueSats: String(u.value), height: u.height }));
      }
      if (want.has('dd-utxos')) {
        const dd = await scanDDUtxos(metered, unspent, budget);
        out.ddUtxos = dd;
        out.ddTotalCents = String(dd.reduce((s, u) => s + BigInt(u.cents), 0n));
      }
      if (want.has('history')) {
        out.history = history.map((h) => ({ txid: h.tx_hash, height: h.height }));
      }
      if (want.has('positions')) {
        out.positions = await scanPositions(metered, programHex, history, budget);
      }
      return [address, out];
    } catch (e) {
      // Budget exhausted mid-scan: this address is UNKNOWN, not empty — the
      // money keys stay absent (asserted in sendJson). Never let a partial
      // scan sail out under a full field's name (F3).
      if (e?.scanIncomplete) return [address, incompleteScan(address, e.reason)];
      return [address, { error: String(e.message || e) }];
    }
  });
  return sendJson(res, 200, { tipHeight: tip.height, results: Object.fromEntries(entries) });
}

/** Electrum scripthash: reversed sha256 of the scriptPubKey (segwit v0/v1). */
export function addressToScripthash(address, expectedHrp) {
  const { hrp, version, programHex } = decodeWitnessAddress(address);
  if (hrp !== expectedHrp) throw new RangeError(`address is not for this network (want ${expectedHrp})`);
  const program = Buffer.from(programHex, 'hex');
  const opN = version === 0 ? 0x00 : 0x50 + version;
  const spk = Buffer.concat([Buffer.from([opN, program.length]), program]);
  return createHash('sha256').update(spk).digest().reverse().toString('hex');
}

// ---- DigiDollar positions (#13) ----
// A position = a mint owned by this address whose collateral (vout[0]) is still
// unspent. The address IS the mint's DD-token P2TR (vout[1]), so every mint by
// this owner appears in the address's Electrum history; the OP_RETURN metadata
// (vout[2]) carries amount/tier/unlock, and the collateral scripthash tells us
// whether the position was since redeemed.
async function scanPositions(withElectrum, programHex, history, budget) {
  const positions = [];
  for (const h of history) {
    budget?.note(); // one history entry examined (F3)
    const tx = await cachedVerboseTx(withElectrum, h.tx_hash);
    if (parseDDVersion(tx.version).type !== 'mint') continue;
    const opReturn = tx.vout.find((o) => o.scriptPubKey.hex.startsWith('6a'));
    if (!opReturn) continue;
    let meta;
    try {
      meta = parseMintMetadata(opReturn.scriptPubKey.hex);
    } catch {
      continue; // DD-marked but not a well-formed mint — not a position
    }
    if (ddTokenOutputKey(meta.ownerKeyHex) !== programHex) continue; // someone else's mint
    const collateral = tx.vout[0];
    const collateralUnspent = (await withElectrum('blockchain.scripthash.listunspent', [
      scriptPubKeyToScripthash(collateral.scriptPubKey.hex),
    ])).some((u) => u.tx_hash === tx.txid && u.tx_pos === 0);
    if (!collateralUnspent) continue; // redeemed (or otherwise closed)
    const tier = LOCK_TIERS[meta.lockTier];
    positions.push({
      txid: tx.txid,
      height: h.height,
      ddCents: String(meta.ddCents),
      tierId: tier?.id ?? null,
      tierLabel: tier?.label ?? `tier ${meta.lockTier}`,
      unlockHeight: meta.unlockHeight,
      collateralSats: String(BigInt(Math.round(collateral.value * 1e8))),
    });
  }
  return positions;
}

// ---- DigiDollar spendable balance (#15) ----
// DD amounts are not on the UTXO itself (zero value): the creating tx's
// OP_RETURN lists cents which consensus pairs POSITIONALLY with the tx's
// zero-value canonical P2TR outputs, in output order (mint: [ddCents],
// transfer: amountsCents, redeem: [ddChangeCents]).
function ddAmountsByVout(tx) {
  const type = parseDDVersion(tx.version).type;
  if (!type) return null;
  const opReturn = tx.vout.find((o) => o.scriptPubKey.hex.startsWith('6a'));
  let amounts;
  try {
    if (type === 'mint') amounts = [parseMintMetadata(opReturn.scriptPubKey.hex).ddCents];
    else if (type === 'transfer') amounts = parseTransferMetadata(opReturn.scriptPubKey.hex).amountsCents;
    else if (type === 'redeem') amounts = opReturn ? [parseRedeemMetadata(opReturn.scriptPubKey.hex).ddChangeCents] : [];
    else return null;
  } catch {
    return null; // DD-marked but malformed — carries no DD value
  }
  const ddVouts = tx.vout.filter((o) => o.value === 0 && o.scriptPubKey.hex.startsWith('5120'));
  return new Map(ddVouts.map((o, i) => [o.n, amounts[i]]).filter(([, cents]) => cents !== undefined));
}

/** Resolve the address's zero-value UTXOs to DD cents via their creating txs. */
async function scanDDUtxos(withElectrum, unspent, budget) {
  const out = [];
  // Per-call memo of parsed DD amounts (the module-level tx cache dedupes the
  // FETCH; this just avoids re-parsing within one call).
  const ddMaps = new Map();
  for (const u of unspent.filter((x) => x.value === 0)) {
    budget?.note(); // one unspent item examined (F3)
    if (!ddMaps.has(u.tx_hash)) {
      ddMaps.set(u.tx_hash, ddAmountsByVout(await cachedVerboseTx(withElectrum, u.tx_hash)));
    }
    const cents = ddMaps.get(u.tx_hash)?.get(u.tx_pos);
    if (cents === undefined) continue; // zero-value but not a DD token output
    out.push({ txid: u.tx_hash, vout: u.tx_pos, cents: String(cents), height: u.height });
  }
  return out;
}

function scriptPubKeyToScripthash(spkHex) {
  return createHash('sha256').update(Buffer.from(spkHex, 'hex')).digest().reverse().toString('hex');
}

// ---- Per-tx enrichment (#69) ----
// The wallet's history was thin because the façade returned {txid, height}
// only. This resolves ONE tx into the facts a real history view needs — signed
// direction, fee, timestamp, confirmations, DD classification — while staying
// address-agnostic: the caller already knows the txid (a public fact), and
// which of the resolved in/out addresses are "theirs" is decided wallet-side,
// where the full watched-address set lives. So no xpub or address set leaks here.
function spkAddress(spk) {
  return spk?.address ?? (Array.isArray(spk?.addresses) ? spk.addresses[0] : null) ?? null;
}
// Core reports values as float DGB; sats is the integer we settle in.
const valueToSats = (v) => BigInt(Math.round(v * 1e8));

async function enrichTx(withElectrum, txid) {
  const tx = await cachedVerboseTx(withElectrum, txid);
  const type = parseDDVersion(tx.version).type || 'dgb';
  const ddMap = ddAmountsByVout(tx); // vout.n → DD cents (null for a plain DGB tx)
  const vout = tx.vout.map((o) => ({
    n: o.n,
    address: spkAddress(o.scriptPubKey),
    valueSats: String(valueToSats(o.value)),
    ddCents: ddMap?.has(o.n) ? String(ddMap.get(o.n)) : null,
  }));
  // Resolve each input to its funding address + value by fetching the prevout
  // tx. Needed for the fee (Σin − Σout) and the received-from counterpart.
  // Coinbase inputs have no prevout, so the fee is not computable there. Cap the
  // per-tx prevout fan-out (a consolidation can have thousands of inputs, and
  // one history row must not trigger thousands of Electrum calls, #55): resolve
  // the first MAX (enough to name a counterpart), leave the fee null past that.
  const MAX_VIN_RESOLVE = 40;
  const prevCache = new Map();
  let inputsResolved = true;
  const vin = [];
  for (let idx = 0; idx < tx.vin.length; idx++) {
    const i = tx.vin[idx];
    if (i.coinbase !== undefined || idx >= MAX_VIN_RESOLVE) { vin.push({ address: null, valueSats: null }); inputsResolved = false; continue; }
    if (!prevCache.has(i.txid)) prevCache.set(i.txid, await cachedVerboseTx(withElectrum, i.txid));
    const po = prevCache.get(i.txid)?.vout?.[i.vout];
    if (!po) { vin.push({ address: null, valueSats: null }); inputsResolved = false; continue; }
    vin.push({ address: spkAddress(po.scriptPubKey), valueSats: String(valueToSats(po.value)) });
  }
  let feeSats = null;
  if (inputsResolved) {
    const fee = vin.reduce((s, v) => s + BigInt(v.valueSats), 0n) - vout.reduce((s, v) => s + BigInt(v.valueSats), 0n);
    if (fee >= 0n) feeSats = String(fee);
  }
  return {
    txid: tx.txid,
    confirmations: Number.isFinite(tx.confirmations) ? tx.confirmations : 0,
    time: tx.blocktime ?? tx.time ?? null,
    type,
    feeSats,
    vin,
    vout,
  };
}

function sendJson(res, status, body) {
  // Complete-or-absent insurance (F3): an incomplete scan response carrying a
  // money array is a defect in OUR scan code — throw here so one assertion
  // guards every call site, instead of trusting each to remember the rule.
  assertNoMoneyOnIncomplete(body);
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

export function startServer(overrides = {}) {
  const env = configFromEnv();
  const config = { ...env, ...overrides, electrum: { ...env.electrum, ...(overrides.electrum || {}) } };
  // A POOL, not one socket: ElectrumX throttles per session, so a single
  // connection made every wallet queue behind one allowance (see ElectrumPool).
  // server.version happens inside connect() — once per CONNECTION, so a
  // dropped TCP session re-handshakes transparently on the next request (#32)
  const electrum = new ElectrumPool(config.electrum, config.electrumPool, config.electrumRecycleAfter, config.maxAdmitted);
  const withElectrum = (method, params) => electrum.request(method, params);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/addresses') {
        return await handleBulkAddresses(req, res, withElectrum, config.hrp, config.scanBudget);
      }
      const match = req.url.match(/^\/api\/address\/([a-z0-9]+)\/(utxos|history|positions|dd-utxos)$/);
      if (req.method === 'GET' && match) {
        const [, address, what] = match;
        let scripthash, programHex;
        try {
          ({ programHex } = decodeWitnessAddress(address));
          scripthash = addressToScripthash(address, config.hrp);
        } catch (e) {
          return sendJson(res, 400, { error: `invalid address: ${e.message}` });
        }
        if (what === 'dd-utxos') {
          // Fan-out route (one verbose fetch per zero-value utxo) — budgeted (F3).
          const budget = createScanBudget(config.scanBudget);
          const metered = meteredCaller(withElectrum, budget);
          try {
            const unspent = await metered('blockchain.scripthash.listunspent', [scripthash]);
            const utxos = await scanDDUtxos(metered, unspent, budget);
            const totalCents = utxos.reduce((s, u) => s + BigInt(u.cents), 0n);
            return sendJson(res, 200, { address, totalCents: String(totalCents), utxos });
          } catch (e) {
            if (e?.scanIncomplete) return sendJson(res, 200, incompleteScan(address, e.reason));
            throw e;
          }
        }
        if (what === 'positions') {
          // Fan-out route (one verbose fetch + listunspent per history entry) —
          // budgeted (F3). Budget hit → unknown, NEVER an empty positions list.
          const budget = createScanBudget(config.scanBudget);
          const metered = meteredCaller(withElectrum, budget);
          try {
            const history = await metered('blockchain.scripthash.get_history', [scripthash]);
            const [positions, tip] = await Promise.all([
              scanPositions(metered, programHex, history, budget),
              metered('blockchain.headers.subscribe', []),
            ]);
            return sendJson(res, 200, { address, tipHeight: tip.height, positions });
          } catch (e) {
            if (e?.scanIncomplete) return sendJson(res, 200, incompleteScan(address, e.reason));
            throw e;
          }
        }
        if (what === 'utxos') {
          const unspent = await withElectrum('blockchain.scripthash.listunspent', [scripthash]);
          return sendJson(res, 200, {
            address,
            utxos: unspent.map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, valueSats: String(u.value), height: u.height })),
          });
        }
        const history = await withElectrum('blockchain.scripthash.get_history', [scripthash]);
        return sendJson(res, 200, {
          address,
          history: history.map((h) => ({ txid: h.tx_hash, height: h.height })),
        });
      }
      const txMatch = req.url.match(/^\/api\/tx\/([0-9a-f]{64})$/);
      if (req.method === 'GET' && txMatch) {
        // An unknown txid makes ElectrumX answer an RPC error whose message is
        // its Python DaemonError repr — a backend fingerprint (security F4).
        // Scoped here so only this route maps an upstream RPC error to 404.
        const budget = createScanBudget(config.scanBudget); // enrichTx fans out per vin
        try {
          return sendJson(res, 200, await enrichTx(meteredCaller(withElectrum, budget), txMatch[1]));
        } catch (err) {
          if (err?.scanIncomplete) return sendJson(res, 200, incompleteScan(null, err.reason));
          if (err?.electrumRpc) { console.error('indexer: tx lookup rpc error:', err.message); return sendJson(res, 404, { error: 'not found' }); }
          throw err; // transport/internal → the classifier below
        }
      }
      if (req.method === 'GET' && req.url === '/api/health') {
        const tip = await withElectrum('blockchain.headers.subscribe', []);
        return sendJson(res, 200, { height: tip.height });
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      // Never leak an upstream error string to the client (security F4): it
      // names the backend, its port, and its error grammar. Log the real thing
      // (the most useful line for us), answer a generic classification.
      console.error('indexer:', err);
      if (err?.busy) {
        // OUR admission ceiling shed load (F3): the backend is healthy, so
        // this is a 503-retry — never the 502 "backend unavailable" classifier.
        return sendJson(res, 503, { error: 'index busy — retry' });
      }
      if (err?.upstream) {
        // the ElectrumX layer answered-with-error or the socket failed —
        // either way it is a backend problem, not the caller's
        return sendJson(res, 502, { error: 'the index backend is unavailable' });
      }
      // an untagged throw is an internal defect in our own scan code
      sendJson(res, 500, { error: 'internal error' });
    }
  });

  // pooled upstream sockets are owned by this server: closing it must close
  // them, or a torn-down instance keeps its ElectrumX sessions (and, in tests,
  // the whole process) alive
  server.on('close', () => electrum.closeAll());
  server.listen(config.port, config.bindHost || '127.0.0.1', () => {
    console.log(`  DigiDollar indexer façade → http://localhost:${server.address().port} (bind ${config.bindHost || '127.0.0.1'}, electrum ${config.electrum.host}:${config.electrum.port}, hrp ${config.hrp})`);
  });
  return server;
}

// Test seam (apps/indexer/test): the frame parser, pool recycle/retry
// semantics and the tx cache are unit-tested directly against fake ElectrumX
// sockets. `txCacheForTests` lets tests age entries instead of sleeping 15s.
const txCacheForTests = { map: txCache, TTL_MS: TX_CACHE_TTL_MS };
export { ElectrumClient, ElectrumPool, cachedVerboseTx, txCacheForTests, createScanBudget, assertNoMoneyOnIncomplete };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
