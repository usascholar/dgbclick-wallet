// The per-transaction spend ceiling the user has accepted for THIS device.
//
// Resolution lives here as a pure function of the stored string for the same
// reason autolock.js does: the default path is the one every untouched profile
// takes, and inline in app.js it would be the one path no test can reach.
//
// The safety property that matters, and the reason this is not a one-liner:
// an unreadable preference must fall back to the STRICTEST cap, never the
// loosest. Absent, blank, corrupted, hostile, or from a future version that
// wrote a value this build does not understand — all of them resolve to $500.
// The only way to spend above the default is for someone to have chosen it
// explicitly and completed the acknowledgement, which is what UNLIMITED
// requires a distinct sentinel for: `Number('unlimited')` is NaN, and NaN must
// not be mistaken for "no ceiling".
//
// This is a GUARDRAIL, not a security control. It runs in the page, so anyone
// with devtools can defeat it. Its job is to stop an accident and to make a
// deliberate choice deliberate, not to stop an attacker who already controls
// the browser.

export const TXCAP_KEY = 'diginaut.txcap';
export const TXCAP_DEFAULT_USD = 500;

/** The sentinel for "no ceiling". A STRING, not Infinity or 0 or -1, so that a
 * numeric coercion bug can never produce it by accident. */
export const TXCAP_UNLIMITED = 'unlimited';

/** The ladder offered in Settings, strictest first. `null` means no ceiling. */
export const TXCAP_LADDER = [500, 2000, 10000, null];

/** Stored value (raw string, or null when absent) → the effective cap in USD,
 * or `null` for no ceiling.
 *
 * Anything this build cannot make sense of resolves to TXCAP_DEFAULT_USD. That
 * includes values ABOVE the ladder: a profile that somehow holds "999999" gets
 * the default rather than a ceiling nobody acknowledged. */
export function txCapUsd(raw) {
  if (raw === null || raw === undefined) return TXCAP_DEFAULT_USD;
  const text = String(raw).trim();
  if (text === '') return TXCAP_DEFAULT_USD;
  if (text === TXCAP_UNLIMITED) return null;
  const usd = Number(text);
  if (!Number.isFinite(usd) || usd <= 0) return TXCAP_DEFAULT_USD;
  // Only ladder values are honoured. A hand-edited localStorage entry is not a
  // second way to raise the cap without the acknowledgement ceremony — though
  // note the whole check is client-side, so this deters fat fingers and stale
  // values, not a determined user.
  return TXCAP_LADDER.includes(usd) ? usd : TXCAP_DEFAULT_USD;
}

/** Read the device's accepted cap. Shared by every gate so there is exactly one
 * implementation of "what ceiling is in force" — a second copy that drifted
 * would be a spend guard that disagrees with itself.
 *
 * `storage` is injectable for tests; a throwing localStorage (private mode,
 * blocked third-party storage) resolves to the strict default like any other
 * unreadable preference. */
export function readTxCapUsd(storage) {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  let raw = null;
  try { raw = s ? s.getItem(TXCAP_KEY) : null; } catch { /* unreadable → default */ }
  return txCapUsd(raw);
}

/** The value to persist for a ladder choice. */
export function txCapStorageValue(cap) {
  return cap === null ? TXCAP_UNLIMITED : String(cap);
}

/** Human label for a cap, used in the banner, the select, and the ceremony. */
export function txCapLabel(cap) {
  return cap === null ? 'No limit' : `$${cap.toLocaleString('en-US')}`;
}

/** Is `next` a LOOSENING of `current`? Only a loosening needs the risk
 * ceremony; tightening back down, or re-picking what you already have, does
 * not. `null` (no ceiling) is looser than every number. */
export function isRaise(current, next) {
  if (next === null) return current !== null;
  if (current === null) return false;
  return next > current;
}
