// Pending-broadcast log (#62's sibling problem): when sendrawtransaction times
// out or the connection drops, the signed transaction MAY already be in the
// node's mempool. Rebuilding a fresh tx over the same UTXOs and sending that
// would double-spend the user's own coins — so the wallet persists the signed
// hex BEFORE broadcasting. On recovery it can rebroadcast the SAME hex (an
// idempotent operation: identical bytes, identical txid, the node answers
// "already in mempool") or reconcile via an indexer tx lookup by txid.
//
// Records persist as a JSON array in injected storage (localStorage in the
// browser, a Map-backed stand-in in tests):
//   { id, hex, kind, net, createdAt, txid }
// txid is computed locally at record() time (see txidFromHex) so the record is
// self-sufficient for reconciliation even if the page dies before the node
// answers; markTxid() exists for the node's answer to confirm it.

export const BROADCAST_LOG_KEY = 'diginaut.pendingBroadcasts';

// A runaway broadcast-retry loop must not grow localStorage unboundedly.
// Twenty interrupted transactions is already a disaster scenario.
const MAX_RECORDS = 20;

const HEX_RE = /^([0-9a-f]{2})+$/;
const TXID_RE = /^[0-9a-f]{64}$/;

const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The txid the node WOULD return for this raw transaction: double-SHA-256
 * over the raw bytes, digest reversed, lowercase hex. Lets the wallet name the
 * tx it is about to broadcast (and look it up later) without trusting any
 * third party. globalThis.crypto.subtle exists in browsers and Node ≥ 18.
 * Throws on anything that is not even-length lowercase hex. */
export async function txidFromHex(hex) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) {
    throw new Error('not a raw transaction hex string');
  }
  const bytes = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  const subtle = globalThis.crypto.subtle;
  const first = await subtle.digest('SHA-256', bytes);
  const second = new Uint8Array(await subtle.digest('SHA-256', first));
  second.reverse(); // consensus displays txids little-endian
  return bytesToHex(second);
}

/** A pending-broadcast log over the given storage (localStorage in the
 * browser). Every read goes through JSON.parse inside try/catch: a corrupt
 * log must never crash boot — funds-safety beats bookkeeping, and a wallet
 * that won't start can't rebroadcast anything. */
export function createBroadcastLog(storage) {
  function list() {
    try {
      const raw = storage.getItem(BROADCAST_LOG_KEY);
      if (raw == null) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function save(records) {
    storage.setItem(BROADCAST_LOG_KEY, JSON.stringify(records));
  }

  /** Append a signed tx BEFORE broadcasting it. Validates the raw hex (garbage
   * here means a bug in the signing path — refuse loudly), computes its txid,
   * and evicts the oldest record when the cap is reached. Returns the record. */
  async function record({ hex, kind, net }) {
    if (typeof hex !== 'string' || !HEX_RE.test(hex)) {
      throw new Error('broadcast log: hex must be even-length lowercase hex');
    }
    if (typeof kind !== 'string' || kind === '') {
      throw new Error('broadcast log: kind must be a non-empty string');
    }
    if (typeof net !== 'string' || net === '') {
      throw new Error('broadcast log: net must be a non-empty string');
    }
    const txid = await txidFromHex(hex);
    const records = list();
    while (records.length >= MAX_RECORDS) records.shift(); // oldest first
    const rec = {
      id: globalThis.crypto.randomUUID(),
      hex,
      kind,
      net,
      createdAt: new Date().toISOString(),
      txid,
    };
    records.push(rec);
    save(records);
    return rec;
  }

  /** Fill in the txid the node returned (should match the computed one).
   * Unknown id is a no-op — the record may have been removed concurrently. */
  function markTxid(id, txid) {
    if (typeof txid !== 'string' || !TXID_RE.test(txid)) {
      throw new Error('broadcast log: txid must be 64 lowercase hex chars');
    }
    const records = list();
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    rec.txid = txid;
    save(records);
  }

  /** Drop a record: confirmed, superseded, or reconciled away. */
  function remove(id) {
    save(list().filter((r) => r.id !== id));
  }

  return { list, record, markTxid, remove };
}
