import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateUtxos, validateDdUtxos, validatePositions, validateHistory, validateTxDetail,
  validateDirectory, asIncomplete,
} from '../public/validate.js';

// The indexer may be a third-party service: its JSON is untrusted input at the
// signing boundary. STRICT validators (utxos, dd-utxos, positions — everything
// feeding transaction building) throw on ONE malformed entry: a wrong balance
// shown honestly as an error beats silently signing against poisoned inputs.
// TOLERANT validators (history, tx detail — display only) drop the bad entries
// and keep the rest.

const TXID = 'ab'.repeat(32);
const TXID2 = 'cd'.repeat(32);
const MAX_MONEY_SATS = (21_000_000_000n * 100_000_000n).toString();

const goodUtxo = { txid: TXID, vout: 0, valueSats: '123456789', height: 812_345 };
const goodDdUtxo = { txid: TXID, vout: 1, cents: '50000', height: 0 };
const goodPosition = {
  txid: TXID, ddCents: '100000', collateralSats: '250000000', unlockHeight: 900_000, tierLabel: '1 year · 2×',
};

// ---- happy paths (also: outputs are fresh copies, never the input) ----

test('validateUtxos: happy path, sanitized copies', () => {
  const input = { utxos: [goodUtxo, { ...goodUtxo, txid: TXID2, height: 0 }] };
  const out = validateUtxos(input);
  assert.deepEqual(out, input);
  assert.notEqual(out, input);
  assert.notEqual(out.utxos, input.utxos);
  assert.notEqual(out.utxos[0], input.utxos[0]);
  assert.equal(Object.getPrototypeOf(out.utxos[0]), Object.prototype);
});

test('validateDdUtxos: happy path including totalCents', () => {
  const out = validateDdUtxos({ utxos: [goodDdUtxo], totalCents: '50000' });
  assert.deepEqual(out, { utxos: [goodDdUtxo], totalCents: '50000' });
});

test('validatePositions: happy path including address and tipHeight', () => {
  const input = { address: 'dgbt1qxyz', positions: [goodPosition], tipHeight: 812_000 };
  const out = validatePositions(input);
  assert.deepEqual(out, input);
  assert.notEqual(out.positions[0], input.positions[0]);
});

test('validateHistory: happy path', () => {
  const out = validateHistory({ history: [{ txid: TXID, height: 0 }, { txid: TXID2, height: 812_345 }] });
  assert.deepEqual(out.history.length, 2);
});

test('validateTxDetail: happy path keeps vin/vout rows and coerces scalars', () => {
  const out = validateTxDetail({
    vin: [{ address: 'dgbt1qin', valueSats: '100' }],
    vout: [{ address: 'dgbt1qout', valueSats: '95' }],
    confirmations: 3,
    time: 1_750_000_000,
    feeSats: '500',
    type: 'mint',
  });
  assert.deepEqual(out.vin, [{ address: 'dgbt1qin', valueSats: '100' }]);
  assert.equal(out.confirmations, 3);
  assert.equal(out.time, 1_750_000_000);
  assert.equal(out.feeSats, '500');
  assert.equal(out.type, 'mint');
});

// ---- STRICT: one malformed entry throws, naming the data kind ----

test('validateUtxos throws on a negative-looking value, 66-char txid, float vout', () => {
  assert.throws(() => validateUtxos({ utxos: [{ ...goodUtxo, valueSats: '-5' }] }), /malformed utxo data/);
  assert.throws(() => validateUtxos({ utxos: [{ ...goodUtxo, txid: TXID + 'ab' }] }), /malformed utxo data/);
  assert.throws(() => validateUtxos({ utxos: [{ ...goodUtxo, vout: 0.5 }] }), /malformed utxo data/);
  assert.throws(() => validateUtxos({ utxos: [{ ...goodUtxo, height: -1 }] }), /malformed utxo data/);
});

test('validateUtxos throws on valueSats above MAX_MONEY or not a string', () => {
  const overMax = (21_000_000_000n * 100_000_000n + 1n).toString();
  assert.throws(() => validateUtxos({ utxos: [{ ...goodUtxo, valueSats: overMax }] }), /refusing to use it/);
  assert.equal(validateUtxos({ utxos: [{ ...goodUtxo, valueSats: MAX_MONEY_SATS }] }).utxos[0].valueSats, MAX_MONEY_SATS);
  // a NUMBER where the decimal-string contract expects a string is poison too —
  // a JS number can carry exponent notation into BigInt() later
  assert.throws(() => validateUtxos({ utxos: [{ ...goodUtxo, valueSats: 123 }] }), /malformed utxo data/);
});

test('validateUtxos throws on a non-object payload or a missing utxos array', () => {
  for (const bad of [null, undefined, 'x', 42, [], { }, { utxos: 'nope' }]) {
    assert.throws(() => validateUtxos(bad), /malformed utxo data/, String(bad));
  }
});

test('validateDdUtxos throws on bad cents or a bad totalCents', () => {
  assert.throws(() => validateDdUtxos({ utxos: [{ ...goodDdUtxo, cents: '1e6' }], totalCents: '0' }), /malformed dd-utxo/);
  assert.throws(() => validateDdUtxos({ utxos: [], totalCents: (10n ** 15n + 1n).toString() }), /malformed dd-utxo/);
  assert.throws(() => validateDdUtxos({ utxos: [goodDdUtxo] }), /malformed dd-utxo/); // totalCents missing
});

test('validatePositions throws on bad amounts, heights, or tierLabel', () => {
  const base = { address: 'dgbt1qxyz', positions: [goodPosition], tipHeight: 812_000 };
  assert.throws(() => validatePositions({ ...base, positions: [{ ...goodPosition, ddCents: 'many' }] }), /malformed position/);
  assert.throws(() => validatePositions({ ...base, positions: [{ ...goodPosition, collateralSats: (21_000_000_000n * 100_000_000n + 1n).toString() }] }), /malformed position/);
  assert.throws(() => validatePositions({ ...base, positions: [{ ...goodPosition, unlockHeight: 100_000_001 }] }), /malformed position/);
  assert.throws(() => validatePositions({ ...base, positions: [{ ...goodPosition, tierLabel: 'x'.repeat(81) }] }), /malformed position/);
  assert.throws(() => validatePositions({ ...base, positions: [{ ...goodPosition, tierLabel: 7 }] }), /malformed position/);
  assert.throws(() => validatePositions({ ...base, tipHeight: -1 }), /malformed position/);
  assert.throws(() => validatePositions({ ...base, address: '' }), /malformed position/);
});

// ---- TOLERANT: drop the bad, keep the good ----

test('validateHistory drops malformed entries and keeps the good ones', () => {
  const out = validateHistory({
    history: [
      { txid: TXID, height: 812_345 },
      { txid: 'not-a-txid', height: 812_345 }, // bad txid
      { txid: TXID2, height: 812_345.5 }, // float height
      null,
      'garbage',
      { txid: TXID2, height: 0 },
    ],
  });
  assert.deepEqual(out, { history: [{ txid: TXID, height: 812_345 }, { txid: TXID2, height: 0 }] });
});

test('validateHistory returns empty on a non-object payload or missing array', () => {
  for (const bad of [null, undefined, 42, 'x', { }, { history: 'nope' }]) {
    assert.deepEqual(validateHistory(bad), { history: [] }, String(bad));
  }
});

test('validateTxDetail coerces garbage to the empty shape, keeps plain rows', () => {
  const out = validateTxDetail({
    vin: [{ address: 'dgbt1q' }, null, 'junk'],
    vout: 'not-an-array',
    confirmations: 'lots',
    time: NaN,
    feeSats: '-5',
    type: 42,
  });
  assert.deepEqual(out.vin, [{ address: 'dgbt1q' }]);
  assert.deepEqual(out.vout, []);
  assert.equal(out.confirmations, null);
  assert.equal(out.time, null);
  assert.equal(out.feeSats, null);
  assert.equal(out.type, null);
  assert.deepEqual(validateTxDetail(null), { vin: [], vout: [], confirmations: null, time: null, feeSats: null, type: null });
});

// ---- hostile payloads cannot pollute prototypes ----

test('a hostile __proto__ payload does not pollute the returned objects', () => {
  const hostile = JSON.parse(`{"utxos":[{"txid":"${TXID}","vout":0,"valueSats":"1","height":0,"__proto__":{"isAdmin":true}}]}`);
  const out = validateUtxos(hostile);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.getPrototypeOf(out.utxos[0]), Object.prototype);
  assert.equal({}.isAdmin, undefined); // global Object.prototype untouched

  const detail = validateTxDetail(JSON.parse(`{"vin":[{"__proto__":{"isAdmin":true}}],"vout":[]}`));
  assert.equal(Object.getPrototypeOf(detail), Object.prototype);
  assert.equal(Object.getPrototypeOf(detail.vin[0]), Object.prototype);
  assert.equal({}.isAdmin, undefined);
});

// ---- directory ("Spend DD"): TOLERANT display data, but a strict envelope ----

const goodMerchant = {
  id: 'dd-cafe', name: 'DD Café', url: 'https://ddcafe.example', category: 'food',
  blurb: 'Coffee for DD', addedAt: '2026-08-01', votes: 7, votedByYou: true,
};

test('validateDirectory: happy path, sanitized copies', () => {
  const input = {
    merchants: [goodMerchant, { ...goodMerchant, id: 'bookshop', votes: 0, votedByYou: false }],
    updatedAt: '2026-08-02T12:00:00Z',
    listUrl: 'https://directory.example/get-listed',
  };
  const out = validateDirectory(input);
  assert.deepEqual(out, input);
  assert.notEqual(out, input);
  assert.notEqual(out.merchants, input.merchants);
  assert.notEqual(out.merchants[0], input.merchants[0]);
  assert.equal(Object.getPrototypeOf(out.merchants[0]), Object.prototype);
});

test('validateDirectory: empty merchant list is a first-class shape, not an error', () => {
  assert.deepEqual(validateDirectory({ merchants: [], updatedAt: '', listUrl: '' }),
    { merchants: [], updatedAt: '', listUrl: '' });
});

test('validateDirectory drops malformed entries and keeps the good ones', () => {
  const out = validateDirectory({
    merchants: [
      goodMerchant,
      { ...goodMerchant, id: 'Bad Id!' }, // id off-pattern
      { ...goodMerchant, id: '-leading-hyphen' },
      { ...goodMerchant, id: 'x'.repeat(41) },
      { ...goodMerchant, id: 'ok2', url: 'http://insecure.example' }, // not https
      { ...goodMerchant, id: 'ok3', url: 'javascript:alert(1)' },
      { ...goodMerchant, id: 'ok4', name: 42 },
      { ...goodMerchant, id: 'ok5', category: null },
      { ...goodMerchant, id: 'ok6', votes: 'lots' }, // not coercible
      { ...goodMerchant, id: 'ok7', votes: NaN },
      null,
      'garbage',
      { ...goodMerchant, id: 'kept', votes: 3 },
    ],
    updatedAt: 'x',
    listUrl: 'https://directory.example',
  });
  assert.deepEqual(out.merchants.map((m) => m.id), ['dd-cafe', 'kept']);
});

test('validateDirectory throws only on a broken envelope', () => {
  for (const bad of [null, undefined, 42, 'x', [], { }, { merchants: 'nope' }]) {
    assert.throws(() => validateDirectory(bad), /malformed directory data/, String(bad));
  }
});

test('validateDirectory coerces votes/votedByYou and defaults the optional strings', () => {
  const out = validateDirectory({
    merchants: [
      { ...goodMerchant, id: 'a', votes: '12', votedByYou: 1, blurb: undefined, addedAt: null },
      { ...goodMerchant, id: 'b', votes: -5, votedByYou: 0 }, // clamped at 0
      { ...goodMerchant, id: 'c', votes: 2.5 }, // fractional display counts survive
    ],
  });
  assert.deepEqual(out.merchants[0], {
    id: 'a', name: goodMerchant.name, url: goodMerchant.url, category: goodMerchant.category,
    blurb: '', addedAt: '', votes: 12, votedByYou: true,
  });
  assert.equal(out.merchants[1].votes, 0);
  assert.equal(out.merchants[1].votedByYou, false);
  assert.equal(out.merchants[2].votes, 2.5);
  // missing envelope strings default to '' — and a non-https listUrl is dropped
  assert.equal(out.updatedAt, '');
  assert.equal(out.listUrl, '');
  assert.equal(validateDirectory({ merchants: [], updatedAt: 7, listUrl: 'http://x.example' }).listUrl, '');
});

// ---- F3: the incomplete-scan marker — "unknown", never "empty" ----

test('asIncomplete: returns the marker, and the STRICT validators pass it through unchanged', () => {
  const marker = { complete: false, reason: 'calls' };
  assert.deepEqual(asIncomplete(marker), { complete: false, reason: 'calls' });
  assert.deepEqual(validateUtxos(marker), { complete: false, reason: 'calls' });
  assert.deepEqual(validateDdUtxos(marker), { complete: false, reason: 'calls' });
  assert.deepEqual(validatePositions(marker), { complete: false, reason: 'calls' });
});

test('asIncomplete: a marker carrying a money array is refused (server defect or hostile upstream)', () => {
  assert.throws(() => asIncomplete({ complete: false, reason: 'calls', positions: [] }), /malformed scan-status/);
  assert.throws(() => asIncomplete({ complete: false, reason: 'calls', utxos: [] }), /malformed scan-status/);
  assert.throws(() => validatePositions({ complete: false, reason: 'calls', positions: [] }), /malformed scan-status/);
  assert.throws(() => asIncomplete({ complete: false }), /malformed scan-status/); // reason missing
  assert.throws(() => asIncomplete({ complete: false, reason: '' }), /malformed scan-status/);
});

test('asIncomplete: ordinary payloads are not markers', () => {
  assert.equal(asIncomplete({ utxos: [] }), null);
  assert.equal(asIncomplete({ positions: [] }), null);
  assert.equal(asIncomplete({ complete: true, reason: 'calls' }), null);
  assert.equal(asIncomplete(null), null);
  assert.equal(asIncomplete('complete: false'), null);
});
