// DigiDollar consensus reject strings → actionable errors (#62).
// The node's sendrawtransaction surfaces Core's raw reject tokens
// (digidollar/validation.cpp); a human can't act on "minting-frozen-volatility".
// Each translation keeps the raw token so support/debugging still has it.
// Unknown messages return null — the caller shows the original text.

// shared with the mint flow's pre-sign gate — one place for the freeze wording
export const MINT_FREEZE_EXPLANATION =
  'Minting is temporarily frozen by consensus: the DGB price moved 20% or more within an hour.';

// The two "this exact tx is already known to the network" rejects share one
// meaning — and the rebroadcast path treats them as SUCCESS (see
// isAlreadyBroadcast below), so the wording lives in one const.
const ALREADY_BROADCAST_EXPLANATION =
  'This transaction is already in the network’s mempool — the earlier broadcast went through after all. ' +
  'It will confirm with the next blocks. Do not send again.';

const TOKEN_MESSAGES = [
  // --- broadcast-ambiguity rejects (matched before the consensus family) ---
  // A timed-out sendrawtransaction may have landed in the mempool anyway;
  // these translations steer the user to RECONCILE, never to rebuild-and-resend.
  ['already in mempool', ALREADY_BROADCAST_EXPLANATION],
  ['txn-already-in-mempool', ALREADY_BROADCAST_EXPLANATION], // Core's hyphenated spelling
  ['txn-already-known', ALREADY_BROADCAST_EXPLANATION],
  ['txn-mempool-conflict',
    'The node refused this transaction: it conflicts with another mempool transaction spending the same coins. ' +
    'If this was a retry after a failed-looking broadcast, the FIRST attempt may be the live one — ' +
    'check Activity before doing anything else.'],
  ['missingorspent', // matches bad-txns-inputs-missingorspent and txn-missing-inputs variants
    'The coins this transaction spends are already spent — most often by your own earlier broadcast ' +
    'going through after all. Check Activity and your positions before rebuilding; do NOT just send again.'],
  ['minting-frozen-volatility', // matches the -candidate variant too
    MINT_FREEZE_EXPLANATION +
    ' Your funds are untouched — the network refused the transaction. Try again once the market calms.'],
  ['all-operations-frozen',
    'All DigiDollar operations are frozen by consensus: the DGB price moved 50% or more within 7 days. ' +
    'Minting, transfers and redemptions resume automatically when volatility subsides.'],
  ['bad-dd-mint-amount',
    'The node rejected the amount: it is outside this network’s consensus mint limits.'],
  ['bad-oracle-price',
    'The node rejected the oracle price this transaction was built against. ' +
    'The network may be between price updates — try again in a few minutes.'],
];

const FAMILY_MESSAGES = [
  ['bad-mint-', 'The node rejected this mint transaction at the consensus level.'],
  ['bad-redeem-', 'The node rejected this redemption at the consensus level.'],
  ['bad-oracle-', 'The node rejected the oracle data behind this transaction. Try again in a few minutes.'],
  ['bad-dd-', 'The node rejected this DigiDollar transaction at the consensus level.'],
];

export function friendlyDDError(message) {
  const raw = String(message ?? '');
  for (const [token, text] of TOKEN_MESSAGES) {
    // report the FULL token the node sent (e.g. …-volatility-candidate), not
    // just the prefix we matched on — support needs the exact reject string
    const m = raw.match(new RegExp(`${token}[a-z0-9-]*`));
    if (m) return `${text} (node: ${m[0]})`;
  }
  for (const [prefix, text] of FAMILY_MESSAGES) {
    const m = raw.match(new RegExp(`${prefix}[a-z0-9-]*`));
    if (m) return `${text} (node: ${m[0]})`;
  }
  return null;
}

/** True when the node says this EXACT transaction is already in its mempool.
 * The rebroadcast path treats this as SUCCESS: the same signed bytes produce
 * the same txid, so "already known" means the earlier attempt went through —
 * not an error to retry, and never a reason to rebuild over the same UTXOs. */
export function isAlreadyBroadcast(message) {
  const raw = String(message ?? '');
  return /already in mempool[a-z0-9-]*/.test(raw)
    || /txn-already-in-mempool[a-z0-9-]*/.test(raw)
    || /txn-already-known[a-z0-9-]*/.test(raw);
}
