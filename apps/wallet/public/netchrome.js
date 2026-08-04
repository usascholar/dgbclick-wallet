// Network-conditional page chrome (#61). One build serves every network, so
// the banner and title are decided at runtime from the node's reported chain
// — never baked into the HTML.
//
// Beta posture (#54/#63) also lives here: the cap is per-transaction,
// mainnet-only, with NO cumulative tracking. It sits on top of the consensus
// limits (DD_TX_LIMITS) — this is a client-side beta ceiling, not consensus.
//
// $500 is now the DEFAULT rather than the only value: the user can raise it on
// their own device through the acknowledgement ceremony in txcap.js. That is
// not a weakening. The ceiling always ran in the page, so anyone with devtools
// could already step over it; making it a setting turns a silent bypass into a
// deliberate, disclosed choice. Every function here therefore takes the
// effective cap as an argument and DEFAULTS it to BETA_TX_CAP_USD, so a caller
// that forgets gets the strict behaviour rather than an accidental bypass.
export const BETA_TX_CAP_USD = 500;

/** The beta-cap violation message, or null when the amount is allowed.
 * usdAmount == null means the USD value is unknowable (no price feed) —
 * decision #54: warn on the confirm screen, but ALLOW the transaction.
 * Accepts both mainnet spellings — the node says 'main', the wallet's
 * netName says 'mainnet' — so a mixed-up caller can't silently drop the cap.
 *
 * capUsd is the ceiling the user has accepted on this device (txcap.js):
 * a number, or `null` for no ceiling. It DEFAULTS to the $500 beta value, so
 * a caller that forgets to pass it gets the strict behaviour rather than an
 * accidental bypass — the same reason txCapUsd falls back to the default on
 * anything it cannot read. */
export function betaCapError(netName, usdAmount, capUsd = BETA_TX_CAP_USD) {
  if (netName !== 'mainnet' && netName !== 'main') return null;
  if (usdAmount == null) return null;
  if (capUsd === null) return null; // the user accepted no ceiling
  // An unusable cap is treated as the default, never as "no ceiling".
  const cap = Number.isFinite(capUsd) && capUsd > 0 ? capUsd : BETA_TX_CAP_USD;
  if (usdAmount <= cap) return null;
  return cap === BETA_TX_CAP_USD
    ? `during the mainnet beta, transactions are capped at $${cap} each`
    : `this device's per-transaction limit is $${cap.toLocaleString('en-US')} — raise it in Settings if you accept the risk`;
}

/** May the seed-backup ceremony be postponed ("Remind me later")? Mainnet
 * forces the quiz before funds are at stake; testnet/regtest keep the
 * frictionless skip (same runtime-chain gating as the $500 beta cap). An
 * UNKNOWN chain (the node hasn't named its chain yet, e.g. it is down) is
 * STRICT: a mainnet deployment with a dead node must not offer the skip. */
export function backupSkipAllowed(chain) {
  return chain === 'test' || chain === 'testnet' || chain === 'regtest';
}

/** `capUsd` is the device's accepted ceiling (number, or null for none). The
 * mainnet banner states the cap that is ACTUALLY in force, not the shipped
 * default: a banner promising "$500/tx cap" to someone who raised it to
 * $10,000 is worse than no banner, because it reads as a guarantee. */
export function networkChrome(chain, capUsd = BETA_TX_CAP_USD) {
  switch (chain) {
    case 'test':
      return {
        title: 'DGBclick Wallet · DigiDollar testnet wallet',
        banner: 'TESTNET ONLY — no real value. Keys live in this browser; there is no server-side backup.',
        level: 'warn',
        pill: 'TESTNET',
      };
    case 'regtest':
      return {
        title: 'DGBclick Wallet · DigiDollar regtest wallet',
        banner: 'REGTEST — developer network, coins have no value.',
        level: 'warn',
        pill: 'REGTEST',
      };
    case 'main':
      // Copy decided in #54 — loud, red (level:'danger'), and honest about the
      // cap. "Honest" now means reporting the ceiling this device is actually
      // running under, including when the user has removed it entirely.
      return {
        title: 'DGBclick Wallet · DigiDollar wallet',
        banner: capUsd === null
          ? 'MAINNET BETA — real funds at risk. Beta software, in-browser keys, no backup. NO per-tx limit: you removed it.'
          : `MAINNET BETA — real funds at risk. Beta software, in-browser keys, no backup. $${capUsd.toLocaleString('en-US')}/tx cap.`,
        level: 'danger',
        pill: 'MAINNET',
      };
    default:
      // Chain not yet known (or a network we don't name): claim nothing.
      return { title: 'DGBclick Wallet · DigiDollar wallet', banner: null, level: null, pill: null };
  }
}
