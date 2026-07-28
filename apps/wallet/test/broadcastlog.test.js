import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BROADCAST_LOG_KEY, createBroadcastLog, txidFromHex } from '../public/broadcastlog.js';

// The pending-broadcast log survives the "did my transaction actually reach
// the mempool?" ambiguity: the signed hex is persisted BEFORE broadcasting so
// a timeout/dropped connection never tempts the wallet into rebuilding a fresh
// tx over the same UTXOs. Storage here is a Map-backed stand-in for
// localStorage (same getItem/setItem/removeItem surface).

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// Not a consensus-valid transaction — irrelevant: the txid is a pure hash of
// the bytes, so any even-length hex is a valid test vector.
const HEX = '0200000001abcdef0123456789';

test('record → list round-trips; txid is computed locally at record time', async () => {
  const log = createBroadcastLog(memStorage());
  const rec = await log.record({ hex: HEX, kind: 'send', net: 'mainnet' });
  assert.equal(rec.hex, HEX);
  assert.equal(rec.kind, 'send');
  assert.equal(rec.net, 'mainnet');
  assert.equal(typeof rec.id, 'string');
  assert.ok(rec.id.length > 0);
  assert.equal(rec.txid, await txidFromHex(HEX)); // self-sufficient even if the page dies
  assert.equal(typeof rec.createdAt, 'string');
  assert.deepEqual(log.list(), [rec]);
});

test('txidFromHex matches a double-SHA256 vector computed independently', async () => {
  const bytes = Buffer.from(HEX, 'hex');
  const expected = createHash('sha256')
    .update(createHash('sha256').update(bytes).digest())
    .digest()
    .reverse() // consensus displays txids little-endian
    .toString('hex');
  assert.equal(await txidFromHex(HEX), expected);
  assert.match(await txidFromHex(HEX), /^[0-9a-f]{64}$/);
});

test('txidFromHex and record reject garbage hex', async () => {
  await assert.rejects(() => txidFromHex('zz'), /hex/);
  await assert.rejects(() => txidFromHex('abc'), /hex/); // odd length
  await assert.rejects(() => txidFromHex('AB'), /hex/); // uppercase
  await assert.rejects(() => txidFromHex(''), /hex/);
  const log = createBroadcastLog(memStorage());
  await assert.rejects(() => log.record({ hex: 'not-hex', kind: 'send', net: 'mainnet' }), /hex/);
  await assert.rejects(() => log.record({ hex: HEX, kind: '', net: 'mainnet' }), /kind/);
  await assert.rejects(() => log.record({ hex: HEX, kind: 'send' }), /net/);
  assert.deepEqual(log.list(), []); // nothing half-recorded
});

test('a corrupt stored log reads as empty — it must never crash boot', async () => {
  const store = memStorage();
  store.setItem(BROADCAST_LOG_KEY, '{not json at all');
  assert.deepEqual(createBroadcastLog(store).list(), []);
  store.setItem(BROADCAST_LOG_KEY, '{"object":"not an array"}');
  assert.deepEqual(createBroadcastLog(store).list(), []);
  // and the log recovers: the next record simply overwrites the corruption
  const log = createBroadcastLog(store);
  const rec = await log.record({ hex: HEX, kind: 'send', net: 'mainnet' });
  assert.deepEqual(log.list(), [rec]);
});

test('markTxid fills the txid for a known id, no-ops for an unknown one', async () => {
  const log = createBroadcastLog(memStorage());
  const rec = await log.record({ hex: HEX, kind: 'mint', net: 'testnet' });
  const nodeTxid = 'ab'.repeat(32);
  log.markTxid(rec.id, nodeTxid);
  assert.equal(log.list()[0].txid, nodeTxid);
  log.markTxid('no-such-id', nodeTxid); // no throw, no change
  assert.equal(log.list().length, 1);
  assert.throws(() => log.markTxid(rec.id, 'short'), /txid/);
  assert.throws(() => log.markTxid(rec.id, 'AB'.repeat(32)), /txid/); // uppercase rejected
});

test('remove drops a record (confirmed or superseded)', async () => {
  const log = createBroadcastLog(memStorage());
  const a = await log.record({ hex: HEX, kind: 'send', net: 'mainnet' });
  const b = await log.record({ hex: HEX + 'ff', kind: 'redeem', net: 'mainnet' });
  log.remove(a.id);
  assert.deepEqual(log.list().map((r) => r.id), [b.id]);
  log.remove('no-such-id'); // harmless
  assert.equal(log.list().length, 1);
  log.remove(b.id);
  assert.deepEqual(log.list(), []);
});

test('the 20-record cap evicts the oldest — a runaway loop cannot grow storage', async () => {
  const log = createBroadcastLog(memStorage());
  const first = await log.record({ hex: HEX, kind: 'send', net: 'mainnet' });
  for (let i = 0; i < 25; i += 1) {
    await log.record({ hex: HEX + i.toString(16).padStart(2, '0'), kind: 'send', net: 'mainnet' });
  }
  const records = log.list();
  assert.equal(records.length, 20);
  assert.ok(!records.some((r) => r.id === first.id), 'oldest evicted');
  // order is preserved: the newest record is last
  assert.equal(records.at(-1).hex, HEX + (24).toString(16).padStart(2, '0'));
});
