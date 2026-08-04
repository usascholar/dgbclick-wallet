import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  txCapUsd, txCapStorageValue, txCapLabel, isRaise,
  TXCAP_DEFAULT_USD, TXCAP_UNLIMITED, TXCAP_LADDER,
} from '../public/txcap.js';
import { betaCapError, networkChrome, BETA_TX_CAP_USD } from '../public/netchrome.js';

// The per-tx cap is a spend guardrail on mainnet. Every test here is really the
// same question asked from a different angle: can anything OTHER than a
// deliberate, acknowledged choice end up loosening it? The direction of failure
// is what matters — resolving too strict costs a user one trip to Settings,
// resolving too loose can cost them the transaction.

test('an unreadable preference resolves to the STRICT default, never to no-limit', () => {
  for (const raw of [null, undefined, '', '   ', 'abc', 'NaN', '{}', '[]', 'Infinity', '-1', '0']) {
    assert.equal(txCapUsd(raw), TXCAP_DEFAULT_USD, `${JSON.stringify(raw)} must fall back to the default`);
  }
  assert.equal(TXCAP_DEFAULT_USD, 500, 'the shipped beta ceiling is $500/tx (#54)');
});

test('a value above the ladder is not a back door — it resolves to the default', () => {
  // Hand-editing localStorage must not be a second way to raise the ceiling
  // without the acknowledgement. (Client-side, so this deters stale values and
  // fat fingers, not a determined user with devtools.)
  assert.equal(txCapUsd('999999'), TXCAP_DEFAULT_USD);
  assert.equal(txCapUsd('501'), TXCAP_DEFAULT_USD);
  assert.equal(txCapUsd(String(Number.MAX_SAFE_INTEGER)), TXCAP_DEFAULT_USD);
});

test('no-limit needs its own sentinel, because numeric coercion must never produce it', () => {
  assert.equal(txCapUsd(TXCAP_UNLIMITED), null);
  // The near misses: each of these is a plausible way a bug reaches this
  // function, and not one of them may be read as "no ceiling".
  for (const nearMiss of ['0', '-1', 'NaN', 'Infinity', 'null', 'undefined', 'false']) {
    assert.notEqual(txCapUsd(nearMiss), null, `${nearMiss} must not mean unlimited`);
  }
});

test('every ladder value round-trips through storage', () => {
  for (const cap of TXCAP_LADDER) {
    assert.equal(txCapUsd(txCapStorageValue(cap)), cap, `${txCapLabel(cap)} must survive a round trip`);
  }
  assert.deepEqual(TXCAP_LADDER, [500, 2000, 10000, null]);
});

test('isRaise fires only on loosening, so tightening never demands a ceremony', () => {
  assert.equal(isRaise(500, 2000), true);
  assert.equal(isRaise(500, null), true, 'removing the ceiling is the biggest raise there is');
  assert.equal(isRaise(2000, 500), false, 'tightening is always allowed');
  assert.equal(isRaise(null, 500), false, 'coming back under a ceiling is tightening');
  assert.equal(isRaise(500, 500), false, 're-picking the same value is not a raise');
  assert.equal(isRaise(null, null), false);
});

test('the gate honours the accepted cap, and defaults strict when not told', () => {
  // A caller that forgets the third argument must get the beta behaviour, not
  // a bypass.
  assert.equal(betaCapError('mainnet', 501), `during the mainnet beta, transactions are capped at $500 each`);
  assert.equal(betaCapError('mainnet', 499), null);

  // Raised ceiling: allowed below, refused above, and the message points at
  // the setting rather than blaming the beta.
  assert.equal(betaCapError('mainnet', 1500, 2000), null);
  assert.match(betaCapError('mainnet', 2500, 2000), /this device's per-transaction limit is \$2,000/);

  // No ceiling.
  assert.equal(betaCapError('mainnet', 1_000_000, null), null);
});

test('a corrupt cap reaching the gate is treated as the default, not as no-limit', () => {
  for (const bad of [NaN, Infinity, -5, 0, 'abc', undefined]) {
    assert.equal(betaCapError('mainnet', 501, bad), `during the mainnet beta, transactions are capped at $500 each`,
      `cap ${String(bad)} must fall back to strict`);
  }
});

test('the cap is mainnet-only, whichever spelling the caller uses', () => {
  for (const net of ['test', 'testnet', 'regtest']) {
    assert.equal(betaCapError(net, 1_000_000, 500), null, `${net} has no beta cap`);
  }
  assert.ok(betaCapError('main', 501, 500), 'the node spelling "main" is still capped');
  assert.ok(betaCapError('mainnet', 501, 500), 'the wallet spelling "mainnet" is still capped');
});

test('an unknowable USD value is still allowed (#54), at every cap setting', () => {
  for (const cap of TXCAP_LADDER) {
    assert.equal(betaCapError('mainnet', null, cap), null, 'no price feed must not block a send');
  }
});

test('the banner states the ceiling actually in force, not the shipped one', () => {
  assert.match(networkChrome('main').banner, /\$500\/tx cap/, 'default is unchanged');
  assert.match(networkChrome('main', 10000).banner, /\$10,000\/tx cap/);
  assert.match(networkChrome('main', null).banner, /NO per-tx limit: you removed it/);
  // A banner that promises $500 to someone running unlimited reads as a
  // guarantee, which is worse than saying nothing.
  assert.doesNotMatch(networkChrome('main', null).banner, /\$500/);
  assert.equal(BETA_TX_CAP_USD, 500);
});

test('raising the cap changes nothing off mainnet', () => {
  assert.equal(networkChrome('test', null).banner, networkChrome('test').banner);
  assert.equal(networkChrome('regtest', 10000).banner, networkChrome('regtest').banner);
});
