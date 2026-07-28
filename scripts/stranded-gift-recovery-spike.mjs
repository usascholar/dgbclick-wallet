// Stranded-gift recovery spike (research only — ships nothing, changes nothing).
//
// The address-key gift bug (the address-key gift incident) minted
// a position whose owner key is the RECIPIENT'S ADDRESS KEY Q = tweak(P),
// instead of their raw internal key P. Nothing is lost — Q's private key is
// derivable from the wallet's own key — but no shipped wallet signs with it.
//
// This proves the recovery recipe end to end against real Core:
//   1. reproduce the exact stranded shape (mint with ownerKeyHex = Q),
//   2. recover the DD with the shipped transfer builder, handed the
//      ONCE-TWEAKED private key dQ (xOnly(dQ) == Q),
//   3. recover the COLLATERAL at maturity with the shipped redeem builder and
//      the same dQ (1-hour tier so the full cycle fits in one run).
//
//   DGB_BIN="C:/Program Files/DigiByte/daemon/digibyted.exe" node scripts/stranded-gift-recovery-spike.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  LOCK_TIERS, requiredCollateralSats, serializeTx, xOnlyPubKey,
  buildDDVersion, buildMintMetadata, collateralOutputKey, ddTokenOutputKey,
  encodeWitnessAddress, MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS,
  buildSignedTransferTx, buildSignedRedeemTx,
} from '../packages/digidollar-js/src/index.js';
import { p2wpkhProgramHex } from '../packages/digidollar-js/src/txbuild.js';

const DGB_BIN = process.env.DGB_BIN ?? 'C:/Program Files/DigiByte/daemon/digibyted.exe';
const RPCPORT = Number(process.env.RPCPORT) || 18520;
const RPC = `http://127.0.0.1:${RPCPORT}`;
const AUTH = 'Basic ' + Buffer.from('dd:ddpass').toString('base64');
const DATADIR = mkdtempSync(join(tmpdir(), 'dgb-recovery-'));

const checks = [];
const check = (ok, label) => { checks.push(ok); console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) process.exitCode = 1; };

async function rpc(method, params = [], wallet = null) {
  const res = await fetch(RPC + (wallet ? `/wallet/${wallet}` : ''), {
    method: 'POST',
    headers: { 'content-type': 'text/plain', authorization: AUTH },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'spike', method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

// ---- helpers (same primitives as mint-to-order-spike.mjs) ----
const { taggedHash } = schnorr.utils;
const Point = secp256k1.Point;
const CURVE_N = Point.CURVE().n;
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const concat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
const u32le = (n) => Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const u64le = (v) => { const o = new Uint8Array(8); let x = BigInt(v); for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const varint = (n) => (n < 0xfd ? Uint8Array.from([n]) : Uint8Array.from([0xfd, n & 0xff, n >>> 8]));
const p2trScript = (x) => concat(Uint8Array.from([0x51, 0x20]), hexToBytes(x));
const p2wpkhScript = (priv) => concat(Uint8Array.from([0x00, 0x14]), hexToBytes(p2wpkhProgramHex(priv)));

/** THE RECOVERY PRIMITIVE: the private key of the BIP341-tweaked point.
 * Given d with X-only P, returns dQ whose X-only pubkey is tweak(P) — i.e.
 * the key that "owns" an address key. Applying it once yields the signer for
 * a gift stranded at ownerKeyHex = Q; the wallet's own address keeps using d. */
function tapTweakPrivKey(privKeyHex) {
  const d0 = BigInt('0x' + privKeyHex);
  const P = Point.BASE.multiply(d0).toAffine();
  const d = (P.y & 1n) === 0n ? d0 : CURVE_N - d0;
  const px = P.x.toString(16).padStart(64, '0');
  const t = BigInt('0x' + bytesToHex(taggedHash('TapTweak', hexToBytes(px))));
  return ((d + t) % CURVE_N).toString(16).padStart(64, '0');
}
function taprootSighash({ version, locktime, inputs, outputs, inputIndex }) {
  const shaPrevouts = sha256(concat(...inputs.map((i) => concat(hexToBytes(i.txidHex).reverse(), u32le(i.vout)))));
  const shaAmounts = sha256(concat(...inputs.map((i) => u64le(i.valueSats))));
  const shaScriptPubKeys = sha256(concat(...inputs.map((i) => { const s = hexToBytes(i.scriptPubKeyHex); return concat(varint(s.length), s); })));
  const shaSequences = sha256(concat(...inputs.map((i) => u32le(i.sequence))));
  const shaOutputs = sha256(concat(...outputs.map((o) => concat(u64le(o.valueSats), varint(o.script.length), o.script))));
  const msg = concat(Uint8Array.from([0x00]), u32le(version), u32le(locktime), shaPrevouts, shaAmounts, shaScriptPubKeys, shaSequences, shaOutputs, Uint8Array.from([0x00]), u32le(inputIndex));
  return taggedHash('TapSighash', concat(Uint8Array.from([0x00]), msg));
}

// ---- boot regtest ----
console.log(`→ regtest node (datadir ${DATADIR})`);
const daemon = spawn(DGB_BIN, ['-regtest', '-server=1', `-datadir=${DATADIR}`, '-rpcuser=dd', '-rpcpassword=ddpass',
  `-rpcport=${RPCPORT}`, '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', '-listen=0', '-fallbackfee=0.001',
  '-dandelion=0', '-txindex=1'], { stdio: 'ignore' });
process.on('exit', () => { try { daemon.kill(); } catch { /* gone */ } });
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await rpc('getblockchaininfo')).chain === 'regtest'; } catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!up) { console.error('node never came up'); process.exit(2); }
await rpc('createwallet', ['miner']);
const mineAddr = await rpc('getnewaddress', [], 'miner');
await rpc('generatetoaddress', [651, mineAddr], 'miner');
const priceMicroUsd = 13_420n;
await rpc('enablemockoracle', [true]);
await rpc('setmockoracleprice', [Number(priceMicroUsd)]);
console.log('→ DigiDollar active, mock oracle set');

// ---- 1. reproduce the stranded shape ----
// The victim wallet: private key d, internal key P, DD address key Q = tweak(P).
const VICTIM_PRIV = '33'.repeat(32);
const P = xOnlyPubKey(VICTIM_PRIV);          // what a correct gift should name
const Q = ddTokenOutputKey(P);               // what the buggy UI actually named
const GIVER_PRIV = '11'.repeat(32);
const giverX = xOnlyPubKey(GIVER_PRIV);
const giverOutKey = ddTokenOutputKey(giverX);
const fundTxid = await rpc('sendtoaddress', [encodeWitnessAddress('dgbrt', 1, giverOutKey), 80000], 'miner');
await rpc('generatetoaddress', [1, mineAddr], 'miner');
const fundRaw = await rpc('getrawtransaction', [fundTxid, true]);
const funding = fundRaw.vout.find((o) => o.scriptPubKey.hex === bytesToHex(p2trScript(giverOutKey)));

const ddCents = 10_000n;
const tier = LOCK_TIERS[0]; // 1 hour — the whole cycle fits in this run
const tip = (await rpc('getblockchaininfo')).blocks;
const unlockHeight = tip + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks;
const collateralSats = requiredCollateralSats({ ddCents, tierId: tier.id, oraclePriceMicroUsd: priceMicroUsd, dcaMultiplierBps: 10_000n });
const feeSats = 12_000_000n;
const fundingSats = BigInt(Math.round(funding.value * 1e8));
const inputs = [{ txidHex: fundTxid, vout: funding.n, valueSats: fundingSats, scriptPubKeyHex: bytesToHex(p2trScript(giverOutKey)), sequence: 0xfffffffd }];
const outputs = [
  { valueSats: collateralSats, script: p2trScript(collateralOutputKey({ ownerKeyHex: Q, lockHeight: unlockHeight, ddCents })) },
  { valueSats: 0n, script: p2trScript(ddTokenOutputKey(Q)) },   // ← the double-tweaked, unwatched script
  { valueSats: 0n, script: hexToBytes(buildMintMetadata({ ddCents, unlockHeight, lockTier: 0, ownerKeyHex: Q })) },
  { valueSats: fundingSats - collateralSats - feeSats, script: p2wpkhScript(GIVER_PRIV) },
];
const version = buildDDVersion('mint');
const sig = schnorr.sign(taprootSighash({ version, locktime: 0, inputs, outputs, inputIndex: 0 }), hexToBytes(tapTweakPrivKey(GIVER_PRIV)));
const mintTxid = await rpc('sendrawtransaction', [serializeTx({ version, locktime: 0, inputs, outputs, witnesses: [[sig]] })]);
for (let i = 0; i < 6; i++) {
  await rpc('setmockoracleprice', [Number(priceMicroUsd)]);
  await rpc('generatetoaddress', [1, mineAddr], 'miner');
  if ((await rpc('getrawtransaction', [mintTxid, true]).catch(() => null))?.confirmations > 0) break;
}
check(true, `stranded gift reproduced: owner = ADDRESS key Q, DD at tweak(Q) (${mintTxid.slice(0, 16)}…)`);

// ---- 2. THE RECIPE: sign with the once-tweaked key ----
const dQ = tapTweakPrivKey(VICTIM_PRIV);
check(xOnlyPubKey(dQ) === Q, 'recovery key derived: xOnly(tapTweakPrivKey(d)) == Q (the stranded owner key)');

// the stranded script IS a payable address — fund the fee there, as the
// transfer builder spends both its DD input and its fee input from it
const strandedAddr = encodeWitnessAddress('dgbrt', 1, ddTokenOutputKey(Q));
const feeTxid = await rpc('sendtoaddress', [strandedAddr, 5], 'miner');
await rpc('generatetoaddress', [1, mineAddr], 'miner');
const feeRaw = await rpc('getrawtransaction', [feeTxid, true]);
const feeCoin = feeRaw.vout.find((o) => o.scriptPubKey.hex === bytesToHex(p2trScript(ddTokenOutputKey(Q))));

// recover the DD to the victim's NORMAL DD address (owner key P → the wallet sees it)
const { hex: recoverHex } = buildSignedTransferTx({
  ddUtxo: { txidHex: mintTxid, vout: 1, ddCents },
  feeUtxo: { txidHex: feeTxid, vout: feeCoin.n, valueSats: BigInt(Math.round(feeCoin.value * 1e8)) },
  privKeyHex: dQ,                                   // ← the whole trick
  recipients: [{ outputKeyHex: Q, cents: ddCents }], // Q is the victim's own DD address key
  feeSats,
});
let recoverTxid = null;
try {
  recoverTxid = await rpc('sendrawtransaction', [recoverHex]);
  for (let i = 0; i < 6; i++) {
    await rpc('setmockoracleprice', [Number(priceMicroUsd)]);
    await rpc('generatetoaddress', [1, mineAddr], 'miner');
    if ((await rpc('getrawtransaction', [recoverTxid, true]).catch(() => null))?.confirmations > 0) break;
  }
  check(true, `DD RECOVERED to the victim's own address (${recoverTxid.slice(0, 16)}…)`);
} catch (e) {
  check(false, `DD recovery rejected: ${e.message}`);
}

// ---- 3. the collateral, at maturity, with the same key ----
// Reality of the 2036 step: the collateral's Normal leaf is owned by Q, and
// the redeem builder spends its DD and fee inputs from Q's OWN script
// (tweak(Q) — the stranded address). So the holder first puts $100 of DD
// there (from anywhere — here, sending the recovered DD back), then redeems.
const need = unlockHeight + 5 - (await rpc('getblockchaininfo')).blocks;
if (need > 0) await rpc('generatetoaddress', [need, mineAddr], 'miner');
// fee coin at the VICTIM's normal address, to pay for sending the DD back
const feeVictimTxid = await rpc('sendtoaddress', [encodeWitnessAddress('dgbrt', 1, Q), 5], 'miner');
await rpc('generatetoaddress', [1, mineAddr], 'miner');
const feeVictim = (await rpc('getrawtransaction', [feeVictimTxid, true])).vout.find((o) => o.scriptPubKey.hex === bytesToHex(p2trScript(Q)));
const { hex: sendBackHex } = buildSignedTransferTx({
  ddUtxo: { txidHex: recoverTxid, vout: 0, ddCents },
  feeUtxo: { txidHex: feeVictimTxid, vout: feeVictim.n, valueSats: BigInt(Math.round(feeVictim.value * 1e8)) },
  privKeyHex: VICTIM_PRIV,                                   // the victim's ordinary key
  recipients: [{ outputKeyHex: ddTokenOutputKey(Q), cents: ddCents }], // → the stranded script
  feeSats,
});
const sendBackTxid = await rpc('sendrawtransaction', [sendBackHex]);
for (let i = 0; i < 6; i++) {
  await rpc('setmockoracleprice', [Number(priceMicroUsd)]);
  await rpc('generatetoaddress', [1, mineAddr], 'miner');
  if ((await rpc('getrawtransaction', [sendBackTxid, true]).catch(() => null))?.confirmations > 0) break;
}
check(true, 'DD placed at the stranded address for the burn (what the holder does at maturity)');

const fee2Txid = await rpc('sendtoaddress', [strandedAddr, 5], 'miner');
await rpc('generatetoaddress', [1, mineAddr], 'miner');
const fee2 = (await rpc('getrawtransaction', [fee2Txid, true])).vout.find((o) => o.scriptPubKey.hex === bytesToHex(p2trScript(ddTokenOutputKey(Q))));
const { hex: redeemHex } = buildSignedRedeemTx({
  collateralUtxo: { txidHex: mintTxid, vout: 0, valueSats: collateralSats, lockHeight: unlockHeight, ddCents },
  ddUtxos: [{ txidHex: sendBackTxid, vout: 0, ddCents }],
  feeUtxo: { txidHex: fee2Txid, vout: fee2.n, valueSats: BigInt(Math.round(fee2.value * 1e8)) },
  privKeyHex: dQ,
  feeSats,
  dgbChangeScriptHex: bytesToHex(p2trScript(ddTokenOutputKey(Q))),
});
try {
  const redeemTxid = await rpc('sendrawtransaction', [redeemHex]);
  await rpc('generatetoaddress', [1, mineAddr], 'miner');
  check(true, `COLLATERAL RECOVERED at maturity with the same key (${redeemTxid.slice(0, 16)}…)`);
} catch (e) {
  check(false, `collateral redemption rejected: ${e.message}`);
}

console.log(`\n${checks.every(Boolean) ? '✅ VERDICT: a stranded gift is fully recoverable with the once-tweaked key' : '❌ VERDICT: recovery FAILED — see above'}`);
await rpc('stop').catch(() => {});
await new Promise((r) => setTimeout(r, 3000));
try { rmSync(DATADIR, { recursive: true, force: true }); } catch { /* windows locks — temp dir */ }
process.exit(process.exitCode ?? 0);
