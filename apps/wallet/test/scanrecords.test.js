// F3 client contract (apps/wallet/public/scanrecords.js): an incomplete scan
// is "unknown", never "empty" — the display serves the address's LAST GOOD
// record, so a hot indexer scan can never blank a balance or make an open
// position vanish ("No open positions" rebuilds the redeem flow's inputs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordFromBulkEntry } from '../public/scanrecords.js';

const TXID = 'ab'.repeat(32);
const goodUtxo = { txid: TXID, vout: 0, valueSats: '123456789', height: 812_345 };
const goodPosition = {
  txid: TXID, ddCents: '100000', collateralSats: '250000000', unlockHeight: 900_000, tierLabel: '1 year · 2×',
};
const ddEntry = {
  utxos: [goodUtxo],
  history: [{ txid: TXID, height: 812_345 }],
  positions: [goodPosition],
  ddUtxos: [{ txid: TXID, vout: 1, cents: '50000', height: 812_345 }],
  ddTotalCents: '50000',
};

test('a complete entry assembles the record and updates the last-good cache', () => {
  const cache = new Map();
  const rec = recordFromBulkEntry({ entry: ddEntry, address: 'dgbt1qxyz', dd: true, tipHeight: 812_000, cache });
  assert.equal(rec.utxos.length, 1);
  assert.equal(rec.history.length, 1);
  assert.equal(rec.positions.positions.length, 1);
  assert.equal(rec.ddCents, 50000n);
  assert.equal(cache.get('dgbt1qxyz'), rec, 'the assembled record is cached for later substitution');
});

test('an incomplete entry serves the LAST GOOD record — balance and positions never clear', () => {
  const cache = new Map();
  const shown = recordFromBulkEntry({ entry: ddEntry, address: 'dgbt1qxyz', dd: true, tipHeight: 812_000, cache });
  const rec = recordFromBulkEntry({
    entry: { complete: false, reason: 'calls' }, address: 'dgbt1qxyz', dd: true, tipHeight: 812_000, cache,
  });
  assert.equal(rec, shown, 'the exact last-good record stays on screen');
  assert.equal(rec.utxos.length, 1, 'the shown balance survives');
  assert.equal(rec.positions.positions.length, 1, 'the open position survives — never "No open positions"');
  assert.equal(rec.ddCents, 50000n, 'the DD balance survives');
});

test('an incomplete entry with NO last-good record throws — the refresh keeps its previous screen', () => {
  assert.throws(
    () => recordFromBulkEntry({ entry: { complete: false, reason: 'calls' }, address: 'dgbt1qnew', dd: true, tipHeight: 0, cache: new Map() }),
    /still scanning/,
  );
});

test('a missing/failed entry throws, exactly as before F3', () => {
  assert.throws(() => recordFromBulkEntry({ entry: { error: 'boom' }, address: 'a', dd: false, tipHeight: 0, cache: new Map() }), /could not answer/);
  assert.throws(() => recordFromBulkEntry({ entry: undefined, address: 'a', dd: false, tipHeight: 0, cache: new Map() }), /could not answer/);
});

test('an incomplete marker that still carries a money array is refused even with a cache present', () => {
  const cache = new Map([['dgbt1qxyz', { sentinel: true }]]);
  assert.throws(
    () => recordFromBulkEntry({ entry: { complete: false, reason: 'calls', positions: [] }, address: 'dgbt1qxyz', dd: true, tipHeight: 0, cache }),
    /malformed scan-status/,
  );
});

test('a plain (non-DD) address assembles with empty positions and zero DD', () => {
  const rec = recordFromBulkEntry({
    entry: { utxos: [goodUtxo], history: [] }, address: 'dgbt1qplain', dd: false, tipHeight: 0, cache: new Map(),
  });
  assert.deepEqual(rec.positions, { address: 'dgbt1qplain', positions: [], tipHeight: 0 });
  assert.equal(rec.ddCents, 0n);
});
