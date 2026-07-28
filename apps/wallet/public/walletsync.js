// Wallet-sync helpers shared between app.js and its tests. Pure functions
// only — app.js is DOM-bound and cannot be imported by node:test, so the
// scan/dedupe logic that must be unit-tested lives here (same pattern as
// autolock.js and validate.js).

/** FNV-1a 32-bit. A small non-cryptographic hash for INTEGRITY, not security:
 * it answers "is this cache entry about the same descriptors?" — nobody is
 * expected to attack it, and nothing here depends on it keeping a secret. */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable fingerprint of the wallet's extra descriptor set. The chain-used
 * cache is keyed by wallet.id, which is a device-local epoch (`w<Date.now>`) —
 * a remove + same-millisecond reimport (or a clock rollback) can hand a
 * DIFFERENT wallet the same id, and loading another wallet's used-index set
 * would skip discovery of this wallet's real addresses. The fingerprint lets
 * the loader tell "same wallet, warm start" from "same id, different wallet".
 * Only the parsed structural fields are serialized, so re-parsing the same
 * descriptor text reproduces the same fingerprint. */
export function extraSourcesFingerprint(sources) {
  const text = (sources ?? [])
    .map((s) => [s.kind ?? '', s.origin ?? '', s.extendedKey ?? '', s.relPath ?? ''].join('|'))
    .join('\n');
  return fnv1a(text);
}

/** The wallet's own addresses, lowercased, for Activity in/out classification.
 * Built from the per-entry metadata aligned with perAddr — which carries the
 * extra-chain addresses on EVERY poll cycle, including the cycles where the
 * extra chains were not re-read and last block's answer was reused. Building
 * it from the cycle's fetch list instead drops the extras on those cached
 * cycles, and a payment received on an extra-chain Core address then renders
 * with a blank amount (and a self-send mislabels as "Sent") until the next
 * block re-read. */
export function myAddressSet(addrMeta) {
  return new Set((addrMeta ?? []).map(({ address }) => String(address).toLowerCase()));
}

/** One coin, one entry: overlapping watched addresses (two descriptors that
 * resolve to the same chain, a twin counted twice) can surface the SAME
 * outpoint twice. First wins. Applies to the balance/history display AND to
 * spendableUtxos — selecting the same outpoint twice builds a duplicate-input
 * transaction the node rejects at broadcast. Keys tolerate both the indexer
 * shape ({txid, vout}) and the spend-plan shape ({txidHex, vout}). */
export function dedupeUtxos(utxos) {
  const seen = new Set();
  return (utxos ?? []).filter((u) => {
    const key = (u.txid ?? u.txidHex) + ':' + u.vout;
    return seen.has(key) ? false : seen.add(key);
  });
}
