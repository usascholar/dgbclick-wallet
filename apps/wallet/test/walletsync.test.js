// Wallet-sync helpers: the pure logic extracted from app.js (which is DOM-
// bound and cannot be imported here). Covers the three review fixes: the
// outpoint dedupe behind spendableUtxos, the descriptor fingerprint behind
// the chain-used cache, and the address set behind Activity classification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a, extraSourcesFingerprint, myAddressSet, dedupeUtxos } from '../public/walletsync.js';

// descriptorKeySource output shape (packages/digidollar-js hd.js), trimmed to
// the fields the fingerprint reads.
const src = (extendedKey, relPath = '0/*', kind = 'tr') =>
  ({ __descriptor: true, kind, extendedKey, relPath, origin: null, hasWildcard: true });

test('fnv1a matches the published basis for an empty string', () => {
  assert.equal(fnv1a(''), '811c9dc5'); // the FNV offset basis, unmixed
  assert.equal(fnv1a('a').length, 8, 'zero-padded 32-bit hex');
  assert.equal(fnv1a('diginaut'), fnv1a('diginaut'), 'deterministic');
});

test('dedupeUtxos keeps a duplicated outpoint exactly once — first wins', () => {
  // the regression: two descriptor sources resolving to the same chain read
  // the same coin under two addresses; spendableUtxos flattened both copies
  // and planSpend could build a duplicate-input transaction
  const a = { txidHex: 'aa'.repeat(32), vout: 0, valueSats: 100n, privKeyHex: 'k1' };
  const b = { txidHex: 'bb'.repeat(32), vout: 1, valueSats: 200n, privKeyHex: 'k2' };
  const dup = { ...a, privKeyHex: 'k1-again' };
  const out = dedupeUtxos([a, dup, b]);
  assert.equal(out.length, 2, 'duplicate outpoint collapsed');
  assert.equal(out[0].privKeyHex, 'k1', 'the first copy survives');
  assert.deepEqual(out.map((u) => u.txidHex), [a.txidHex, b.txidHex], 'order preserved');
});

test('dedupeUtxos keys both the indexer shape and the spend-plan shape', () => {
  const indexerShape = { txid: 'cc'.repeat(32), vout: 3, valueSats: '5', height: 100 };
  const planShape = { txidHex: 'cc'.repeat(32), vout: 3, valueSats: 5n, privKeyHex: 'k' };
  assert.equal(dedupeUtxos([indexerShape, planShape]).length, 1, 'same coin across shapes dedupes');
  // same txid, different vout: two different coins, both kept
  assert.equal(dedupeUtxos([indexerShape, { ...planShape, vout: 4 }]).length, 2);
});

test('the fingerprint is stable across a re-parse of the same descriptors', () => {
  const walletA = () => [src('dgpv51e1fa', '0/*'), src('dgpv51e1fa', '1/*'), src('dgpv9b2c3d', '0/*', 'wpkh')];
  assert.equal(extraSourcesFingerprint(walletA()), extraSourcesFingerprint(walletA()));
});

test('a different wallet under the same cache id fails the fingerprint check', () => {
  // the regression: wallet.id is `w<Date.now>` — a remove + same-ms reimport
  // (or clock rollback) reuses the id, and the loader used to trust the cached
  // used-index set of what is now a DIFFERENT wallet, skipping discovery.
  // The app.js gate is `cached?.fp === fp` — this pins the mismatch it relies
  // on, so the cache is ignored and a full walk runs from zero.
  const original = [src('dgpvAAA', '0/*'), src('dgpvAAA', '1/*')];
  const reimported = [src('dgpvBBB', '0/*'), src('dgpvBBB', '1/*')]; // same shape, different keys
  assert.notEqual(extraSourcesFingerprint(original), extraSourcesFingerprint(reimported));
  // …and a structural change (chain added/removed) mismatches too
  assert.notEqual(
    extraSourcesFingerprint(original),
    extraSourcesFingerprint([...original, src('dgpvCCC', '0/*', 'wpkh')]));
});

test('myAddressSet marks extra-chain receipts as mine on a CACHED-extra cycle', () => {
  // the regression: on poll cycles that skip the extra-chain re-read, the
  // fetch list holds only primary addresses while addrMeta still carries the
  // cached extras — building the set from the fetch list misclassified every
  // extra-chain receipt (blank amounts, self-sends labeled "Sent").
  const primaryMeta = [
    { address: 'dgb1qPRIMARY', dd: true, index: 0 },
    { address: 'dgb1qTWIN', dd: false, index: 0 },
  ];
  const cachedExtraMeta = [
    { address: 'DGB1QCORECHAIN', dd: true, index: -1, src: 1, idx: 12 }, // mixed case on purpose
  ];
  // what the cached-extra cycle hands the classifier: primary + cached extras
  const addrMeta = [...primaryMeta, ...cachedExtraMeta];
  const set = myAddressSet(addrMeta);
  const isMine = (a) => set.has(a.toLowerCase());
  assert.equal(isMine('dgb1qcorechain'), true, 'extra-chain address is mine (case-insensitive)');
  assert.equal(isMine('dgb1qprimary'), true);
  assert.equal(isMine('dgb1qsomeoneelse'), false);
});

test('myAddressSet matches the fresh-cycle fetch list too', () => {
  const fresh = [
    { address: 'dgb1qprimary', dd: true, index: 0 },
    { address: 'dgb1qextra', dd: true, index: -1, src: 0, idx: 3 },
  ];
  assert.deepEqual([...myAddressSet(fresh)], ['dgb1qprimary', 'dgb1qextra']);
  assert.deepEqual([...myAddressSet([])], [], 'no wallet → empty set, nothing is mine');
});
