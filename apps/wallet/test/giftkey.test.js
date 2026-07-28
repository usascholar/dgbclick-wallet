// parseRawOwnerKey: the Core-user paste surface of the "Make a Gift key"
// helper. Inputs are whatever a getaddressinfo copy-paste produces; a wrong
// extraction here mints to a key nobody controls, so the parser is strict
// about what counts as an owner key and loud about addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRawOwnerKey } from '../public/giftkey.js';

// a real desc from the regtest proof run (core-recipient-spike.mjs)
const DESC = "tr([5e0ccb41/86h/1h/0h/0/0]112104bd6da8cbec8855a31718cf8d7c3b93c58d7a98e2c1196056b3f46cc8a4)#ef3j4jma";
const KEY = '112104bd6da8cbec8855a31718cf8d7c3b93c58d7a98e2c1196056b3f46cc8a4';

test('extracts the raw key from a bare desc line', () => {
  assert.deepEqual(parseRawOwnerKey(DESC), { rawKeyHex: KEY, witnessProgramHex: null });
});

test('extracts from full getaddressinfo JSON and carries the witness program for verification', () => {
  const json = JSON.stringify({
    address: 'dgbrt1pcaq2sdn0d345jtd4fxp2ctzp58z9q6ewmfzw03s2cas43utca4as54ak95',
    scriptPubKey: '5120c740a836...',
    witness_program: 'c740a8366f6c6b492db54982ac2c41a1c4506b2eda44e7c60ac76158f178ed7b',
    desc: DESC,
  });
  assert.deepEqual(parseRawOwnerKey(json), {
    rawKeyHex: KEY,
    witnessProgramHex: 'c740a8366f6c6b492db54982ac2c41a1c4506b2eda44e7c60ac76158f178ed7b',
  });
});

test('accepts a bare x-only key and a compressed key (prefix dropped)', () => {
  assert.equal(parseRawOwnerKey(KEY.toUpperCase()).rawKeyHex, KEY);
  assert.equal(parseRawOwnerKey('03' + KEY).rawKeyHex, KEY);
});

test('a compressed key inside a desc also drops its parity prefix', () => {
  const compressed = DESC.replace(KEY, '02' + KEY);
  assert.equal(parseRawOwnerKey(compressed).rawKeyHex, KEY);
});

test('an ADDRESS paste gets the teaching error, not a bogus key', () => {
  for (const addr of ['dgb1pzt9005mw5php9pyc905y3rfrv0lw8q6r7wwtc67yj0xsagtmfmzqwaf3dt', 'DD1ui9NH2XwS1sEQRBLiUHTzd6mv17a73YasCHUBJgkWfvU4AVXQ']) {
    assert.throws(() => parseRawOwnerKey(addr), /ADDRESS.*getaddressinfo/s);
  }
});

test('garbage, empty, legacy-wallet JSON: plain-language failures', () => {
  assert.throws(() => parseRawOwnerKey(''), /paste the output/);
  assert.throws(() => parseRawOwnerKey('{not json'), /does not parse/);
  assert.throws(() => parseRawOwnerKey(JSON.stringify({ address: 'x' })), /no "desc" field/);
  assert.throws(() => parseRawOwnerKey('hello world'), /no owner key found/);
});
