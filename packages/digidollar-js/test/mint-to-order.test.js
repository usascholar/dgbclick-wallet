// Mint-to-order (ownerKeyHex ≠ funding key): shape guarantees of the additive
// buildSignedMintTx parameter. The default path must stay BYTE-IDENTICAL for
// every existing caller; the exotic path must name the owner in exactly the
// three owner outputs while the funding input and change stay the signer's.
// Consensus validity of the exotic shape is proven live against Core in
// scripts/mint-to-order-spike.mjs (and the gated e2e in e2e-mint.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignedMintTx, xOnlyPubKey, ddTokenOutputKey, collateralOutputKey,
  buildMintMetadata, LOCK_TIERS, MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS,
} from 'digidollar-js';
import { p2wpkhProgramHex } from '../src/txbuild.js'; // not re-exported through index.js

const SIGNER = 'aa'.repeat(32); // funds + signs (the giver)
const OWNER = 'bb'.repeat(32);  // owns the position (the recipient)
const signerX = xOnlyPubKey(SIGNER);
const ownerX = xOnlyPubKey(OWNER);
const p2tr = (xOnlyHex) => '5120' + xOnlyHex;

const baseMint = {
  utxo: { txidHex: 'cc'.repeat(32), vout: 0, valueSats: 2_000_000_000_000n },
  privKeyHex: SIGNER,
  ddCents: 10_000n,
  tierId: '10years',
  oraclePriceMicroUsd: 13_420n,
  tipHeight: 24_000_000,
};

test('default build is byte-identical to an explicit ownerKeyHex = signer key', () => {
  const a = buildSignedMintTx(baseMint);
  const b = buildSignedMintTx({ ...baseMint, ownerKeyHex: signerX });
  // schnorr.sign uses fresh aux randomness per call, so only the 64-byte
  // witness signature (and nothing before it) may differ: strip the trailing
  // '0140' + sig + locktime (2 + 128 + 8 hex chars) and compare the rest
  assert.equal(b.hex.slice(0, -138), a.hex.slice(0, -138));
  assert.equal(b.unlockHeight, a.unlockHeight);
  assert.equal(b.collateralSats, a.collateralSats);
});

test('exotic mint names the OWNER in collateral, DD token and metadata…', () => {
  const { hex, unlockHeight } = buildSignedMintTx({ ...baseMint, ownerKeyHex: ownerX });
  const tier = LOCK_TIERS[LOCK_TIERS.length - 1];
  assert.equal(unlockHeight, baseMint.tipHeight + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks);
  // vout[0] collateral P2TR (NUMS+MAST) committed to the owner
  assert.ok(hex.includes(p2tr(collateralOutputKey({ ownerKeyHex: ownerX, lockHeight: unlockHeight, ddCents: 10_000n }))),
    'collateral output names the owner');
  // vout[1] DD token P2TR of the owner
  assert.ok(hex.includes(p2tr(ddTokenOutputKey(ownerX))), 'DD token output names the owner');
  // vout[2] metadata OP_RETURN carries the owner's key
  assert.ok(hex.includes(buildMintMetadata({ ddCents: 10_000n, unlockHeight, lockTier: LOCK_TIERS.indexOf(tier), ownerKeyHex: ownerX })),
    'metadata names the owner');
  // …and NOT the signer anywhere in those outputs
  assert.ok(!hex.includes(buildMintMetadata({ ddCents: 10_000n, unlockHeight, lockTier: LOCK_TIERS.indexOf(tier), ownerKeyHex: signerX })),
    'metadata must not name the signer');
});

test('exotic mint keeps the funding input and change with the SIGNER', () => {
  const exotic = buildSignedMintTx({ ...baseMint, ownerKeyHex: ownerX });
  const normal = buildSignedMintTx(baseMint);
  // the funding input's scriptPubKey is committed in the sighash-committed
  // serialization… the tx itself carries the change output, which must be the
  // signer's P2WPKH in both shapes
  const changeSpk = '0014' + p2wpkhProgramHex(SIGNER);
  assert.ok(exotic.hex.includes(changeSpk), 'change returns to the signer');
  assert.ok(normal.hex.includes(changeSpk), 'default change also returns to the signer');
  // the owner's key must never appear as a change script
  assert.ok(!exotic.hex.includes('0014' + p2wpkhProgramHex(OWNER)), 'no output belongs to the owner except the mint outputs');
});

test('ownerKeyHex is validated', () => {
  assert.throws(() => buildSignedMintTx({ ...baseMint, ownerKeyHex: 'zz' }), /ownerKeyHex/);
  assert.throws(() => buildSignedMintTx({ ...baseMint, ownerKeyHex: ownerX.toUpperCase() }), /ownerKeyHex/);
  assert.throws(() => buildSignedMintTx({ ...baseMint, ownerKeyHex: ownerX.slice(2) }), /ownerKeyHex/);
});
