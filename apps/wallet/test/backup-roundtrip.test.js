// Restore-from-backup-file must PROVABLY roundtrip: create → export encrypted
// keystore file → total loss → restore → the SAME addresses come back. This is
// the recovery promise the wallet makes for real mainnet funds, so it is
// exercised end-to-end with the real crypto (keystore.js), the real vault
// manager (vault.js), and the real HD derivation (digidollar-js) — only
// storage is faked. memStorage() is duplicated from vault.test.js on purpose:
// test files must not import each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMnemonic, mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS, validateMnemonic,
} from 'digidollar-js';
import {
  buildKeystoreFile, parseKeystoreFile, decryptKeystoreFile, VaultConflictError,
} from '../public/keystore.js';
import { createVaultManager } from '../public/vault.js';

const PW = 'correct horse battery staple';

// In-memory storage with the same surface (and the same CAS semantics) as
// keystore.js. JSON-clones on the way in and out, like structured clone does.
function memStorage() {
  const db = new Map();
  const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
  return {
    db,
    async loadKeystoreAny() {
      return { vault: clone(db.get('vault')), primary: clone(db.get('primary')) };
    },
    async saveVaultRecord(record, baseRev) {
      const cur = db.get('vault');
      if ((cur?.rev ?? 0) !== baseRev) throw new VaultConflictError();
      const next = { ...clone(record), id: 'vault', rev: baseRev + 1 };
      db.set('vault', next);
      return clone(next);
    },
    async deleteVaultRecord(baseRev) {
      const cur = db.get('vault');
      if ((cur?.rev ?? 0) !== baseRev) throw new VaultConflictError();
      db.delete('vault');
    },
    async deleteKeystore() {
      db.delete('primary');
    },
  };
}

const testnetAddr = (mnemonic, index) =>
  deriveTaprootAddress(mnemonicToSeed(mnemonic), { ...HD_NETWORKS.testnet, index }).address;

test('envelope roundtrip: build → JSON download/upload → parse → decrypt → same mnemonic', async () => {
  const mnemonic = generateMnemonic();
  const envelope = await buildKeystoreFile({ name: 'Wallet 1', network: 'testnet', mnemonic, password: PW });
  // JSON.stringify → JSON.parse simulates the file leaving the browser
  // (download) and coming back (upload): only the JSON text may survive.
  const uploaded = parseKeystoreFile(JSON.stringify(JSON.parse(JSON.stringify(envelope))));
  const restored = await decryptKeystoreFile(uploaded, PW);
  assert.equal(restored, mnemonic);
  assert.equal(validateMnemonic(restored), true);
});

test('full lifecycle: create → export → total loss → restore → identical addresses', async () => {
  // --- the live wallet ---
  const mnemonic = generateMnemonic();
  const vm1 = createVaultManager(memStorage());
  const id = await vm1.createVault(PW, { name: 'Wallet 1', mnemonic });
  const addr0 = testnetAddr(mnemonic, 0);
  const addr3 = testnetAddr(mnemonic, 3);

  // --- export the backup file (as the download flow would hand it out) ---
  const fileText = JSON.stringify(await buildKeystoreFile({
    name: 'Wallet 1', network: 'testnet', mnemonic: vm1.getMnemonic(id), password: PW,
  }));

  // --- total loss: brand-new storage, brand-new vault manager ---
  const vm2 = createVaultManager(memStorage());
  assert.equal(await vm2.load(), 'none');

  // --- restore from the file alone ---
  const restoredMnemonic = await decryptKeystoreFile(parseKeystoreFile(fileText), PW);
  const id2 = await vm2.createVault(PW, { name: 'Wallet 1 (restored)', mnemonic: restoredMnemonic });
  assert.equal(vm2.getMnemonic(id2), mnemonic);
  assert.equal(testnetAddr(vm2.getMnemonic(id2), 0), addr0);
  assert.equal(testnetAddr(vm2.getMnemonic(id2), 3), addr3); // deeper index, same rule
});

test('wrong password on the file is rejected (GCM auth failure)', async () => {
  const envelope = await buildKeystoreFile({
    name: 'Wallet 1', network: 'testnet', mnemonic: generateMnemonic(), password: PW,
  });
  await assert.rejects(() => decryptKeystoreFile(parseKeystoreFile(JSON.stringify(envelope)), 'wrong password'));
});

test('a tampered ciphertext parses but never decrypts — no decryption oracle', async () => {
  const envelope = await buildKeystoreFile({
    name: 'Wallet 1', network: 'testnet', mnemonic: generateMnemonic(), password: PW,
  });
  // Flip one base64 character inside cipher.data (to a DIFFERENT valid char).
  const data = envelope.cipher.data;
  const replacement = data[0] === 'A' ? 'B' : 'A';
  const tampered = {
    ...envelope,
    cipher: { ...envelope.cipher, data: replacement + data.slice(1) },
  };
  assert.notEqual(tampered.cipher.data, data);
  const parsed = parseKeystoreFile(JSON.stringify(tampered)); // structure is fine…
  await assert.rejects(() => decryptKeystoreFile(parsed, PW)); // …the MAC is not
});
