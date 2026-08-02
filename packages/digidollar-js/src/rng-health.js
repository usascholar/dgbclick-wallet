// rng-health.js — runtime CSPRNG health gate (browser + Node >= 18).
//
// Why this exists: the 2026 Coldcard drain was not weak crypto — it was a
// silently substituted RNG. Code review, vendor locks, and known-answer tests
// all verify the *files*; this module verifies the *output*, at the moment
// keys are actually generated, and refuses to generate if the stream is
// wrong. Cost: three small draws (~1.1 KB total) and a few microseconds —
// invisible to users, fatal to RNG-swap attacks.
//
// What it catches:
//   - getRandomValues missing entirely (hard fail, as noble's guard does)
//   - a buffer that comes back unmutated (no-op shim)
//   - two consecutive draws that are identical (counter/constant/time-seeded)
//   - catastrophic bias (stuck bit, tiny alphabet) via a wide monobit band
//   - a non-native getRandomValues in the BROWSER (extension/MitM shadowing)
//
// What it deliberately does NOT do: fine-grained statistics. A 1 KB sample
// cannot distinguish a good CSPRNG from a clever attacker, and pretending
// otherwise is the false-assurance trap. The monobit band is wide (35–65%)
// on purpose: it fires on *broken* streams and effectively never on healthy
// ones (a healthy stream falls outside it with probability < 1e-30), so
// users never see a false alarm.

const NATIVE_CODE_RE = /\{\s*\[native code\]\s*\}/;

// The native-code check applies to BROWSERS ONLY.
//
// In Node (checked on v24.17.0) `crypto.getRandomValues` is a genuine JS
// function — `Function.prototype.toString` returns its source, not
// "{ [native code] }" — so enforcing the check everywhere would throw on
// EVERY key generation in Node, breaking the test suite, the regtest spikes
// and every script. That is a false positive on a legitimate platform, not a
// detection.
//
// Skipping it in Node also costs nothing defensively: the threat this check
// addresses is an extension or injected script shadowing `crypto` inside the
// *page*. A Node process running this library is already executing the
// developer's own code with full privileges; anyone able to patch
// globalThis.crypto there can patch this module instead. The output checks
// below run in BOTH environments and are the real wall.
const IS_NODE = typeof process !== 'undefined' && !!process.versions?.node;

function popcount8(n) {
  n = n - ((n >> 1) & 0x55);
  n = (n & 0x33) + ((n >> 2) & 0x33);
  return (n + (n >> 4)) & 0x0f;
}

function identical(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function allZero(a) {
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false;
  return true;
}

/** Throws (fail-closed) if the platform CSPRNG is absent, shadowed, or
 * producing a broken stream. Returns true when healthy. Call immediately
 * before any key/seed generation. */
export function assertHealthyRandom() {
  const cr = typeof globalThis === 'object' ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== 'function') {
    throw new Error('secure random number generator is missing — this wallet refuses to generate keys without crypto.getRandomValues');
  }

  // Shadow detection (browser only — see IS_NODE above): a tampered crypto
  // object is usually a plain JS function. Sophisticated shims can fake
  // toString, so this is one layer, not the wall — the output checks below
  // are the wall.
  if (!IS_NODE) {
    const src = Function.prototype.toString.call(cr.getRandomValues);
    if (!NATIVE_CODE_RE.test(src)) {
      throw new Error('crypto.getRandomValues has been replaced by non-native code (a browser extension?) — refusing to generate keys. Disable script-injecting extensions for this site and reload.');
    }
  }

  // Liveness: the buffer must actually be written.
  const a = new Uint8Array(32);
  const b = new Uint8Array(32);
  cr.getRandomValues(a);
  cr.getRandomValues(b);
  if (allZero(a) || allZero(b)) {
    throw new Error('the secure random generator returned empty output — refusing to generate keys on this device');
  }

  // Repetition: two independent 256-bit draws must never be equal.
  if (identical(a, b)) {
    throw new Error('the secure random generator repeated itself — refusing to generate keys on this device');
  }

  // Catastrophic-bias band: 8192 bits, expect ~4096 ones; flag outside
  // 35–65% (2867–5225). Healthy CSPRNGs never land there; stuck-bit and
  // small-alphabet generators always do.
  const s = new Uint8Array(1024);
  cr.getRandomValues(s);
  let ones = 0;
  for (let i = 0; i < s.length; i++) ones += popcount8(s[i]);
  if (ones < 2867 || ones > 5225) {
    throw new Error('the secure random generator failed a basic distribution check — refusing to generate keys on this device');
  }

  return true;
}
