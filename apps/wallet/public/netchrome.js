// Network-conditional page chrome (#61). One build serves every network, so
// the banner and title are decided at runtime from the node's reported chain
// — never baked into the HTML.
//
// Beta posture (#54/#63) also lives here: the $500/tx cap is per-transaction,
// mainnet-only, with NO cumulative tracking. It sits on top of the consensus
// limits (DD_TX_LIMITS) — this is a client-side beta ceiling, not consensus.
export const BETA_TX_CAP_USD = 500;

/** The beta-cap violation message, or null when the amount is allowed.
 * usdAmount == null means the USD value is unknowable (no price feed) —
 * decision #54: warn on the confirm screen, but ALLOW the transaction.
 * Accepts both mainnet spellings — the node says 'main', the wallet's
 * netName says 'mainnet' — so a mixed-up caller can't silently drop the cap. */
export function betaCapError(netName, usdAmount) {
  if (netName !== 'mainnet' && netName !== 'main') return null;
  if (usdAmount == null) return null;
  if (usdAmount <= BETA_TX_CAP_USD) return null;
  return `during the mainnet beta, transactions are capped at $${BETA_TX_CAP_USD} each`;
}

/** May the seed-backup ceremony be postponed ("Remind me later")? Mainnet
 * forces the quiz before funds are at stake; testnet/regtest keep the
 * frictionless skip (same runtime-chain gating as the $500 beta cap). An
 * UNKNOWN chain (the node hasn't named its chain yet, e.g. it is down) is
 * STRICT: a mainnet deployment with a dead node must not offer the skip. */
export function backupSkipAllowed(chain) {
  return chain === 'test' || chain === 'testnet' || chain === 'regtest';
}

export function networkChrome(chain) {
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
      // Copy decided in #54 — loud, red (level:'danger'), and honest about the cap.
      return {
        title: 'DGBclick Wallet · DigiDollar wallet',
        banner: `MAINNET BETA — real funds at risk. Beta software, in-browser keys, no backup. $${BETA_TX_CAP_USD}/tx cap.`,
        level: 'danger',
        pill: 'MAINNET',
      };
    default:
      // Chain not yet known (or a network we don't name): claim nothing.
      return { title: 'DGBclick Wallet · DigiDollar wallet', banner: null, level: null, pill: null };
  }
}
