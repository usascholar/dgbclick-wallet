// Core-recipient gift spike (research only — ships nothing, changes nothing).
//
// Question: can a DIGIBYTE CORE WALLET receive a gifted (mint-to-order)
// treasury and live with it using nothing but Core RPCs?
//   1. Can the recipient's raw owner key be extracted from Core the way we'd
//      document for users (getaddressinfo → desc → tr(…) key), and does its
//      tweak really equal the address program (the Gift-key recipe)?
//   2. Does the recipient wallet SEE the gifted DD (getdigidollarbalance /
//      whatever DD accounting the build exposes)?
//   3. Can the recipient REDEEM at maturity via Core alone (redeemdigidollar)?
//
// Verdict decides whether Core-wallet users can be first-class gift
// recipients, or whether the gift note must say "restore your seed in
// Diginaut to use this".
//
// Self-contained: boots its own regtest digibyted (set DGB_BIN), mirrors
// scripts/regtest-stand.sh's activation + mock-oracle setup, then runs the
// proof. Gotchas honored from docs/discovery/mint-to-order-spike.md:
// -dandelion=0, oracle bundle per mined block, lock window, 1-hour tier.
//   DGB_BIN="C:/Program Files/DigiByte/daemon/digibyted.exe" node scripts/core-recipient-spike.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  LOCK_TIERS, requiredCollateralSats, serializeTx, xOnlyPubKey,
  buildDDVersion, buildMintMetadata, collateralOutputKey, ddTokenOutputKey,
  encodeWitnessAddress, MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS, encodeGiftKey, decodeGiftKey,
} from '../packages/digidollar-js/src/index.js';
import { p2wpkhProgramHex } from '../packages/digidollar-js/src/txbuild.js';

const DGB_BIN = process.env.DGB_BIN ?? 'C:/Program Files/DigiByte/daemon/digibyted.exe';
const RPCPORT = Number(process.env.RPCPORT) || 18510;
const RPC = `http://127.0.0.1:${RPCPORT}`;
const AUTH = 'Basic ' + Buffer.from('dd:ddpass').toString('base64');
const DATADIR = mkdtempSync(join(tmpdir(), 'dgb-core-gift-'));

const checks = [];
function check(ok, label) {
  checks.push({ ok, label });
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) process.exitCode = 1;
}

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

// ---- boot a fresh regtest node ----
console.log(`→ starting regtest node (datadir ${DATADIR})`);
const daemon = spawn(DGB_BIN, [
  '-regtest', '-server=1', `-datadir=${DATADIR}`,
  '-rpcuser=dd', '-rpcpassword=ddpass', `-rpcport=${RPCPORT}`,
  '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', '-listen=0',
  '-fallbackfee=0.001', '-dandelion=0', '-txindex=1',
], { stdio: 'ignore' });
process.on('exit', () => { try { daemon.kill(); } catch { /* gone */ } });

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await rpc('getblockchaininfo')).chain === 'regtest'; }
  catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!up) { console.error('node never came up'); process.exit(2); }

// ---- stand setup: activate DigiDollar, mock oracle ----
await rpc('createwallet', ['miner']);
const mineAddr = await rpc('getnewaddress', [], 'miner');
console.log('→ mining 651 blocks to activate DigiDollar');
await rpc('generatetoaddress', [651, mineAddr], 'miner');
const dep = await rpc('getdigidollardeploymentinfo');
if (dep.status !== 'active') { console.error(`DigiDollar not active: ${dep.status}`); process.exit(2); }
const priceMicroUsd = 13_420n;
await rpc('enablemockoracle', [true]);
await rpc('setmockoracleprice', [Number(priceMicroUsd)]);
console.log('→ DigiDollar ACTIVE, mock oracle @ 13,420 µUSD');

// ---- 1. the RECIPIENT: a plain Core wallet, driven only by RPC ----
// (descriptors explicitly on — the documented extraction path needs tr() descs)
await rpc('createwallet', ['corerecipient', false, false, '', false, true]);
const rcptAddr = await rpc('getnewaddress', ['', 'bech32m'], 'corerecipient');
const info = await rpc('getaddressinfo', [rcptAddr], 'corerecipient');
console.log(`→ recipient Core address: ${rcptAddr}`);
console.log(`  desc: ${info.desc}`);
const descKey = info.desc?.match(/tr\((?:\[[^\]]*\])?([0-9a-fA-F]{64,66})\)/)?.[1];
if (!descKey) { console.error('could not extract a key from desc — extraction recipe fails here'); process.exit(2); }
const rawKey = (descKey.length === 66 ? descKey.slice(2) : descKey).toLowerCase();

// The Gift-key recipe's own proof: tweak(extracted raw key) must equal the
// address's witness program — otherwise our documented extraction is wrong.
const program = info.witness_program ?? info.scriptPubKey?.slice(4);
check(ddTokenOutputKey(rawKey) === program,
  `extraction recipe: ddTokenOutputKey(desc key) == address program (${program.slice(0, 12)}…)`);
const giftKey = encodeGiftKey(rawKey, 'regtest');
console.log(`  Gift key: ${giftKey}`);
check(decodeGiftKey(giftKey).rawOwnerKeyHex === rawKey, 'gift key round-trips the extracted raw key');

// ---- 2. the GIVER: an independent key, hand-assembled exotic mint (the
// shipped construction, cribbed from mint-to-order-spike.mjs) ----
const { taggedHash } = schnorr.utils;
const Point = secp256k1.Point;
const CURVE_N = Point.CURVE().n;
const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const u32le = (n) => Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const u64le = (v) => { const out = new Uint8Array(8); let x = BigInt(v); for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; } return out; };
const varint = (n) => { if (n < 0xfd) return Uint8Array.from([n]); if (n <= 0xffff) return Uint8Array.from([0xfd, n & 0xff, n >>> 8]); throw new RangeError('varint too big'); };
const p2trScript = (xOnlyHex) => concat(Uint8Array.from([0x51, 0x20]), hexToBytes(xOnlyHex));
const p2wpkhScript = (privKeyHex) => concat(Uint8Array.from([0x00, 0x14]), hexToBytes(p2wpkhProgramHex(privKeyHex)));
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
  const shaScriptPubKeys = sha256(concat(...inputs.map((i) => { const spk = hexToBytes(i.scriptPubKeyHex); return concat(varint(spk.length), spk); })));
  const shaSequences = sha256(concat(...inputs.map((i) => u32le(i.sequence))));
  const shaOutputs = sha256(concat(...outputs.map((o) => concat(u64le(o.valueSats), varint(o.script.length), o.script))));
  const msg = concat(Uint8Array.from([0x00]), u32le(version), u32le(locktime), shaPrevouts, shaAmounts, shaScriptPubKeys, shaSequences, shaOutputs, Uint8Array.from([0x00]), u32le(inputIndex));
  return taggedHash('TapSighash', concat(Uint8Array.from([0x00]), msg));
}

const GIVER_PRIV = '11'.repeat(32);
const giverX = xOnlyPubKey(GIVER_PRIV);
const giverOutKey = ddTokenOutputKey(giverX);
const giverAddr = encodeWitnessAddress('dgbrt', 1, giverOutKey);
const fundTxid = await rpc('sendtoaddress', [giverAddr, 80000], 'miner'); // 1h tier = 1000% collateral
await rpc('generatetoaddress', [1, mineAddr], 'miner');
const fundRaw = await rpc('getrawtransaction', [fundTxid, true]);
const funding = fundRaw.vout.find((o) => o.scriptPubKey.hex === bytesToHex(p2trScript(giverOutKey)));
console.log(`→ giver funded: ${funding.value} DGB`);

const ddCents = 10_000n; // $100
const tier = LOCK_TIERS[0]; // 1 hour — full cycle provable in this run
const tip = (await rpc('getblockchaininfo')).blocks;
const unlockHeight = tip + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks;
const collateralSats = requiredCollateralSats({ ddCents, tierId: tier.id, oraclePriceMicroUsd: priceMicroUsd, dcaMultiplierBps: 10_000n });
const feeSats = 12_000_000n;
const fundingSats = BigInt(Math.round(funding.value * 1e8));
const changeSats = fundingSats - collateralSats - feeSats;

const inputs = [{ txidHex: fundTxid, vout: funding.n, valueSats: fundingSats, scriptPubKeyHex: bytesToHex(p2trScript(giverOutKey)), sequence: 0xfffffffd }];
const outputs = [
  { valueSats: collateralSats, script: p2trScript(collateralOutputKey({ ownerKeyHex: rawKey, lockHeight: unlockHeight, ddCents })) },
  { valueSats: 0n, script: p2trScript(ddTokenOutputKey(rawKey)) },
  { valueSats: 0n, script: hexToBytes(buildMintMetadata({ ddCents, unlockHeight, lockTier: 0, ownerKeyHex: rawKey })) },
  { valueSats: changeSats, script: p2wpkhScript(GIVER_PRIV) },
];
const version = buildDDVersion('mint');
const sighash = taprootSighash({ version, locktime: 0, inputs, outputs, inputIndex: 0 });
const sig = schnorr.sign(sighash, hexToBytes(tapTweakPrivKey(GIVER_PRIV)));
const mintHex = serializeTx({ version, locktime: 0, inputs, outputs, witnesses: [[sig]] });

const mintTxid = await rpc('sendrawtransaction', [mintHex]);
console.log(`→ gift mint broadcast: ${mintTxid}`);
for (let i = 0; i < 6; i++) {
  await rpc('setmockoracleprice', [Number(priceMicroUsd)]); // fresh oracle bundle per block
  await rpc('generatetoaddress', [1, mineAddr], 'miner');
  const mine = await rpc('getrawtransaction', [mintTxid, true]).catch(() => null);
  if (mine?.confirmations > 0) break;
  if (i === 5) { console.error('mint never confirmed'); process.exit(2); }
}
check(true, `gift mint confirmed: giver-funded, Core-recipient-owned ($100, 1h tier, unlock ${unlockHeight})`);

// ---- 3. VISIBILITY: what does the recipient's Core wallet see? ----
const ddHelp = (await rpc('help')).split('\n').filter((l) => /digidollar/i.test(l));
console.log('\n→ DigiDollar RPCs in this build:\n  ' + ddHelp.join('\n  '));
const bal = await rpc('getdigidollarbalance', [], 'corerecipient').catch((e) => ({ err: e.message }));
console.log('→ corerecipient getdigidollarbalance:', JSON.stringify(bal));
const balCents = Number(bal?.total ?? 0); // this build reports CENTS: {confirmed, unconfirmed, total, address_count}
check(balCents === 10_000, `recipient Core wallet SEES the gifted $100 DD (reported: ${JSON.stringify(bal)})`);
const positions = await rpc('listdigidollarpositions', [], 'corerecipient').catch(() => null)
  ?? await rpc('getdigidollarpositions', [], 'corerecipient').catch(() => null)
  ?? await rpc('listdigidollarcollateral', [], 'corerecipient').catch(() => null);
console.log('→ recipient positions view:', JSON.stringify(positions)?.slice(0, 400) ?? '(no positions RPC found)');

// ---- 4. REDEMPTION: mine past unlock, fee money, redeem via Core RPC only ----
await rpc('sendtoaddress', [rcptAddr, 5], 'miner'); // the fee pocket a gift note tells them to keep
const needBlocks = unlockHeight + 5 - (await rpc('getblockchaininfo')).blocks;
if (needBlocks > 0) {
  console.log(`→ mining ${needBlocks} blocks to pass unlock height ${unlockHeight}…`);
  await rpc('generatetoaddress', [needBlocks, mineAddr], 'miner');
}
// signature per this build's help: redeemdigidollar "position_id" dd_amount_cents
const redeem = await rpc('redeemdigidollar', [mintTxid, 10_000], 'corerecipient')
  .then((r) => ({ ok: r })).catch((e) => ({ err: e.message }));
if (redeem?.ok !== undefined) {
  await rpc('setmockoracleprice', [Number(priceMicroUsd)]);
  await rpc('generatetoaddress', [1, mineAddr], 'miner');
  console.log('→ redeem result:', JSON.stringify(redeem.ok).slice(0, 300));
  const after = await rpc('getbalances', [], 'corerecipient');
  console.log('→ recipient DGB balances after redeem:', JSON.stringify(after.mine));
  const gotCollateral = (after.mine.trusted + (after.mine.untrusted_pending ?? 0)) * 1e8 > Number(collateralSats) * 0.9;
  check(gotCollateral, `recipient REDEEMED via Core alone — collateral (${Number(collateralSats) / 1e8} DGB) is theirs`);
} else {
  check(false, `redeemdigidollar failed every probed signature — last: ${redeem?.err}`);
}

// ---- verdict ----
const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? '✅ VERDICT: Core wallets are FIRST-CLASS gift recipients' : `❌ VERDICT: ${failed.length} check(s) failed — Core recipients need Diginaut`}`);
await rpc('stop').catch(() => {});
await new Promise((r) => setTimeout(r, 3000));
try { rmSync(DATADIR, { recursive: true, force: true }); } catch { /* windows file locks — temp dir, OS cleans */ }
process.exit(process.exitCode ?? 0);
