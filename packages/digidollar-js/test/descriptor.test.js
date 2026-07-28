// Core-descriptor key source: a DigiByte Core wallet exports descriptors, never
// a BIP39 mnemonic, so this is the ONLY migration path off Core. The contract
// that matters: a descriptor covering the same account must derive keys and
// addresses BYTE-IDENTICAL to the seed path — anything else silently sends
// funds to addresses the origin wallet cannot spend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HDKey } from '@scure/bip32';
import {
  mnemonicToSeed, deriveTaprootAddress, descriptorKeySource, parseTrDescriptor,
  parseDescriptorBundle, HD_NETWORKS,
} from '../src/index.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(MNEMONIC);
const account = HDKey.fromMasterSeed(seed).derive("m/86'/20'/0'");
const CORE_DESC = `tr([abcd1234/86h/20h/0h]${account.privateExtendedKey}/0/*)#aaaaaaaa`;

test('Core account-level descriptor derives IDENTICAL keys to the seed path', () => {
  for (const index of [0, 1, 7, 250]) {
    const bySeed = deriveTaprootAddress(seed, { ...HD_NETWORKS.mainnet, index });
    const byDesc = deriveTaprootAddress(descriptorKeySource(CORE_DESC), { ...HD_NETWORKS.mainnet, index });
    assert.equal(byDesc.address, bySeed.address, `address at index ${index}`);
    assert.equal(byDesc.privKeyHex, bySeed.privKeyHex, `private key at index ${index}`);
    assert.equal(byDesc.outputKeyHex, bySeed.outputKeyHex);
    assert.equal(byDesc.p2wpkhAddress, bySeed.p2wpkhAddress);
  }
});

test('master-level descriptor with the full path inline works too', () => {
  const masterDesc = `tr(${HDKey.fromMasterSeed(seed).privateExtendedKey}/86h/20h/0h/0/*)`;
  const byDesc = deriveTaprootAddress(descriptorKeySource(masterDesc), { ...HD_NETWORKS.mainnet, index: 5 });
  const bySeed = deriveTaprootAddress(seed, { ...HD_NETWORKS.mainnet, index: 5 });
  assert.equal(byDesc.address, bySeed.address);
});

test("both hardened spellings ('h' and quote) parse the same", () => {
  const quoted = CORE_DESC.replace(/h\]/, "']").replace(/86h/, "86'").replace(/20h/, "20'").replace(/0h/, "0'");
  assert.equal(
    deriveTaprootAddress(descriptorKeySource(quoted), { ...HD_NETWORKS.mainnet, index: 2 }).address,
    deriveTaprootAddress(descriptorKeySource(CORE_DESC), { ...HD_NETWORKS.mainnet, index: 2 }).address,
  );
});

test('a descriptor chain is honored AS WRITTEN — change is never substituted', () => {
  // Core exports one descriptor per chain (…/0/* and …/1/*). Rewriting the
  // chain element from a caller's  collapsed both onto the same chain,
  // so the two sources derived identical addresses and one coin was counted
  // twice (balance read 30 for a single 15 DGB coin, caught in browser).
  const recvSrc = descriptorKeySource(CORE_DESC);                       // …/0/*
  const chgSrc = descriptorKeySource(CORE_DESC.replace('/0/*', '/1/*')); // …/1/*
  const a = deriveTaprootAddress(recvSrc, { ...HD_NETWORKS.mainnet, index: 0 });
  const b = deriveTaprootAddress(chgSrc, { ...HD_NETWORKS.mainnet, index: 0 });
  assert.notEqual(a.address, b.address, 'the two chains must stay distinct');
  // and asking the RECEIVE descriptor for change=1 must not move it to the
  // change chain — its path is fixed by the descriptor itself
  const forced = deriveTaprootAddress(recvSrc, { ...HD_NETWORKS.mainnet, change: 1, index: 0 });
  assert.equal(forced.address, a.address);
  // each still matches the seed path for its own chain
  assert.equal(a.address, deriveTaprootAddress(seed, { ...HD_NETWORKS.mainnet, change: 0, index: 0 }).address);
  assert.equal(b.address, deriveTaprootAddress(seed, { ...HD_NETWORKS.mainnet, change: 1, index: 0 }).address);
});

test('parse exposes origin and wildcard; checksum is optional', () => {
  const p = parseTrDescriptor(CORE_DESC);
  assert.equal(p.origin, 'abcd1234/86h/20h/0h');
  assert.equal(p.relPath, '0/*');
  assert.equal(p.hasWildcard, true);
  assert.equal(parseTrDescriptor(CORE_DESC.replace(/#aaaaaaaa$/, '')).extendedKey, p.extendedKey);
});

test('rejects what cannot sign, with a message that says what to do', () => {
  const watchOnly = `tr([abcd1234/86h/20h/0h]${account.publicExtendedKey}/0/*)`;
  assert.throws(() => descriptorKeySource(watchOnly), /PRIVATE|listdescriptors true/i);
  // wpkh IS supported now (Core keeps most DGB there) — it must PARSE…
  assert.equal(parseTrDescriptor(`wpkh(${account.privateExtendedKey}/0/*)`).kind, 'wpkh');
  // …while genuinely unsupported types still refuse, with instructions
  assert.throws(() => descriptorKeySource(`pkh(${account.privateExtendedKey}/0/*)`), /not supported|legacy/i);
  assert.throws(() => descriptorKeySource(''), /listdescriptors/i);
  assert.throws(() => descriptorKeySource('tr(not-a-key/0/*)'), /descriptor/i);
  assert.throws(() => descriptorKeySource(MNEMONIC), /descriptor/i);
});

// ---- Whole-wallet import (the "I see the treasury but none of my DGB" bug) ----
// Core's listdescriptors emits one descriptor per address type AND per chain.
// Importing one line imports a fraction of the wallet; the bundle parser must
// keep everything usable and say what it could not take.
const CORE_JSON = JSON.stringify({
  wallet_name: 'coldwallet',
  descriptors: [
    { desc: `pkh([abcd1234/44h/20h/0h]${account.privateExtendedKey}/0/*)#aa`, active: true },
    { desc: `wpkh([abcd1234/84h/20h/0h]${account.privateExtendedKey}/0/*)#bb`, active: true },
    { desc: `wpkh([abcd1234/84h/20h/0h]${account.privateExtendedKey}/1/*)#cc`, active: true, internal: true },
    { desc: `tr([abcd1234/86h/20h/0h]${account.privateExtendedKey}/0/*)#dd`, active: true },
    { desc: `tr([abcd1234/86h/20h/0h]${account.privateExtendedKey}/1/*)#ee`, active: true, internal: true },
    { desc: `tr([abcd1234/86h/20h/0h]${account.publicExtendedKey}/0/*)#ff`, active: false }, // watch-only: ignored
  ],
});

test('bundle: taproot receive chain becomes primary, the rest ride along', () => {
  const b = parseDescriptorBundle(CORE_JSON);
  assert.match(b.primary, /^tr\(/);
  assert.match(b.primary, /\/0\/\*\)/);                       // the RECEIVE chain, not change
  assert.equal(b.extra.length, 3);                            // tr change + both wpkh chains
  assert.ok(b.extra.every((d) => /[tx]prv/.test(d)));         // never a watch-only line
  assert.deepEqual(b.unsupported, ['pkh']);                   // reported, not silently dropped
});

test('bundle: every kept chain derives spendable keys', () => {
  const b = parseDescriptorBundle(CORE_JSON);
  for (const desc of [b.primary, ...b.extra]) {
    const d = deriveTaprootAddress(descriptorKeySource(desc), { ...HD_NETWORKS.mainnet, index: 0 });
    assert.match(d.privKeyHex, /^[0-9a-f]{64}$/);
    assert.ok(d.address.startsWith('dgb1p'));      // taproot form
    assert.ok(d.p2wpkhAddress.startsWith('dgb1q')); // and its segwit twin — where Core's DGB sits
  }
});

test('bundle: a plain single line still works, and junk fails loudly', () => {
  assert.equal(parseDescriptorBundle(CORE_DESC).primary, CORE_DESC);
  assert.equal(parseDescriptorBundle(CORE_DESC).extra.length, 0);
  assert.throws(() => parseDescriptorBundle('{"descriptors":[]}'), /listdescriptors|no "descriptors"/i);
  assert.throws(() => parseDescriptorBundle('{ not json'), /parse/i);
  assert.throws(() => parseDescriptorBundle(''), /listdescriptors/i);
  // a wallet with no taproot chain cannot hold DigiDollar — say so
  assert.throws(() => parseDescriptorBundle(JSON.stringify({
    descriptors: [{ desc: `wpkh([abcd1234/84h/20h/0h]${account.privateExtendedKey}/0/*)#bb` }],
  })), /taproot/i);
});
