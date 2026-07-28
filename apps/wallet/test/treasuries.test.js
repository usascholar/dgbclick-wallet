// Treasury registry: pure naming/slug/status helpers + the injected-storage
// metadata bookkeeper. Storage here is a synchronous Map stand-in with the
// localStorage surface, so the persistence tests exercise exactly what the
// browser writes — including the corrupt-JSON boot path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TREASURY_STORE_KEY, ITEM_STATES, CARD_STATUSES, UNLOCKING_SOON_BLOCKS,
  seqLetters, treasuryName, treasurySlug, parseTreasuryName, newBatchId,
  matchesTreasury, cardStatus, ddIntact, collateralHealth, buildReceipt,
  createTreasuryRegistry,
} from '../public/treasuries.js';

function memStorage() {
  const db = new Map();
  return {
    db,
    getItem: (k) => (db.has(k) ? db.get(k) : null),
    setItem: (k, v) => { db.set(k, String(v)); },
    removeItem: (k) => { db.delete(k); },
  };
}

// A fully-populated FR-6 meta, canonical cents storage.
function sampleMeta(overrides = {}) {
  return {
    walletId: 'w1',
    name: 'DD100-2036-07-21-A',
    slug: 'dd100-2036-07-21-a',
    alias: '',
    batchId: 'split-2026-07-26-001',
    createdAt: '2026-07-26T13:00:00.000Z',
    mint: {
      ddCents: 10_000,
      lockTierYears: 10,
      collateralSats: '8000000000000',
      oraclePriceAtMint: 0.0025,
      unlockHeight: 1_000_000,
      unlockDateEstimate: '2036-07-21',
      positionTxid: 'abc123txid',
    },
    ddMovedWarning: null,
    transferredOut: false,
    ...overrides,
  };
}

test('exported constants match the spec surface', () => {
  assert.equal(TREASURY_STORE_KEY, 'diginaut.treasuries.v1');
  assert.deepEqual(ITEM_STATES, ['pending', 'created', 'funded', 'minted', 'done']);
  assert.deepEqual(CARD_STATUSES, ['funded', 'locked', 'unlocking-soon', 'mature', 'redeemed', 'transferred-out']);
  assert.equal(UNLOCKING_SOON_BLOCKS, 518_400);
});

test('seqLetters is spreadsheet-style and rejects bad indices', () => {
  assert.equal(seqLetters(0), 'A');
  assert.equal(seqLetters(25), 'Z');
  assert.equal(seqLetters(26), 'AA');
  assert.equal(seqLetters(27), 'AB');
  assert.equal(seqLetters(51), 'AZ');
  assert.equal(seqLetters(52), 'BA');
  assert.throws(() => seqLetters(-1), /non-negative integer/);
  assert.throws(() => seqLetters(1.5), /non-negative integer/);
  assert.throws(() => seqLetters(NaN), /non-negative integer/);
});

test('treasuryName builds the canonical name and validates its parts', () => {
  assert.equal(treasuryName({ ddAmount: 100, unlockDate: '2036-07-21', seq: 0 }), 'DD100-2036-07-21-A');
  assert.equal(treasuryName({ ddAmount: 250, unlockDate: '2031-07-21', seq: 2 }), 'DD250-2031-07-21-C');
  assert.throws(() => treasuryName({ ddAmount: 0, unlockDate: '2036-07-21', seq: 0 }), /positive integer/);
  assert.throws(() => treasuryName({ ddAmount: 99.5, unlockDate: '2036-07-21', seq: 0 }), /positive integer/);
  assert.throws(() => treasuryName({ ddAmount: 100, unlockDate: '21 Jul 2036', seq: 0 }), /YYYY-MM-DD/);
  assert.throws(() => treasuryName({ ddAmount: 100, unlockDate: '2036-7-21', seq: 0 }), /YYYY-MM-DD/);
});

test('treasurySlug lowercases the canonical prefix, alias tolerated', () => {
  assert.equal(treasurySlug('DD100-2036-07-21-A'), 'dd100-2036-07-21-a');
  assert.equal(treasurySlug('DD250-2031-07-21-C – Mum\'s gift'), 'dd250-2031-07-21-c');
  // an alias-only name has no slug of its own — the stored slug must be used
  assert.throws(() => treasurySlug('Mum\'s gift'), /no canonical treasury prefix/);
  assert.throws(() => treasurySlug(''), /no canonical treasury prefix/);
});

test('parseTreasuryName round-trips treasuryName, null on non-conforming', () => {
  const name = treasuryName({ ddAmount: 100, unlockDate: '2036-07-21', seq: 0 });
  assert.deepEqual(parseTreasuryName(name), { ddAmount: 100, unlockDate: '2036-07-21', seq: 'A' });
  // alias suffix is display-only sugar; the structured parts still parse
  assert.deepEqual(parseTreasuryName('DD250-2031-07-21-C – Mum\'s gift'), {
    ddAmount: 250, unlockDate: '2031-07-21', seq: 'C',
  });
  assert.equal(parseTreasuryName('Mum\'s gift'), null);
  assert.equal(parseTreasuryName('random text'), null);
  assert.equal(parseTreasuryName(null), null);
});

test('newBatchId increments within a day and ignores other days', () => {
  const day = new Date('2026-07-26T13:00:00Z');
  assert.equal(newBatchId([], day), 'split-2026-07-26-001');
  assert.equal(newBatchId(['split-2026-07-26-001'], day), 'split-2026-07-26-002');
  assert.equal(newBatchId(['split-2026-07-26-001', 'split-2026-07-26-002'], day), 'split-2026-07-26-003');
  assert.equal(newBatchId(['split-2026-07-25-009'], day), 'split-2026-07-26-001');
});

test('matchesTreasury searches name, slug, alias, year, amount and batch id', () => {
  const a = sampleMeta();
  const b = sampleMeta({
    walletId: 'w2',
    name: 'DD250-2031-07-21-C – Mum\'s gift',
    slug: 'dd250-2031-07-21-c',
    alias: 'Mum\'s gift',
    batchId: 'split-2026-07-26-002',
    mint: { ...sampleMeta().mint, ddCents: 25_000, unlockDateEstimate: '2031-07-21' },
  });
  assert.equal(matchesTreasury('', a), true);
  assert.equal(matchesTreasury('   ', a), true);
  assert.equal(matchesTreasury('2036', a), true);
  assert.equal(matchesTreasury('2036', b), false);
  assert.equal(matchesTreasury('dd250', b), true);
  assert.equal(matchesTreasury('DD250', b), true, 'case-insensitive');
  assert.equal(matchesTreasury('dd250', a), false);
  assert.equal(matchesTreasury('250', b), true, 'bare dollar amount matches');
  assert.equal(matchesTreasury('mum', b), true, 'alias');
  assert.equal(matchesTreasury('mum', a), false);
  assert.equal(matchesTreasury('split-2026-07-26-002', b), true, 'batch id');
  assert.equal(matchesTreasury('nope', a), false);
});

test('cardStatus applies the six statuses in priority order', () => {
  const meta = sampleMeta();
  // transferred-out wins over everything, even with a live position
  assert.equal(cardStatus({ ...meta, transferredOut: { at: '2026-07-26T14:00:00Z' } },
    { tipHeight: 2_000_000, positionOpen: true }), 'transferred-out');
  // no position yet → funded
  assert.equal(cardStatus({ ...meta, mint: { ...meta.mint, positionTxid: null } },
    { tipHeight: 0, positionOpen: false }), 'funded');
  // indexer stopped returning the position → collateral was spent → redeemed,
  // even when the lock height is already past
  assert.equal(cardStatus(meta, { tipHeight: 2_000_000, positionOpen: false }), 'redeemed');
  assert.equal(cardStatus(meta, { tipHeight: 0, positionOpen: false }), 'redeemed');
  // lock expired → mature
  assert.equal(cardStatus(meta, { tipHeight: 1_000_000, positionOpen: true }), 'mature');
  // boundary: exactly UNLOCKING_SOON_BLOCKS away → unlocking-soon; one more → locked
  assert.equal(cardStatus(meta, { tipHeight: 1_000_000 - UNLOCKING_SOON_BLOCKS, positionOpen: true }), 'unlocking-soon');
  assert.equal(cardStatus(meta, { tipHeight: 1_000_000 - UNLOCKING_SOON_BLOCKS - 1, positionOpen: true }), 'locked');
});

test('ddIntact compares BigInt-safely against the minted cents', () => {
  const meta = sampleMeta(); // minted 10_000 cents ($100)
  assert.equal(ddIntact(meta, '10000'), true, 'exactly equal is intact');
  assert.equal(ddIntact(meta, 10_000n), true, 'bigint held amount');
  assert.equal(ddIntact(meta, '9999'), false, 'one cent short breaks it');
  assert.equal(ddIntact(meta, '10001'), true, 'more than minted is intact');
  // legacy FR-6 dollars shape is accepted too
  const legacy = sampleMeta({ mint: { ...sampleMeta().mint, ddCents: undefined, ddAmount: 100 } });
  assert.equal(ddIntact(legacy, '10000'), true);
  assert.equal(ddIntact(legacy, '9999'), false);
  assert.equal(ddIntact({ mint: null }, '10000'), false);
  assert.equal(ddIntact(meta, 'not-a-number'), false);
});

test('collateralHealth tiers the ratio and reports unknown price honestly', () => {
  // $0.0025/DGB; $100 DD liability; 80,000 DGB collateral = $200 → 200%
  const price = '2500';
  assert.deepEqual(collateralHealth({ collateralSats: '8000000000000', ddCents: '10000', priceMicroUsd: price }),
    { ratioPercent: 200.0, level: 'good' });
  assert.deepEqual(collateralHealth({ collateralSats: '6000000000000', ddCents: '10000', priceMicroUsd: price }),
    { ratioPercent: 150.0, level: 'warn' });
  assert.deepEqual(collateralHealth({ collateralSats: '4000000000000', ddCents: '10000', priceMicroUsd: price }),
    { ratioPercent: 100.0, level: 'bad' });
  // one-decimal rounding (150.15% → 150.2)
  assert.deepEqual(collateralHealth({ collateralSats: '6006000000000', ddCents: '10000', priceMicroUsd: price }),
    { ratioPercent: 150.2, level: 'warn' });
  // tier boundaries: 200 → good, 130 → warn, 129.9 → bad
  assert.equal(collateralHealth({ collateralSats: '5200000000000', ddCents: '10000', priceMicroUsd: price }).level, 'warn');
  assert.equal(collateralHealth({ collateralSats: '5196000000000', ddCents: '10000', priceMicroUsd: price }).level, 'bad');
  // unavailable price is 'unknown', not a scare
  assert.deepEqual(collateralHealth({ collateralSats: '8000000000000', ddCents: '10000', priceMicroUsd: null }),
    { ratioPercent: null, level: 'unknown' });
  assert.deepEqual(collateralHealth({ collateralSats: '8000000000000', ddCents: '10000', priceMicroUsd: '0' }),
    { ratioPercent: null, level: 'unknown' });
  assert.deepEqual(collateralHealth({ collateralSats: 'junk', ddCents: '10000', priceMicroUsd: price }),
    { ratioPercent: null, level: 'unknown' });
});

test('buildReceipt carries the handover facts and the honesty warning', () => {
  const meta = sampleMeta();
  const receipt = buildReceipt(meta, { explorerTxUrl: 'https://digiexplorer.info/tx/', network: 'mainnet' });
  assert.match(receipt, /DD100-2036-07-21-A/);
  assert.match(receipt, /\$100 DigiDollar/);
  assert.match(receipt, /80,000 DGB/);
  assert.match(receipt, /2036-07-21/);
  assert.match(receipt, /abc123txid/);
  assert.match(receipt, /mainnet/);
  assert.match(receipt, /https:\/\/digiexplorer\.info\/tx\/abc123txid/);
  assert.match(receipt, /wallet\.dgbclick\.com/);
  assert.match(receipt, /Restore from backup file/);
  assert.match(receipt, /transfer passphrase/);
  assert.match(receipt, /not trustless/);
  assert.match(receipt, /kept a copy of the backup words/);

  const bare = buildReceipt(meta);
  assert.match(bare, /any DigiByte explorer/);

  // receipts are public artifacts — nothing that even looks like a wordlist
  for (const r of [receipt, bare]) {
    assert.equal(/(?:\b[a-z]+\b +){11}\b[a-z]+\b/.test(r), false, 'no 12-lowercase-word sequence');
    assert.equal(r.includes('mnemonic'), false);
    assert.equal(r.includes('private key'), false);
  }
});

test('registry CRUD persists immediately and derives the slug', () => {
  const storage = memStorage();
  const reg = createTreasuryRegistry(storage);

  const put = reg.putTreasury({ walletId: 'w1', name: 'DD100-2036-07-21-A', mint: sampleMeta().mint });
  assert.equal(put.slug, 'dd100-2036-07-21-a', 'slug derived from the name');
  assert.equal(put.alias, '');
  assert.equal(put.transferredOut, false);
  assert.ok(storage.db.has(TREASURY_STORE_KEY), 'write persisted');

  // alias-only display names must carry an explicit slug
  reg.putTreasury({
    walletId: 'w2', name: 'Mum\'s gift', slug: 'dd250-2031-07-21-c', alias: 'Mum\'s gift',
    mint: { ...sampleMeta().mint, ddCents: 25_000 },
  });
  assert.throws(() => reg.putTreasury({ walletId: 'w3', name: 'Gift' }), /no canonical treasury prefix/);
  assert.throws(() => reg.putTreasury({ name: 'DD100-2036-07-21-A' }), /walletId/);
  assert.throws(() => reg.putTreasury({ walletId: 'w4', name: '  ' }), /name/);

  assert.deepEqual(reg.listTreasuries().map((t) => t.walletId), ['w1', 'w2'], 'insertion order');
  assert.equal(reg.getTreasury('w1').slug, 'dd100-2036-07-21-a');
  assert.equal(reg.getTreasury('nope'), null);

  // a cold registry over the same storage sees everything (immediate persist)
  assert.equal(createTreasuryRegistry(storage).listTreasuries().length, 2);
});

test('updateTreasury shallow-merges and throws on unknown id', () => {
  const reg = createTreasuryRegistry(memStorage());
  reg.putTreasury(sampleMeta());

  const updated = reg.updateTreasury('w1', { alias: 'Holiday fund' });
  assert.equal(updated.alias, 'Holiday fund');
  assert.equal(updated.name, 'DD100-2036-07-21-A', 'untouched fields survive');
  assert.equal(updated.mint.ddCents, 10_000, 'top-level merge leaves nested objects alone');
  assert.throws(() => reg.updateTreasury('w-nope', { alias: 'x' }), /unknown treasury/);

  // FR-4 override log is plain metadata
  reg.updateTreasury('w1', { ddMovedWarning: { at: '2026-07-26T15:00:00Z', acknowledged: true } });
  assert.equal(reg.getTreasury('w1').ddMovedWarning.acknowledged, true);
});

test('markTransferredOut and removeTreasuryRecord bookkeep without the vault', () => {
  const reg = createTreasuryRegistry(memStorage());
  reg.putTreasury(sampleMeta());

  const out = reg.markTransferredOut('w1');
  assert.ok(out.transferredOut.at, 'timestamp recorded');
  assert.equal(typeof out.transferredOut.at, 'string');
  assert.throws(() => reg.markTransferredOut('w-nope'), /unknown treasury/);

  reg.removeTreasuryRecord('w1');
  assert.equal(reg.getTreasury('w1'), null);
  assert.equal(reg.listTreasuries().length, 0);
});

test('batch records round-trip for FR-1 resume', () => {
  const reg = createTreasuryRegistry(memStorage());
  const batch = {
    batchId: 'split-2026-07-26-001',
    createdAt: '2026-07-26T13:00:00Z',
    funderWalletId: 'w0',
    ddCentsEach: 10_000,
    tierId: 'y10',
    feeReserveSats: '50000000',
    needSats: '8005000000000',
    unlockDate: '2036-07-21',
    state: 'running',
    items: [
      { seq: 0, name: 'DD100-2036-07-21-A', slug: 'dd100-2036-07-21-a', state: 'done', walletId: 'w1', fundTxid: 'f1', positionTxid: 'p1' },
      { seq: 1, name: 'DD100-2036-07-21-B', slug: 'dd100-2036-07-21-b', state: 'funded', walletId: 'w2', fundTxid: 'f2', positionTxid: null },
      { seq: 2, name: 'DD100-2036-07-21-C', slug: 'dd100-2036-07-21-c', state: 'pending', walletId: null, fundTxid: null, positionTxid: null },
    ],
  };
  reg.saveBatch(batch);
  assert.throws(() => reg.saveBatch({ state: 'running' }), /batchId/);

  const got = reg.getBatch('split-2026-07-26-001');
  assert.equal(got.items.length, 3);
  assert.equal(got.items[1].state, 'funded');
  assert.equal(reg.getBatch('nope'), null);
  assert.equal(reg.listBatches().length, 1);

  // resume: mark the funded item minted without losing the rest
  const items = got.items.map((it) => (it.seq === 1 ? { ...it, state: 'minted', positionTxid: 'p2' } : it));
  const patched = reg.updateBatch('split-2026-07-26-001', { items, state: 'running' });
  assert.equal(patched.items[1].positionTxid, 'p2');
  assert.equal(patched.items[0].state, 'done', 'siblings untouched');
  assert.throws(() => reg.updateBatch('nope', {}), /unknown batch/);

  reg.updateBatch('split-2026-07-26-001', { state: 'done' });
  assert.equal(reg.getBatch('split-2026-07-26-001').state, 'done');
});

test('corrupt or missing store reads as empty — boot never crashes', () => {
  const storage = memStorage();
  const reg = createTreasuryRegistry(storage);
  assert.deepEqual(reg.listTreasuries(), [], 'absent key');
  assert.equal(reg.getBatch('x'), null);

  storage.setItem(TREASURY_STORE_KEY, '{{{not json');
  assert.deepEqual(reg.listTreasuries(), [], 'corrupt JSON');
  assert.deepEqual(reg.listBatches(), []);

  storage.setItem(TREASURY_STORE_KEY, '42');
  assert.deepEqual(reg.listTreasuries(), [], 'valid JSON, wrong shape');

  storage.setItem(TREASURY_STORE_KEY, JSON.stringify({ v: 1, treasuries: 'junk', batches: null }));
  assert.deepEqual(reg.listTreasuries(), [], 'junk subdocuments');

  // recovery: the registry is writable again over the corruption
  reg.putTreasury(sampleMeta());
  assert.equal(reg.listTreasuries().length, 1);
});
