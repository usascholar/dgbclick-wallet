// Reproduce the entropy audit yourself: node scripts/verify-entropy.mjs
//
// A security claim you cannot check is marketing. This script re-runs the
// checks behind docs/entropy-audit.md against the code in THIS checkout and
// prints what it measured, so the answer comes from your machine rather than
// from our word. Every section says what it proves and what it does not.
//
// Exit code 0 = every check passed. Non-zero = something is wrong; read the
// output, do not generate a wallet from this checkout.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMnemonic, mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS } from 'digidollar-js';
import { assertHealthyRandom } from '../packages/digidollar-js/src/rng-health.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { failed = true; console.log(`  FAIL  ${m}`); };
const head = (n, t) => console.log(`\n${n}. ${t}\n${'-'.repeat(60)}`);

// ---------------------------------------------------------------------------
head(1, 'No Math.random anywhere on the key path');
// Math.random is NOT a CSPRNG. Its presence in key generation is the single
// most common catastrophic wallet bug. We scan the protocol library and the
// browser code it runs inside.
const scanDirs = [
  join(ROOT, 'packages', 'digidollar-js', 'src'),
  join(ROOT, 'apps', 'wallet', 'public'),
];
const hits = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(js|mjs)$/.test(e.name)) continue;
    const src = readFileSync(p, 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      if (line.includes('Math.random')) hits.push(`${p.slice(ROOT.length + 1)}:${i + 1}`);
    });
  }
};
scanDirs.forEach(walk);
// Known, audited, NOT key material: a batch label suffix in the treasury engine.
const allowed = (h) => h.startsWith('apps\\wallet\\public\\treasury-engine.js')
  || h.startsWith('apps/wallet/public/treasury-engine.js');
const badHits = hits.filter((h) => !allowed(h));
if (badHits.length) bad(`Math.random found on a scanned path: ${badHits.join(', ')}`);
else ok(`no Math.random in key/seed code (${hits.length} allowed non-key use(s): batch labels)`);

// ---------------------------------------------------------------------------
head(2, 'The generator refuses to run without a real CSPRNG (fail-closed)');
// This is the failure class that has cost real users real money elsewhere: a
// wallet whose RNG silently falls back to something weak. The correct behaviour
// is to REFUSE, never to degrade. We remove the CSPRNG and try to make a key.
const realCrypto = globalThis.crypto;
const withCrypto = (value, fn) => {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true });
  try { return fn(); } finally {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
  }
};
const refuses = (label, shim) => withCrypto(shim, () => {
  try { generateMnemonic(); bad(`${label}: PRODUCED A KEY (must refuse)`); }
  catch { ok(`${label}: refused`); }
});
refuses('CSPRNG missing entirely', { subtle: realCrypto.subtle });
refuses('CSPRNG throws', { subtle: realCrypto.subtle, getRandomValues() { throw new Error('blocked'); } });
refuses('CSPRNG returns an untouched buffer', { subtle: realCrypto.subtle, getRandomValues: (a) => a });
refuses('CSPRNG returns a constant', { subtle: realCrypto.subtle, getRandomValues: (a) => a.fill(7) });
let n = 0;
refuses('CSPRNG is biased (distinct but low-entropy)', {
  subtle: realCrypto.subtle,
  getRandomValues: (a) => { a.fill(1); a[0] = n++ & 0xff; return a; },
});
try { assertHealthyRandom(); ok('the real platform CSPRNG passes the health gate'); }
catch (e) { bad(`health gate rejects this platform: ${e.message}`); }

// ---------------------------------------------------------------------------
head(3, 'Entropy arithmetic: 128 bits, start to finish');
// 12 words drawn from a 2048-word list carry 12 * log2(2048) = 132 bits, of
// which 4 are a checksum: 128 bits of entropy. Hashing and key stretching
// (PBKDF2) redistribute entropy; they never create it.
const words = generateMnemonic().split(' ');
const rawBits = words.length * Math.log2(2048);
const entropyBits = rawBits - 4;
if (words.length === 12 && entropyBits === 128) ok(`12 words = ${rawBits} bits raw, minus 4 checksum = ${entropyBits} bits entropy`);
else bad(`unexpected mnemonic shape: ${words.length} words, ${entropyBits} bits`);

// ---------------------------------------------------------------------------
head(4, 'Measured output: uniqueness and bit balance over real draws');
// Statistics on a sample cannot prove a CSPRNG is sound (a competent attacker
// can produce a stream that passes). They CAN expose a broken one, which is
// what a repeat, a stuck bit, or a tiny alphabet looks like.
const N = Number(process.env.SAMPLES) || 2000;
const seen = new Set();
let ones = 0, bits = 0, collision = null;
for (let i = 0; i < N; i++) {
  const m = generateMnemonic();
  if (seen.has(m)) { collision = i; break; }
  seen.add(m);
  for (const b of mnemonicToSeed(m).slice(0, 16)) {
    for (let k = 0; k < 8; k++) { ones += (b >> k) & 1; bits++; }
  }
}
const balance = ones / bits;
if (collision !== null) bad(`COLLISION: two identical mnemonics within ${N} draws (at ${collision})`);
else ok(`${seen.size}/${N} mnemonics unique (no repeats)`);
if (balance > 0.48 && balance < 0.52) ok(`seed bit balance ${balance.toFixed(4)} (ideal 0.5)`);
else bad(`seed bit balance ${balance.toFixed(4)} is outside 0.48-0.52`);

// ---------------------------------------------------------------------------
head(5, 'Derivation is deterministic, and distinct seeds give distinct keys');
const m1 = generateMnemonic();
const a1 = deriveTaprootAddress(mnemonicToSeed(m1), { ...HD_NETWORKS.mainnet, index: 0 }).address;
const a2 = deriveTaprootAddress(mnemonicToSeed(m1), { ...HD_NETWORKS.mainnet, index: 0 }).address;
const b1 = deriveTaprootAddress(mnemonicToSeed(generateMnemonic()), { ...HD_NETWORKS.mainnet, index: 0 }).address;
if (a1 === a2) ok('same mnemonic always derives the same key (your backup restores)');
else bad('derivation is not deterministic: a backup would not restore');
if (a1 !== b1) ok('different mnemonics derive different keys');
else bad('two mnemonics collided to one key');

// ---------------------------------------------------------------------------
head(6, 'The code that runs is the code that was checked');
// Integrity: every file the browser executes is hashed in apps/wallet/vendor.lock
// and re-verified at server boot. That is what stops a swapped dependency (or a
// patched key-generation file) from shipping unnoticed.
const lock = JSON.parse(readFileSync(join(ROOT, 'apps', 'wallet', 'vendor.lock'), 'utf8'));
const libFiles = Object.keys(lock).filter((k) => k.startsWith('digidollar-js/'));
const covers = (f) => libFiles.includes(f);
if (covers('digidollar-js/hd.js') && covers('digidollar-js/rng-health.js')) {
  ok(`vendor.lock covers ${Object.keys(lock).length} files, including hd.js and rng-health.js`);
} else {
  bad('vendor.lock does NOT cover the key-generation files');
}
console.log('     (run `npm run vendor:verify` to check those hashes against npm\'s published bytes)');

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failed) {
  console.log('RESULT: FAILED. Do not generate a wallet from this checkout.');
  process.exit(1);
}
console.log('RESULT: all checks passed on this machine.');
console.log('\nWhat this does NOT prove: that your operating system\'s CSPRNG is itself');
console.log('sound. No in-page or in-process check can verify that. It is the trust');
console.log('boundary every software wallet stands on.');
