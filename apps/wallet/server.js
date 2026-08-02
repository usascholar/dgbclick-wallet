// DigiDollar wallet app — zero-dependency server.
// Serves the static frontend and proxies JSON-RPC to a DigiByte Core node.
// Falls back to MOCK mode (realistic fake data) when no RPC creds are set,
// so the UI is usable before you have a testnet node running.

import { createServer } from 'node:http';
import { readFile, writeFile, stat, mkdir, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { verifyVendorTree, describeVendorFailure } from './vendor-integrity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

// ---- Build version ----
// Semver from package.json + the commit stamp. The stamp file carries a git
// export-subst placeholder that `git archive` expands at deploy time (the
// prod server has no .git); from a working tree it falls back to asking git,
// and failing that reports "dev". Shown in the UI footer and /api/config so
// each domain of a dual-network deployment names the exact build it runs.
function resolveVersion() {
  const semver = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;
  let stamp = '';
  try {
    stamp = readFileSync(join(__dirname, '.version-stamp'), 'utf8').trim();
  } catch { /* file missing: fall through to git */ }
  if (!stamp || stamp.startsWith('$Format')) {
    try {
      stamp = execSync('git log -1 --format="%h %cs"', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().replace(/"/g, '');
    } catch {
      stamp = 'dev';
    }
  }
  return `v${semver}+${stamp.replace(' ', ' · ')}`;
}
const APP_VERSION = resolveVersion();
// The pure-protocol library, served to the browser as /lib/ (ADR-0004: the
// wallet is the lib's first consumer — same code runs in Node and browser).
// Resolved via Node's module resolution — works wherever npm hoists the package.
const LIB_DIR = dirname(fileURLToPath(import.meta.resolve('digidollar-js')));
// Crypto deps of the lib, served under /vendor/ so the browser import map can
// resolve the lib's bare specifiers (@noble/*, @scure/*) to real URLs.
const VENDOR_PACKAGES = ['@noble/curves', '@noble/hashes', '@scure/base', '@scure/bip32', '@scure/bip39', 'qrcode-generator'];
export const VENDOR_ROOTS = Object.fromEntries(
  VENDOR_PACKAGES.map((pkg) => [pkg, dirname(fileURLToPath(import.meta.resolve(pkg)))]),
);

// Everything the browser EXECUTES, hashed at boot — not just /vendor.
//
// The lock originally covered only the vendored crypto deps, while /lib
// (digidollar-js: generateMnemonic, BIP32/BIP86 derivation, every signing
// helper) shipped unverified. That inverted the threat model: an attacker who
// can write to the served tree had no need to touch @noble at all — editing
// /lib/hd.js weakens key generation directly and the lock never notices. The
// RNG health gate lives in that same tree, so leaving it unhashed would let
// the gate itself be stripped silently. Both seams are verified together now.
export const INTEGRITY_ROOTS = { ...VENDOR_ROOTS, 'digidollar-js': LIB_DIR };

// Fail closed if the /vendor tree is not byte-for-byte what vendor.lock records.
// Pinned versions (#114) say what npm should install; this says what is actually
// on disk at boot. Regenerate deliberately with `npm run vendor:lock`.
function verifyVendorIntegrity() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(__dirname, 'vendor.lock'), 'utf8'));
  } catch (err) {
    throw new Error(`vendor.lock is missing or unreadable (${err.message}) — run: npm run vendor:lock`);
  }
  const result = verifyVendorTree(INTEGRITY_ROOTS, lock);
  if (!result.ok) {
    throw new Error(
      'REFUSING TO START: the served code tree (/vendor + /lib) does not match vendor.lock.\n' +
      describeVendorFailure(result) +
      '\n  If this change is intentional, re-run: npm run vendor:lock',
    );
  }
  return Object.keys(lock).length;
}

// ---- Security headers (#55) ----
// A key-holding wallet locks its origin down. The CSP allows scripts only from
// same origin plus a hash for index.html's inline importmap (browsers block an
// inline <script type="importmap"> under a bare script-src 'self'). Crucially it
// carries NO 'unsafe-inline' for scripts and no 'unsafe-hashes', so an injected
// inline event handler (e.g. onerror= from a malicious node/indexer/oracle JSON)
// cannot execute even if an innerHTML sink is ever missed — defence in depth
// behind the per-sink escaping in app.js. Derived from the real index.html so it
// can never silently drift out of sync (a changed importmap fails loudly here).
function importmapCspHash() {
  const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html: inline importmap not found — cannot build a script-src CSP');
  // Hash the newline-NORMALIZED text: the HTML parser folds \r\n / \r to \n
  // before CSP hashes inline script content, so a CRLF checkout (Windows git
  // autocrlf) would otherwise produce a hash the browser can never match —
  // silently blocking the importmap and every module behind it.
  return `'sha256-${createHash('sha256').update(m[1].replace(/\r\n?/g, '\n')).digest('base64')}'`;
}
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${importmapCspHash()}`,
  "style-src 'self' 'unsafe-inline'", // index.html <style> + inline style="" on generated nodes
  "img-src 'self' data:",
  "media-src 'self'",                 // the loading.mp4 clip
  // /api/* is same-origin; https://api.github.com is the FR-8 backup backend —
  // the ONLY third-party origin the page may contact, by design: it receives
  // the user's fine-grained token and already-encrypted keystore bytes, never
  // plaintext key material (see ghbackup.js)
  "connect-src 'self' https://api.github.com",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",           // the wallet is never legitimately framed (clickjacking)
  "form-action 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',   // never leak the wallet URL/path to an explorer or upstream
};

export function configFromEnv() {
  return {
    port: Number(process.env.PORT) || 8787,
    rpc: {
      // Point at your node's RPC (from digibyte.conf: rpcport). Set user/pass to leave mock mode.
      url: process.env.DGB_RPC_URL || 'http://127.0.0.1:14022',
      user: process.env.DGB_RPC_USER || '',
      pass: process.env.DGB_RPC_PASS || '',
    },
    // Faucet service base URL; unset = no faucet button in the UI.
    faucetUrl: process.env.FAUCET_URL || '',
    // Indexer façade base URL (apps/indexer); unset = no balance/history in the UI.
    indexerUrl: process.env.INDEXER_URL || '',
    // Where the price sampler persists its series; unset = memory only.
    priceHistory: { dataFile: process.env.PRICE_HISTORY_FILE || '' },
    // Block-explorer tx URL prefix (e.g. https://…/tx/); unset = plain txids.
    explorerTxUrl: process.env.EXPLORER_TX_URL || '',
    // Cross-wire guard (#64): the chain this deployment MUST be backed by
    // ('main' | 'test' | 'regtest'). When set and the node reports a different
    // chain, the server refuses to proxy RPC — a mainnet wallet silently
    // serving testnet data (or vice versa) is the one misconfiguration a
    // dual-network host cannot afford. Unset = no guard (single-net setups).
    expectedChain: process.env.EXPECTED_CHAIN || '',
    // Request-hardening defaults. Body caps: /api/rpc gets 1 MiB because
    // consolidation transactions spending many inputs can legitimately run a
    // few hundred KB of hex; a faucet claim is just an address, so 16 KiB is
    // generous. Rate limits: per-IP fixed-window allowances on the
    // upstream-touching endpoints. The indexer ceiling is deliberately high —
    // the wallet IS the dominant legitimate consumer: every 8s money poll
    // costs ~(receiveIndex+3) × 6 address reads (two forms × utxos/history,
    // plus positions/dd-utxos) and a receive-chain rescan bursts ~100 more,
    // so a restored wallet at index ~20 sustains >1000/min, doubled for a
    // second tab. 6000/min still stops an abuse flood without ever tripping
    // real use (600/min did — it self-DoS'd restored wallets for a window).
    // Both overridable via startServer({ rateLimits, bodyLimits }) so tests
    // can use tiny values.
    // Directory/vote buckets: directory reads cost no upstream work but the
    // merge with the vote store is per-request, so they get a generous bucket;
    // votes are the one write endpoint anyone can hit, so theirs is tight.
    rateLimits: { windowMs: 60_000, rpcMax: 120, indexerMax: 6000, faucetMax: 20, directoryMax: 600, voteMax: 30 },
    bodyLimits: { rpcBytes: 1_048_576, faucetBytes: 16_384, voteBytes: 4096 },
    // ---- Client-address trust model (security F1) ----
    // Every per-IP control keys on clientAddress(). Whoever controls that value
    // controls those limits, so the trust model is explicit, never inferred.
    // trustProxy: which SOCKET PEER may name the client in a header.
    //   'loopback' (default) — the reference deploys terminate TLS in nginx on
    //   the same host and proxy_pass to 127.0.0.1; nothing on the internet can
    //   reach us with a loopback peer. A no-proxy self-hoster needs no config:
    //   a real visitor's peer is never loopback, so their header is ignored.
    //   'off' = socket peer only (ignore headers). A CIDR/IP names a proxy on
    //   a container network (e.g. TRUST_PROXY=172.16.0.0/12).
    // trustProxyHops: how many APPENDING proxies sit in front (default 1).
    //   nginx's $proxy_add_x_forwarded_for appends the real peer at the END, so
    //   the client sits `hops` from the right. Reading [0] read the attacker's
    //   value — the F1 bug. A chain shorter than hops falls back to the peer.
    trustProxy: process.env.TRUST_PROXY || 'loopback',
    trustProxyHops: Math.max(1, Number(process.env.TRUST_PROXY_HOPS) || 1),
    // X-Real-IP instead of X-Forwarded-For (nginx OVERWRITES it, so no hop
    // math). NOT the default: proxies that don't set it (Caddy, ALB) pass a
    // client-sent value straight through, reintroducing F1 on those deploys.
    trustProxyHeader: (process.env.TRUST_PROXY_HEADER || 'x-forwarded-for').toLowerCase(),
    // Bind address (security F7). Default LOOPBACK: every production path
    // reaches these over loopback (nginx on the box) or a container network, so
    // "not on a public interface" is the safe default. Containers opt back in
    // with BIND_HOST=0.0.0.0, where the network namespace is the isolation.
    bindHost: process.env.BIND_HOST || '127.0.0.1',
    // ---- "Spend DD" merchant directory ----
    // Update-without-coding: the merchant list lives in a public JSON file
    // (e.g. raw.githubusercontent.com) that the operator edits in a repo — no app
    // redeploy to add a merchant. Unset = serve the bundled seed. The fetch
    // is server-side, so the browser CSP never needs a new origin.
    directoryUrl: process.env.DIRECTORY_URL || '',
    // How long a fetched list stays fresh before the next GET refetches.
    directoryCacheMs: Number(process.env.DIRECTORY_CACHE_MS) || 600_000,
    // Where merchants apply to be listed; surfaced to the client as listUrl.
    directoryListUrl: process.env.DIRECTORY_LIST_URL || 'https://dgbclick.com',
    // ALL writable state lives here. Production deploys wipe and re-extract
    // the app directory (~/diginaut-beta), so nothing may persist beside
    // server.js — votes and the last-good directory snapshot would be lost.
    dataDir: process.env.DIGINAUT_DATA_DIR || join(homedir(), 'diginaut-data'),
  };
}

// Forward address-level reads to the indexer façade (#5: all balance/history
// queries go through the indexer seam — never node RPC).
async function handleIndexer(req, res, { indexerUrl, guard, bodyLimit, preReadBody }) {
  // same fail-closed rule as /api/rpc: a cross-wired deployment serves nothing
  if (guard?.blocked()) return sendJson(res, 503, { error: guard.describe() });
  if (!indexerUrl) return sendJson(res, 503, { error: 'no indexer configured' });
  const rel = req.url.slice('/api/indexer'.length);
  // /addresses is the BULK read (POST): one request for a whole watch set,
  // instead of one round trip per address. Everything else stays a GET.
  const isBulk = req.method === 'POST' && rel === '/addresses';
  if (!isBulk && !/^\/(address\/[a-z0-9]+\/(utxos|history|positions|dd-utxos)|tx\/[0-9a-f]{64})$/.test(rel)) {
    return sendJson(res, 404, { error: 'unknown indexer path' });
  }
  let payload = null;
  if (isBulk) {
    // The route may have already read the body to weigh the rate limiter by
    // address count (F3) — never read the stream twice.
    if (preReadBody !== undefined) {
      payload = preReadBody;
    } else {
      try {
        payload = await readBody(req, bodyLimit ?? 64 * 1024);
      } catch (err) {
        return sendJson(res, err.statusCode === 413 ? 413 : 400, { error: 'request body too large' });
      }
    }
  }
  try {
    // INDEXER_URL is normally an apps/indexer façade root (paths live under
    // /api). It may instead point at a peer wallet's public /api/indexer
    // surface — same path shape, /api already in the base — so don't double it.
    const base = indexerUrl.replace(/\/$/, '');
    const upstream = await fetch(`${base}${base.endsWith('/api/indexer') ? '' : '/api'}${rel}`, {
      ...(isBulk && { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  } catch (err) {
    sendJson(res, 502, { error: `indexer unreachable: ${String(err.message || err)}` });
  }
}

// Forward a claim to the Faucet service (same-origin for the browser; the
// faucet's own rate limiting sees the real client IP via x-forwarded-for).
async function handleFaucetClaim(req, res, { faucetUrl, guard, bodyLimit }) {
  if (guard?.blocked()) return sendJson(res, 503, { error: guard.describe() });
  // read (and cap) the body BEFORE the faucet-configured check so an
  // oversized POST is a 413 regardless of deployment config
  const raw = await readBody(req, bodyLimit);
  if (!faucetUrl) return sendJson(res, 503, { error: 'no faucet configured' });
  try {
    const upstream = await fetch(faucetUrl + '/api/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': clientAddress(req) },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  } catch (err) {
    sendJson(res, 502, { error: `faucet unreachable: ${String(err.message || err)}` });
  }
}

// Only these RPC methods are reachable from the browser. Keeps the proxy from
// exposing wallet-draining calls by accident. Extend deliberately.
const ALLOWED_METHODS = new Set([
  'getblockchaininfo',
  'getdeploymentinfo',
  // Real v9.26.4 names (docs/discovery/regtest-oracle-findings.md) — the
  // spec-discussion names (getoraclestatus, listoracles, …) don't exist.
  'getoracleprice',
  'getoracles',
  // Broadcast of CLIENT-SIGNED transactions (issue #6). The node only relays;
  // it cannot spend anything the browser didn't already sign.
  'sendrawtransaction',
  // Honest quotes (#62): both read-only. The DCA multiplier scales required
  // collateral with network health — quoting without it under-quotes on a
  // degraded system. Protection status carries the volatility-freeze flags the
  // mint flow checks BEFORE asking the user to sign.
  'getdcamultiplier',
  'getprotectionstatus',
  // mintdigidollar / redeemdigidollar / senddigidollar intentionally NOT
  // exposed — fund-moving flows arrive client-signed via M2/M3 (ADR-0001).
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
};

// ---- Mock data: shaped like the real RPC responses so the UI logic is identical.
// Oracle numbers mirror Core v9.26.4 consensus params: 35 oracle slots, threshold 7.
function mockResponse(method, params) {
  switch (method) {
    case 'getblockchaininfo':
      return { chain: 'test', blocks: 1_284_512, headers: 1_284_512, verificationprogress: 0.9999, initialblockdownload: false };
    case 'getdeploymentinfo':
      return {
        deployments: {
          digidollar: {
            type: 'bip9',
            bip9: { status: 'active', bit: 5, start_time: 1746057600, timeout: 1809129600, since: 1_240_000 },
            active: true,
          },
          taproot: { type: 'bip9', bip9: { status: 'active' }, active: true },
        },
      };
    case 'getoracleprice':
      return {
        price_micro_usd: 13_420, price_cents: 1, price_usd: 0.01342,
        last_update_height: 1_284_510, validity_blocks: 20, is_stale: false,
        oracle_count: 35, status: 'ok',
      };
    case 'getoracles':
      return Array.from({ length: 35 }, (_, i) => ({
        oracle_id: i,
        name: `oracle-${i}`,
        pubkey: `03${String(i).padStart(64, '0')}`,
        is_active: true,
        in_consensus: i % 5 !== 4,
        active_oracle_count: 35,
        total_oracle_slots: 35,
        consensus_threshold: 7,
      }));
    case 'getdcamultiplier': {
      // Mirrors Core dca.cpp HEALTH_TIERS exactly, including the real RPC's
      // optional system_health param (lets tests exercise degraded tiers).
      const health = Number.isFinite(Number(params?.[0])) && params?.[0] !== undefined
        ? Math.min(30_000, Math.max(0, Number(params[0])))
        // healthy by default; MOCK_SYSTEM_HEALTH lets drivers demo degraded tiers
        : Number(process.env.MOCK_SYSTEM_HEALTH) || 200;
      const tier = health >= 150 ? { multiplier: 1.0, tier_status: 'healthy' }
        : health >= 120 ? { multiplier: 1.25, tier_status: 'warning' }
        : health >= 110 ? { multiplier: 1.5, tier_status: 'critical' }
        : { multiplier: 2.0, tier_status: 'emergency' };
      return {
        ...tier,
        system_health: health,
        description: tier.multiplier === 1.0
          ? 'No additional collateral required (healthy system)'
          : `${tier.multiplier.toFixed(1)}x base collateral required (${tier.tier_status} system)`,
      };
    }
    case 'getprotectionstatus':
      return {
        oracle: { available: true, status: 'available', minting_restricted: false, minting_restricted_reason: '' },
        dca: { active: false, current_multiplier: 1.0, tier: 'healthy', system_health: 200, trend: 'stable' },
        err: { active: false, threshold: 100, current_ratio: 200, err_ratio_bps: 10_000, required_burn_per_10000: 10_000, status: 'normal', evaluation_status: 'priced' },
        volatility: { protection_active: false, current_volatility: 2.1, protection_threshold: 20, minting_restricted: false },
        overall: { status: 'secure', active_protections: [], warnings: [] },
      };
    case 'sendrawtransaction': {
      // Fake txid: sha256 would be overkill for a mock — a stable-looking hash
      // derived from the hex keeps the UI flow exercisable offline.
      const hex = String(params?.[0] ?? '');
      let h = 0;
      for (const c of hex) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return h.toString(16).padStart(8, '0').repeat(8);
    }
    default:
      throw new Error(`No mock for method: ${method}`);
  }
}

// ---- Price history for the chart. Mock mode: a synthetic 24h random walk
// around the mock oracle price, regenerated per request (nothing to persist).
function syntheticPriceSeries(nowSec = Math.floor(Date.now() / 1000)) {
  const points = [];
  const stepSec = 300; // 5-minute candles, 24h back
  let price = 13_420;
  for (let t = nowSec - 24 * 3600; t <= nowSec; t += stepSec) {
    // gentle deterministic wave + hash-noise: plausible, stable within a step
    const wave = Math.sin(t / 7200) * 180;
    const noise = ((t * 2654435761) % 97) - 48;
    points.push({ t, price_micro_usd: Math.round(price + wave + noise) });
  }
  return points;
}

// Real mode: poll the node's oracle price on an interval into an in-memory
// series the chart endpoint serves. Persisted to a JSON file so history
// survives restarts. Stops with the server.
function startPriceSampler({ rpc, intervalMs = 60_000, dataFile = '', windowSec = 24 * 3600, guard = null }, server) {
  let series = [];
  const cutoff = () => Math.floor(Date.now() / 1000) - windowSec;
  if (dataFile) {
    try {
      const loaded = JSON.parse(readFileSync(dataFile, 'utf8'));
      if (Array.isArray(loaded)) series = loaded.filter((p) => p && p.t > cutoff() && p.price_micro_usd > 0);
    } catch {
      // no file yet / corrupt: start fresh
    }
  }
  async function sample() {
    // re-confirm the chain in the same cycle that records the price: a
    // backend swap between guard probes must not leak even one wrong-chain
    // point into this network's history file
    if (guard) {
      await guard.probeNow();
      if (guard.blocksSampling()) return;
    }
    try {
      const { price_micro_usd } = await callNode(rpc, 'getoracleprice', []);
      if (price_micro_usd > 0) series.push({ t: Math.floor(Date.now() / 1000), price_micro_usd });
    } catch {
      return; // node down / oracle stale: skip the point, keep sampling
    }
    while (series.length && series[0].t <= cutoff()) series.shift();
    if (dataFile) {
      try {
        await writeFile(dataFile, JSON.stringify(series));
      } catch {
        // read-only disk: chart still works from memory
      }
    }
  }
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  server.on('close', () => clearInterval(timer));
  return series;
}

// Cross-wire guard (#64). A guarded deployment (EXPECTED_CHAIN set) is
// FAIL-CLOSED: proxying is refused until the node's chain has been confirmed
// once, and refused permanently while it reports the wrong chain. Probes at
// boot, then every 5s until first confirmation, then every intervalMs — so a
// backend swap behind the same URL is caught without a restart. handleRpc
// also feeds it every getblockchaininfo it proxies.
function startChainGuard({ rpc, expectedChain, intervalMs = 60_000 }, server) {
  const guard = {
    expected: expectedChain,
    actual: null,
    seen(chain) { guard.actual = chain; },
    mismatch: () => Boolean(guard.expected && guard.actual && guard.actual !== guard.expected),
    // unconfirmed ≠ cross-wired: the node may just be down/starting, so the
    // refusal message differs — but a guarded deployment still refuses
    unconfirmed: () => Boolean(guard.expected && !guard.actual),
    blocked: () => guard.mismatch() || guard.unconfirmed(),
    blocksSampling: () => Boolean(guard.expected && (guard.mismatch() || !guard.actual)),
    describe: () => guard.unconfirmed()
      ? `refusing to serve: this deployment expects chain "${guard.expected}" but the node has not yet confirmed its chain (down or starting) — retrying`
      : `refusing to serve: this deployment expects chain "${guard.expected}" but the node reports "${guard.actual}" — cross-wired backend (check DGB_RPC_URL / EXPECTED_CHAIN)`,
    async probeNow() {
      try {
        const { chain } = await callNode(rpc, 'getblockchaininfo', []);
        if (chain) {
          const chainChanged = guard.actual !== chain;
          guard.seen(chain);
          if (guard.mismatch() && chainChanged) console.error(`  CHAIN GUARD: ${guard.describe()}`);
        }
      } catch {
        // node down: keep the last known answer; the RPC proxy reports outages
      }
    },
  };
  let timer;
  async function loop() {
    await guard.probeNow();
    timer = setTimeout(loop, guard.actual ? intervalMs : 5_000);
    timer.unref?.();
  }
  loop();
  server.on('close', () => clearTimeout(timer));
  return guard;
}

async function callNode(rpc, method, params) {
  const auth = Buffer.from(`${rpc.user}:${rpc.pass}`).toString('base64');
  const res = await fetch(rpc.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'ddui', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Node returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

// ---- Request body cap ----
// An unbounded `for await` accumulation lets any client grow server memory
// without limit with a giant POST. This rejects the moment the byte count
// crosses the limit, then DRAINS the rest of the body without buffering it —
// draining (rather than destroying the socket) keeps the connection coherent
// so the 413 response can actually reach the client. The rejection carries a
// .statusCode the request handler translates into a real HTTP 413.
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        settled = true;
        const err = new Error(`request body exceeds ${limitBytes} bytes`);
        err.statusCode = 413;
        req.removeAllListeners('data');
        req.resume(); // discard the remainder; buffer nothing more
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); }
    });
    req.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
  });
}

// ---- Per-IP fixed-window rate limiting ----
// The proxied endpoints cost upstream work (node RPC, indexer, faucet), so a
// single chatty or hostile source address gets a fixed allowance per window;
// past it, the server answers 429 + retry-after instead of spending upstream
// capacity. Buckets are per endpoint class — the wallet's indexer polling
// must not burn its RPC allowance.
//
// Memory bound (security F1 follow-on): the old sweep deleted only EXPIRED
// entries, so within one window nothing expired and a flood of distinct keys
// grew the map without limit. Now keys are validated to real IPs by
// clientAddress (bounded cardinality) AND the map hard-caps: once past
// MAX_BUCKETS we sweep the expired, and if still full we refuse NEW keys by
// treating them as limited (an unknown flooder is told to slow down rather
// than being allowed to grow the map). Active entries are two numbers each.
const MAX_BUCKETS = 20_000;
function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  return {
    // cost: how many tokens this request spends. Almost always 1 — the bulk
    // indexer read debits by its ADDRESS COUNT (F3), so a 200-address call
    // can't hide 200 reads inside one token.
    check(key, cost = 1) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || now >= entry.resetAt) {
        if (hits.size >= MAX_BUCKETS) {
          for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
          // still full of LIVE windows: do not grow — shed the new key. A real
          // deployment never reaches 20k concurrent live source IPs; this is a
          // flood, and the honest answer is a 429, not unbounded memory.
          if (!entry && hits.size >= MAX_BUCKETS) {
            return { limited: true, retryAfter: Math.ceil(windowMs / 1000) };
          }
        }
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += cost;
      if (entry.count > max) {
        return { limited: true, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
      }
      return { limited: false };
    },
  };
}

// ---- Who is allowed to name the client? (security F1) ----
// The reference deploys put the wallet on 127.0.0.1 behind nginx, which
// APPENDS the real peer to the END of X-Forwarded-For ($proxy_add_x_forwarded_for).
// The socket peer is therefore always loopback in production, so keying on it
// alone would pool ALL visitors into one bucket. The header names the client —
// but only from a TRUSTED peer, and only the element our proxy wrote.
//
// The old code read x-forwarded-for[0], which behind an appending proxy is the
// value the CLIENT sent — fully spoofable, defeating every rate limit and the
// IP-fallback voter identity. We now count `hops` from the RIGHT, and validate
// the result is a real IP (an attacker-injected non-IP string can never key a
// bucket). config carries trustProxy / trustProxyHops / trustProxyHeader.
function peerTrusted(peer, trustProxy) {
  if (trustProxy === 'off') return false;
  if (trustProxy === 'any') return true;
  if (trustProxy === 'loopback') {
    return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  }
  // an explicit IP (container-network proxy). CIDR is intentionally not parsed
  // here — name the proxy's address, or use 'any' behind a private network.
  return peer === trustProxy || peer === `::ffff:${trustProxy}`;
}
function makeClientAddress({ trustProxy, trustProxyHops, trustProxyHeader }) {
  return function clientAddress(req) {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!peerTrusted(peer, trustProxy)) return peer; // header ignored — peer wins
    const raw = String(req.headers[trustProxyHeader] ?? '');
    if (!raw) return peer;
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    // x-real-ip is a single value the proxy overwrote — no hop math.
    // x-forwarded-for: our proxy appended the peer last, so the client is
    // `hops` from the right. A chain SHORTER than hops is not the shape we
    // were told to expect: refuse to guess, fall back to the peer.
    const candidate = trustProxyHeader === 'x-real-ip'
      ? parts[parts.length - 1]
      : (parts.length >= trustProxyHops ? parts[parts.length - trustProxyHops] : undefined);
    // an injected non-IP (or an over-long token) must never key a bucket
    return candidate && isIP(candidate) ? candidate : peer;
  };
}
// Default instance for module-level use; startServer rebuilds it from config.
let clientAddress = makeClientAddress({ trustProxy: 'loopback', trustProxyHops: 1, trustProxyHeader: 'x-forwarded-for' });

// Answers 429 (and returns true) when this source address is over its window
// allowance for the given endpoint-class bucket. `cost` weighs the request
// (the bulk indexer read spends one token per address, F3).
function rateLimited(limiter, req, res, cost = 1) {
  const verdict = limiter.check(clientAddress(req), cost);
  if (!verdict.limited) return false;
  res.setHeader('retry-after', verdict.retryAfter);
  sendJson(res, 429, { error: 'rate limit exceeded — slow down' });
  return true;
}

// ---- "Spend DD" merchant directory ----
// Validation is fail-closed PER ENTRY: a malformed record is dropped, never
// passed through, and one bad entry never kills the whole list. Strings stay
// raw/plain — the client escapes at render time.
const MERCHANT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
function cleanMerchant(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const { id, name, url, category } = entry;
  if (typeof id !== 'string' || !MERCHANT_ID.test(id)) return null;
  if (typeof name !== 'string' || name.length === 0 || name.length > 60) return null;
  if (typeof url !== 'string' || url.length > 200) return null;
  try {
    // the directory renders outbound links — https only, no javascript:/http:
    if (new URL(url).protocol !== 'https:') return null;
  } catch { return null; }
  if (typeof category !== 'string' || category.length === 0 || category.length > 24) return null;
  const blurb = typeof entry.blurb === 'string' && entry.blurb.length <= 140 ? entry.blurb : '';
  const addedAt = typeof entry.addedAt === 'string' && !Number.isNaN(Date.parse(entry.addedAt)) ? entry.addedAt : '';
  return { id, name, url, category, blurb, addedAt };
}

function sanitizeMerchants(json) {
  if (!Array.isArray(json)) throw new Error('merchant list is not a JSON array');
  return json.map(cleanMerchant).filter(Boolean);
}

// Serves the merchant list from (in order of preference): fresh remote fetch,
// in-memory cache, last-good snapshot on disk, bundled seed. The snapshot
// exists so a restart during a directory-repo outage still serves real data.
function createDirectorySource({ directoryUrl, cacheMs, dataDir, seedFile }) {
  const snapshotFile = join(dataDir, 'merchants.cache.json');
  let cache = null; // { data: { merchants, fetchedAt }, at: epoch ms }
  let seedPromise = null; // read once, lazily

  async function loadSeed() {
    if (!seedPromise) {
      seedPromise = (async () => {
        const [text, { mtime }] = await Promise.all([readFile(seedFile, 'utf8'), stat(seedFile)]);
        return { merchants: sanitizeMerchants(JSON.parse(text)), fetchedAt: mtime.toISOString() };
      })();
      // a failed read must not poison the lazy slot forever
      seedPromise.catch(() => { seedPromise = null; });
    }
    return seedPromise;
  }

  async function loadSnapshot() {
    try {
      const parsed = JSON.parse(await readFile(snapshotFile, 'utf8'));
      if (Array.isArray(parsed?.merchants) && typeof parsed.fetchedAt === 'string') {
        return { merchants: sanitizeMerchants(parsed.merchants), fetchedAt: parsed.fetchedAt };
      }
    } catch { /* no snapshot yet / corrupt: fall through to the seed */ }
    return null;
  }

  // Best-effort: a snapshot write failure must not fail the GET that just
  // succeeded. tmp+rename so a crash mid-write never leaves a half-written
  // snapshot. Awaited by getList — after a network fetch, a local write is
  // free, and awaiting keeps the cache/disk states from racing.
  async function saveSnapshot(data) {
    try {
      await mkdir(dataDir, { recursive: true });
      const tmp = join(dataDir, 'merchants.cache.json.tmp');
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, snapshotFile);
    } catch { /* read-only disk: the memory cache still serves */ }
  }

  async function getList() {
    if (!directoryUrl) return loadSeed();
    if (cache && Date.now() - cache.at < cacheMs) return cache.data;
    try {
      const res = await fetch(directoryUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = { merchants: sanitizeMerchants(JSON.parse(await res.text())), fetchedAt: new Date().toISOString() };
      cache = { data, at: Date.now() };
      await saveSnapshot(data);
      return data;
    } catch (err) {
      console.error(`  directory fetch failed (${String(err.message || err)}) — serving fallback data`);
      if (cache) return cache.data;
      return (await loadSnapshot()) ?? loadSeed();
    }
  }

  return { getList };
}

// ---- Directory votes ----
// Voter identity is a per-wallet random token (x-voter-token header, generated
// once by the client and held in localStorage), NOT the IP: two wallets behind
// one router/CGNAT address are two voters, and one cannot toggle the other's
// vote away. The IP is only the fallback for old clients without a token — a
// speed bump, not a wall: CGNAT pools real users onto one address and a
// determined voter rotates IPs or mints tokens. That is fine — votes are
// honest social proof, not a ballot. Rate limits stay per-IP regardless, so
// token minting cannot flood the endpoint. Privacy: only sha256(salt|key) is
// stored; the salt is generated once and persisted, never returned, and no
// hash, token, or IP ever appears in a response.
const VOTER_TOKEN = /^[0-9a-f]{32,64}$/;
function voterKey(req) {
  const token = req.headers['x-voter-token'];
  if (typeof token === 'string' && VOTER_TOKEN.test(token)) return `vt:${token}`;
  return `ip:${clientAddress(req)}`;
}
function createVoteStore({ dataDir }) {
  const file = join(dataDir, 'votes.json');
  let state = null; // { salt, votes: { merchantId: [hash, ...] } }
  let loadPromise = null;
  let writing = Promise.resolve(); // read-modify-write mutex

  function ready() {
    if (!loadPromise) loadPromise = load();
    return loadPromise;
  }

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (typeof parsed?.salt === 'string' && parsed.votes && typeof parsed.votes === 'object') {
        state = { salt: parsed.salt, votes: parsed.votes };
        return;
      }
      console.error('  votes.json is malformed — starting with an empty vote store');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`  votes.json unreadable (${err.message}) — starting with an empty vote store`);
    }
    state = { salt: randomBytes(16).toString('hex'), votes: {} };
  }

  function hashFor(key) {
    return createHash('sha256').update(`${state.salt}|${key}`).digest('hex');
  }

  // Atomic write (tmp + rename) so a crash mid-write never corrupts the file.
  // Persist failures degrade to memory-only rather than failing the vote.
  async function persist() {
    try {
      await mkdir(dataDir, { recursive: true });
      const tmp = join(dataDir, 'votes.json.tmp');
      await writeFile(tmp, JSON.stringify(state));
      await rename(tmp, file);
    } catch (err) {
      console.error(`  votes.json write failed (${err.message}) — vote kept in memory only`);
    }
  }

  return {
    async countFor(id) {
      await ready();
      return (state.votes[id] ?? []).length;
    },
    async hasVoted(id, key) {
      await ready();
      return (state.votes[id] ?? []).includes(hashFor(key));
    },
    // Toggle: present → remove (voted:false), absent → add (voted:true). The
    // promise chain serializes read-modify-write: two interleaved async votes
    // from the same voter must not both read "absent" and double-add.
    toggle(id, key) {
      const run = writing.then(async () => {
        await ready();
        const hash = hashFor(key);
        const hashes = state.votes[id] ?? [];
        const at = hashes.indexOf(hash);
        const voted = at < 0;
        if (voted) hashes.push(hash); else hashes.splice(at, 1);
        state.votes[id] = hashes;
        await persist();
        return { votes: hashes.length, voted };
      });
      writing = run.catch(() => {}); // keep the chain alive past a failed toggle
      return run;
    },
  };
}

// The chain guard deliberately does NOT apply to the directory routes: the
// merchant list is not chain data, and voting must keep working even while
// the node is down for maintenance.
async function handleDirectory(req, res, { directory, votes, listUrl }) {
  const { merchants, fetchedAt } = await directory.getList();
  const key = voterKey(req);
  const withVotes = await Promise.all(merchants.map(async (m) => ({
    ...m,
    votes: await votes.countFor(m.id),
    votedByYou: await votes.hasVoted(m.id, key),
  })));
  sendJson(res, 200, { merchants: withVotes, updatedAt: fetchedAt, listUrl });
}

async function handleDirectoryVote(req, res, { directory, votes, bodyLimit }) {
  const raw = await readBody(req, bodyLimit);
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const id = payload?.id;
  if (typeof id !== 'string' || !MERCHANT_ID.test(id)) {
    return sendJson(res, 400, { error: 'malformed merchant id' });
  }
  // the id must exist in the CURRENTLY served list — voting for a merchant
  // the directory no longer lists is a client bug or a replay
  const { merchants } = await directory.getList();
  if (!merchants.some((m) => m.id === id)) {
    return sendJson(res, 400, { error: 'unknown merchant id' });
  }
  const { votes: count, voted } = await votes.toggle(id, voterKey(req));
  sendJson(res, 200, { id, votes: count, voted });
}

async function handleRpc(req, res, { rpc, mockMode, guard, bodyLimit }) {
  const raw = await readBody(req, bodyLimit);
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const { method, params = [] } = payload;
  if (!method || !ALLOWED_METHODS.has(method)) {
    return sendJson(res, 403, { error: `method not allowed: ${method}` });
  }
  // Fail closed on a guarded deployment: EVERY method is refused while the
  // backend is cross-wired OR not yet confirmed — even reads would let the UI
  // render the wrong network's reality under this deployment's branding. The
  // guard's own probe keeps re-checking (5s until first confirmation), so a
  // recovering or fixed backend clears this without a restart.
  if (guard?.blocked()) {
    return sendJson(res, 503, { error: guard.describe(), mock: mockMode });
  }
  try {
    const result = mockMode ? mockResponse(method, params) : await callNode(rpc, method, params);
    if (method === 'getblockchaininfo' && result?.chain) guard?.seen(result.chain);
    sendJson(res, 200, { result, mock: mockMode });
  } catch (err) {
    sendJson(res, 502, { error: String(err.message || err), mock: mockMode });
  }
}

// Static files previously shipped with NO cache headers, so mobile browsers
// heuristically cached the app and ran DAYS-OLD JavaScript through a rapid-fix
// cycle (live incident 2026-07-27: a phone kept reproducing bugs that were
// fixed and deployed hours earlier). `no-cache` does not mean "don't cache" —
// it means "revalidate before use": with the Last-Modified/304 pair below,
// every load costs one conditional request and fetches bytes only when a
// deploy actually changed the file. Vendor crypto and media stay immutable-ish
// (they change only with a deliberate vendor bump, which changes the lock).
async function serveFrom(baseDir, relPath, res, req) {
  const filePath = normalize(join(baseDir, relPath));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const { mtime } = await stat(filePath);
    const lastModified = mtime.toUTCString();
    if (req?.headers['if-modified-since'] === lastModified) {
      res.writeHead(304, { 'cache-control': 'no-cache', 'last-modified': lastModified });
      return res.end();
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'last-modified': lastModified,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.startsWith('/lib/')) return serveFrom(LIB_DIR, urlPath.slice('/lib/'.length), res, req);
  if (urlPath.startsWith('/vendor/')) {
    const rel = urlPath.slice('/vendor/'.length);
    const pkg = VENDOR_PACKAGES.find((p) => rel.startsWith(p + '/'));
    if (!pkg) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return serveFrom(VENDOR_ROOTS[pkg], rel.slice(pkg.length + 1), res, req);
  }
  return serveFrom(PUBLIC_DIR, urlPath, res, req);
}

export function startServer(overrides = {}) {
  const vendorFileCount = verifyVendorIntegrity();
  const env = configFromEnv();
  const config = {
    ...env,
    ...overrides,
    rpc: { ...env.rpc, ...(overrides.rpc || {}) },
    rateLimits: { ...env.rateLimits, ...(overrides.rateLimits || {}) },
    bodyLimits: { ...env.bodyLimits, ...(overrides.bodyLimits || {}) },
  };
  const mockMode = !config.rpc.user || !config.rpc.pass;

  // Rebuild the client-address resolver from THIS server's trust config
  // (security F1) — tests and multi-instance hosts pass their own via
  // startServer({ trustProxy, trustProxyHops, trustProxyHeader }).
  clientAddress = makeClientAddress({
    trustProxy: config.trustProxy ?? 'loopback',
    trustProxyHops: config.trustProxyHops ?? 1,
    trustProxyHeader: config.trustProxyHeader ?? 'x-forwarded-for',
  });

  // HSTS is OPT-IN (HSTS=1 at server start) and off by default: the wallet
  // also runs on plain http://localhost, where the header is meaningless. A
  // TLS deployment (e.g. behind a reverse proxy terminating TLS) sets HSTS=1
  // to pin browsers to https. Computed once here — never read env per request.
  const responseHeaders = process.env.HSTS === '1'
    ? { ...SECURITY_HEADERS, 'strict-transport-security': 'max-age=15552000; includeSubDomains' }
    : SECURITY_HEADERS;

  // One limiter bucket per rate-limited endpoint class (see configFromEnv for
  // the why behind the ceilings). /api/config, /api/price-history, and static
  // files are deliberately NOT limited — they cost no upstream work.
  const { windowMs } = config.rateLimits;
  const rpcLimiter = createRateLimiter({ windowMs, max: config.rateLimits.rpcMax });
  const indexerLimiter = createRateLimiter({ windowMs, max: config.rateLimits.indexerMax });
  const faucetLimiter = createRateLimiter({ windowMs, max: config.rateLimits.faucetMax });
  const directoryLimiter = createRateLimiter({ windowMs, max: config.rateLimits.directoryMax });
  const voteLimiter = createRateLimiter({ windowMs, max: config.rateLimits.voteMax });

  // Merchant directory + vote store. Both live in dataDir (never the app
  // folder — deploys wipe it); the seed ships with the app and is read-only.
  const directory = createDirectorySource({
    directoryUrl: config.directoryUrl,
    cacheMs: config.directoryCacheMs,
    dataDir: config.dataDir,
    seedFile: join(__dirname, 'merchants.seed.json'),
  });
  const votes = createVoteStore({ dataDir: config.dataDir });

  let priceSeries = [];
  let guard = null;

  // ---- /api/events: server-push (SSE) instead of client polling ----
  // The wallet server sits NEXT to the node, so it watches the chain once
  // (a 2s getblockcount against localhost costs ~nothing) and pushes a
  // `block` event to every connected client the moment a block lands.
  // Clients then refresh exactly when there is something new, instead of
  // discovering it by the Nth poll. EventSource reconnects natively; the
  // 15s heartbeat keeps proxies from reaping idle streams; the watcher only
  // runs while someone is listening. Mock mode has no advancing chain, so
  // streams there carry heartbeats only.
  const sseClients = new Set();
  let sseWatchTimer = null;
  let sseLastHeight = null;
  const sseBroadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) client.write(frame);
  };
  async function sseWatchTick() {
    try {
      const res = await fetch(config.rpc.url, {
        method: 'POST',
        headers: { authorization: 'Basic ' + Buffer.from(`${config.rpc.user}:${config.rpc.pass}`).toString('base64') },
        body: JSON.stringify({ method: 'getblockcount', params: [] }),
        signal: AbortSignal.timeout(5_000),
      });
      const { result } = await res.json();
      if (Number.isInteger(result) && result !== sseLastHeight) {
        if (sseLastHeight !== null) sseBroadcast('block', { height: result });
        sseLastHeight = result;
      }
    } catch { /* node briefly unreachable — next tick tries again */ }
  }
  // Cap concurrent SSE streams per client address (security F8): each held
  // stream pins a socket, so an open-and-hold flood from one source could
  // exhaust file descriptors. The chain watcher is shared, so a handful of
  // tabs per user is plenty. Keyed on clientAddress (now spoof-resistant, F1).
  const SSE_PER_IP = Number(process.env.SSE_MAX_PER_IP) || 8;
  const sseByAddr = new Map(); // address -> count
  function handleEvents(req, res) {
    const addr = clientAddress(req);
    if ((sseByAddr.get(addr) ?? 0) >= SSE_PER_IP) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '30' });
      return res.end(JSON.stringify({ error: 'too many open event streams from this address' }));
    }
    sseByAddr.set(addr, (sseByAddr.get(addr) ?? 0) + 1);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx: do not buffer the stream
    });
    res.write('retry: 5000\n: connected\n\n');
    sseClients.add(res);
    if (!sseWatchTimer && !mockMode) {
      sseWatchTimer = setInterval(sseWatchTick, config.sseWatchMs ?? 2_000);
      sseWatchTick();
    }
    const heartbeat = setInterval(() => res.write(': hb\n\n'), config.sseHeartbeatMs ?? 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
      const n = (sseByAddr.get(addr) ?? 1) - 1;
      if (n > 0) sseByAddr.set(addr, n); else sseByAddr.delete(addr);
      if (sseClients.size === 0 && sseWatchTimer) { clearInterval(sseWatchTimer); sseWatchTimer = null; }
    });
  }

  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(responseHeaders)) res.setHeader(k, v);
    try {
      if (req.method === 'POST' && req.url === '/api/rpc') {
        if (rateLimited(rpcLimiter, req, res)) return;
        return await handleRpc(req, res, { rpc: config.rpc, mockMode, guard, bodyLimit: config.bodyLimits.rpcBytes });
      }
      if (req.method === 'POST' && req.url === '/api/faucet/claim') {
        if (rateLimited(faucetLimiter, req, res)) return;
        return await handleFaucetClaim(req, res, { faucetUrl: config.faucetUrl, guard, bodyLimit: config.bodyLimits.faucetBytes });
      }
      // GETs are the per-address reads; the one POST is the bulk read
      // (/api/indexer/addresses). Both share the indexer rate bucket — and the
      // bulk read is WEIGHED by its address count (F3): a 200-address call
      // demands ~200× the upstream work of one GET, so it must spend ~200
      // tokens, not 1. The body is read once here and handed through.
      if ((req.method === 'GET' || (req.method === 'POST' && req.url === '/api/indexer/addresses'))
          && req.url.startsWith('/api/indexer/')) {
        if (req.method === 'POST') {
          let body;
          try {
            body = await readBody(req, 64 * 1024); // the indexer's own bulk cap
          } catch (err) {
            return sendJson(res, err.statusCode === 413 ? 413 : 400, { error: 'request body too large' });
          }
          let cost = 1;
          try {
            const parsed = JSON.parse(body || '{}');
            if (Array.isArray(parsed.addresses) && parsed.addresses.length > 1) cost = parsed.addresses.length;
          } catch { /* unparseable: cost 1 — the indexer rejects the body itself */ }
          if (rateLimited(indexerLimiter, req, res, cost)) return;
          return await handleIndexer(req, res, { ...config, guard, preReadBody: body });
        }
        if (rateLimited(indexerLimiter, req, res)) return;
        return await handleIndexer(req, res, { ...config, guard });
      }
      // The stablecoin flows (mint/transfer/redeem) ship unconditionally as one
      // unit (ADR-0002, release gate #17) — no feature flag in the config.
      if (req.method === 'GET' && req.url === '/api/events') {
        return handleEvents(req, res);
      }
      // Directory routes carry no chain guard: this is not chain data, and
      // voting must work even during node maintenance (see handleDirectory).
      if (req.method === 'GET' && req.url === '/api/directory') {
        if (rateLimited(directoryLimiter, req, res)) return;
        return await handleDirectory(req, res, { directory, votes, listUrl: config.directoryListUrl });
      }
      if (req.method === 'POST' && req.url === '/api/directory/vote') {
        if (rateLimited(voteLimiter, req, res)) return;
        return await handleDirectoryVote(req, res, { directory, votes, bodyLimit: config.bodyLimits.voteBytes });
      }
      if (req.method === 'GET' && req.url === '/api/price-history') {
        return sendJson(res, 200, { series: mockMode ? syntheticPriceSeries() : priceSeries, mock: mockMode });
      }
      if (req.url === '/api/config') {
        return sendJson(res, 200, {
          version: APP_VERSION,
          mock: mockMode,
          rpcUrl: mockMode ? null : config.rpc.url,
          faucet: Boolean(config.faucetUrl),
          indexer: Boolean(config.indexerUrl),
          explorerTxUrl: config.explorerTxUrl,
          // cross-wire guard (#64): the UI renders a blocking error on mismatch
          expectedChain: config.expectedChain || null,
          chain: guard?.actual ?? null,
          chainMismatch: Boolean(guard?.mismatch()),
        });
      }
      if (req.method === 'GET') return await serveStatic(req, res);
      res.writeHead(405).end('method not allowed');
    } catch (err) {
      // readBody rejects oversized POST bodies with .statusCode 413
      if (err?.statusCode === 413) return sendJson(res, 413, { error: 'request body too large' });
      sendJson(res, 500, { error: String(err.message || err) });
    }
  });

  if (!mockMode) {
    guard = startChainGuard({ rpc: config.rpc, expectedChain: config.expectedChain }, server);
    priceSeries = startPriceSampler({ rpc: config.rpc, ...(config.priceHistory || {}), guard }, server);
  }

  server.listen(config.port, config.bindHost || '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`\n  DGBclick Wallet · DigiDollar wallet ${APP_VERSION}`);
    console.log(`  → http://localhost:${port} (bind ${config.bindHost || '127.0.0.1'})`);
    console.log(`  mode: ${mockMode ? 'MOCK (set DGB_RPC_USER/DGB_RPC_PASS for a real node)' : `REAL node @ ${config.rpc.url}`}`);
    console.log(`  trust-proxy: ${config.trustProxy ?? 'loopback'} hops=${config.trustProxyHops ?? 1} header=${config.trustProxyHeader ?? 'x-forwarded-for'}`);
    console.log(`  vendor: ${vendorFileCount} files verified against vendor.lock\n`);
  });
  return server;
}

// Auto-start only when run directly (node server.js), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
