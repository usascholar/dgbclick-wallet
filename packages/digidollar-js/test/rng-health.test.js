// The RNG health gate (rng-health.js): it must PASS on a healthy platform
// CSPRNG and THROW on every broken-stream shape, because the thing it guards
// is the single choke point every wallet, treasury and gift key is born
// through. A gate that fails open is worse than no gate: it advertises a
// protection that isn't there.
//
// Each test swaps globalThis.crypto for a shim, then restores it in a finally
// so a failure cannot leak a broken RNG into the rest of the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertHealthyRandom } from '../src/rng-health.js';
import { generateMnemonic } from '../src/index.js';

/** Run `fn` with globalThis.crypto.getRandomValues replaced by `impl`. */
function withRandom(impl, fn) {
  const real = globalThis.crypto;
  const shim = { subtle: real.subtle, getRandomValues: impl };
  Object.defineProperty(globalThis, 'crypto', { value: shim, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
}

test('healthy platform CSPRNG passes', () => {
  assert.equal(assertHealthyRandom(), true);
});

test('the gate is wired into generateMnemonic (the single keygen choke point)', () => {
  // sanity: real generation still works…
  assert.equal(generateMnemonic().split(' ').length, 12);
  // …and a broken RNG stops it, proving the gate is actually on this path
  withRandom((a) => a, () => {
    assert.throws(() => generateMnemonic(), /refuses to generate keys|empty output/i);
  });
});

test('no-op shim (buffer never written) throws', () => {
  withRandom((a) => a, () => {
    assert.throws(() => assertHealthyRandom(), /empty output/i);
  });
});

test('all-zero stream throws', () => {
  withRandom((a) => a.fill(0), () => {
    assert.throws(() => assertHealthyRandom(), /empty output/i);
  });
});

test('constant non-zero stream (identical draws) throws', () => {
  withRandom((a) => a.fill(7), () => {
    assert.throws(() => assertHealthyRandom(), /repeated itself/i);
  });
});

test('counter-seeded stream (distinct draws, catastrophic bias) throws', () => {
  // Distinct every call, so the repetition check passes — but every byte is
  // 0x01, so the monobit count (1024 ones of 8192) is far below the band.
  let n = 0;
  withRandom((a) => {
    a.fill(1);
    a[0] = n++ & 0xff; // make consecutive draws differ
    return a;
  }, () => {
    assert.throws(() => assertHealthyRandom(), /distribution check/i);
  });
});

test('stuck-high stream (all bits set) throws the distribution check', () => {
  let n = 0;
  withRandom((a) => {
    a.fill(0xff);
    a[0] = n++ & 0xff;
    return a;
  }, () => {
    assert.throws(() => assertHealthyRandom(), /distribution check/i);
  });
});

test('a throwing getRandomValues propagates (fail-closed, not swallowed)', () => {
  withRandom(() => { throw new Error('blocked by policy'); }, () => {
    assert.throws(() => assertHealthyRandom(), /blocked by policy/);
  });
});

test('missing getRandomValues entirely throws the refusal', () => {
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: { subtle: real.subtle }, configurable: true });
  try {
    assert.throws(() => assertHealthyRandom(), /refuses to generate keys without crypto\.getRandomValues/i);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});

test('the native-code check does NOT false-fire in Node (regression guard)', () => {
  // Node's crypto.getRandomValues is a real JS function, so Function.prototype
  // .toString does NOT return "{ [native code] }". Enforcing that check outside
  // browsers would throw on EVERY key generation in Node and break the suite,
  // the regtest spikes and every script. The check is browser-scoped for
  // exactly this reason; this test pins that behavior.
  const src = Function.prototype.toString.call(globalThis.crypto.getRandomValues);
  assert.ok(!/\{\s*\[native code\]\s*\}/.test(src), 'precondition: Node getRandomValues is not native-code');
  assert.equal(assertHealthyRandom(), true, 'gate must still pass in Node');
});
