// Per-address money-record assembly (F3). One bulk entry becomes the record
// refreshMoney renders from — { utxos, history, positions, ddCents } — with
// the complete-or-absent rule enforced at the trust boundary:
//
//   A money field is either COMPLETE or ABSENT — never a short list under the
//   name of a full one. An indexer that blew its scan budget answers
//   `{ complete: false, reason }` with the money arrays OMITTED. That is
//   "unknown", never "empty": the caller then serves the LAST GOOD record for
//   the address, so a hot scan can never blank a balance or make a position
//   vanish (an empty positions array renders "No open positions" and rebuilds
//   the redeem flow's source of truth). With no last good record yet, the
//   honest state is a thrown error — the refresh-level catch keeps the
//   previous screen and the next poll retries.
//
// Pure and DOM-free (like walletsync.js) so node:test can drive it.

import { asIncomplete, validateUtxos, validateDdUtxos, validatePositions, validateHistory } from './validate.js';

/** Build the per-address record from a bulk entry, or substitute the cached
 * last-good one on an incomplete scan. `cache` is a caller-owned Map keyed by
 * address (app state); pass null/undefined in pure contexts. Throws on a
 * failed entry or a first-ever incomplete answer. */
export function recordFromBulkEntry({ entry, address, dd, tipHeight, cache }) {
  if (!entry || entry.error) {
    throw new Error(`the balance index could not answer for an address (${entry?.error ?? 'no entry'})`);
  }
  if (asIncomplete(entry)) {
    const cached = cache?.get(address);
    if (!cached) throw new Error('the balance index is still scanning an address — retry in a few seconds');
    return cached;
  }
  const record = {
    utxos: validateUtxos({ utxos: entry.utxos }).utxos,
    history: validateHistory({ history: entry.history }).history,
    positions: dd
      ? validatePositions({ address, tipHeight, positions: entry.positions })
      : { address, positions: [], tipHeight: 0 },
    ddCents: dd ? BigInt(validateDdUtxos({ utxos: entry.ddUtxos, totalCents: entry.ddTotalCents }).totalCents) : 0n,
  };
  cache?.set(address, record);
  return record;
}
