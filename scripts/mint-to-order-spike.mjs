// Mint-to-order consensus spike (research only — ships nothing, changes nothing).
//
// Question: does DigiByte Core's ValidateMintTransaction accept a mint whose
// FUNDING input is signed by key A (the "seller"), while the collateral
// output, DD-token output and metadata all name key B (the "buyer") as owner?
//   YES → mint-to-order is a lib parameter away (owner ≠ funder).
//   NO  → it is protocol-impossible without a Core change.
//
// The exotic mint is hand-assembled here, replicating txbuild.js's mint
// construction exactly (BIP-341 key-path, same output layout) with the ONE
// difference that ownerKeyHex = B while the funding coin + signature are A's.
// packages/digidollar-js is used read-only for its exported primitives.
//
// Prereq: a running regtest stand (scripts/regtest-stand.sh --keep) with the
// mock oracle at 13420 µUSD and DigiDollar active.
//   node scripts/mint-to-order-spike.mjs
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  LOCK_TIERS, requiredCollateralSats, serializeTx, xOnlyPubKey,
  buildDDVersion, buildMintMetadata, collateralOutputKey, ddTokenOutputKey,
  encodeWitnessAddress, MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS, buildSignedRedeemTx,
  scriptPubKeyFromAddress, MIN_DD_TX_FEE_SATS,
} from '../packages/digidollar-js/src/index.js';
import { p2wpkhProgramHex } from '../packages/digidollar-js/src/txbuild.js';

const RPC = 'http://127.0.0.1:18500';
const AUTH = 'Basic ' + Buffer.from('dd:ddpass').toString('base64');
async function rpc(method, params = [], wallet = 'stand') {
  const res = await fetch(RPC + (wallet ? `/wallet/${wallet}` : ''), {
    method: 'POST',
    headers: { 'content-type': 'text/plain', authorization: AUTH },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'spike', method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

// ---- minimal replicates of txbuild.js internals (not exported by design) ----
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
const u64le = (v) => {
  const out = new Uint8Array(8);
  let x = BigInt(v);
  for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
const varint = (n) => {
  if (n < 0xfd) return Uint8Array.from([n]);
  if (n <= 0xffff) return Uint8Array.from([0xfd, n & 0xff, n >>> 8]);
  throw new RangeError('varint too big');
};
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
  const shaScriptPubKeys = sha256(concat(...inputs.map((i) => {
    const spk = hexToBytes(i.scriptPubKeyHex);
    return concat(varint(spk.length), spk);
  })));
  const shaSequences = sha256(concat(...inputs.map((i) => u32le(i.sequence))));
  const shaOutputs = sha256(concat(...outputs.map((o) => concat(u64le(o.valueSats), varint(o.script.length), o.script))));
  const msg = concat(
    Uint8Array.from([0x00]),
    u32le(version), u32le(locktime),
    shaPrevouts, shaAmounts, shaScriptPubKeys, shaSequences, shaOutputs,
    Uint8Array.from([0x00]),
    u32le(inputIndex),
  );
  return taggedHash('TapSighash', concat(Uint8Array.from([0x00]), msg));
}

// deterministic keys (spike only — never anywhere near a wallet)
const SELLER_PRIV = '11'.repeat(32); // A: funds and signs
const BUYER_PRIV = '22'.repeat(32); // B: named owner of everything
const TIER_ARG = process.argv[2] ?? '1h';
const buyerX = xOnlyPubKey(BUYER_PRIV);

// ---- 1. fund the seller on regtest ----
const sellerX = xOnlyPubKey(SELLER_PRIV);
const sellerOutKey = ddTokenOutputKey(sellerX); // BIP-86-tweaked key-path P2TR key
const sellerAddr = encodeWitnessAddress('dgbrt', 1, sellerOutKey);
const fundTxid = await rpc('sendtoaddress', [sellerAddr, TIER_ARG === '1h' ? 80000 : 20000]); // 1h tier = 1000% collateral
await rpc('generatetoaddress', [1, (await rpc('getnewaddress'))]);
const raw = await rpc('getrawtransaction', [fundTxid, true]);
const funding = raw.vout.find((o) => o.scriptPubKey.hex === bytesToHex(p2trScript(sellerOutKey)));
if (!funding) throw new Error('funding output not found in ' + fundTxid);
console.log(`funded seller A at ${sellerAddr} — ${funding.value} DGB in ${fundTxid}:${funding.n}`);

// ---- 2. hand-build the exotic mint: A funds/signs, B owns (1-hour tier so
// the full cycle — including the buyer's own redemption — is provable today) ----
const ddCents = 10_000n; // $100 — the protocol floor
const tier = LOCK_TIERS.find((t) => t.id === TIER_ARG) ?? LOCK_TIERS[0]; // 1h default: redeemable in this session
const DO_REDEEM = tier === LOCK_TIERS[0];
const priceMicroUsd = 13_420n; // the stand's mock oracle price
const tip = (await rpc('getblockchaininfo')).blocks;
const unlockHeight = tip + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks;
const collateralSats = requiredCollateralSats({ ddCents, tierId: tier.id, oraclePriceMicroUsd: priceMicroUsd, dcaMultiplierBps: 10_000n });
const feeSats = 12_000_000n;
const fundingSats = BigInt(Math.round(funding.value * 1e8));
// (funding amount must cover the tier's collateral)
const changeSats = fundingSats - collateralSats - feeSats;
if (changeSats <= 0n) throw new Error('funding too small');

const inputs = [{ txidHex: fundTxid, vout: funding.n, valueSats: fundingSats, scriptPubKeyHex: bytesToHex(p2trScript(sellerOutKey)), sequence: 0xfffffffd }];
const outputs = [
  { valueSats: collateralSats, script: p2trScript(collateralOutputKey({ ownerKeyHex: buyerX, lockHeight: unlockHeight, ddCents })) },
  { valueSats: 0n, script: p2trScript(ddTokenOutputKey(buyerX)) },
  { valueSats: 0n, script: hexToBytes(buildMintMetadata({ ddCents, unlockHeight, lockTier: LOCK_TIERS.indexOf(tier), ownerKeyHex: buyerX })) },
  { valueSats: changeSats, script: p2wpkhScript(SELLER_PRIV) },
];
const version = buildDDVersion('mint');
const sighash = taprootSighash({ version, locktime: 0, inputs, outputs, inputIndex: 0 });
const sig = schnorr.sign(sighash, hexToBytes(tapTweakPrivKey(SELLER_PRIV)));
const hex = serializeTx({ version, locktime: 0, inputs, outputs, witnesses: [[sig]] });

// ---- 3. the verdict ----
console.log(`broadcasting exotic mint: funder/signer = A, owner = B, $100 DD @ ${tier.label}, unlock ${unlockHeight}`);
let mintTxid;
try {
  mintTxid = await rpc('sendrawtransaction', [hex], '');
  console.log(`\n✅ ACCEPTED by Core (mempool): txid ${mintTxid}`);
  console.log('→ mint-to-order is CONSENSUS-VALID: the funding key need not be the owner key.');
  // DD txs are only mined in blocks carrying a fresh MuSig2 oracle bundle; the
  // mock oracle produces one per setmockoracleprice call, so force bundles until
  // the mint lands inside its lock window (a stale window is bad-lock-period).
  for (let i = 0; i < 6; i++) {
    await rpc('setmockoracleprice', [Number(priceMicroUsd)], '');
    await rpc('generatetoaddress', [1, (await rpc('getnewaddress'))]);
    const mine = await rpc('getrawtransaction', [mintTxid, true], '').catch(() => null);
    if (mine?.confirmations > 0) {
      console.log(`confirmed in block ${mine.blockhash} — the buyer-owned position is on chain.`);
      break;
    }
    if (i === 5) throw new Error('mint never confirmed inside its lock window');
  }
} catch (e) {
  console.log(`\n❌ REJECTED by Core: ${e.message}`);
  console.log('→ the funding input must belong to the metadata owner key: mint-to-order is');
  console.log('  protocol-impossible without a Core change; "send DGB → recipient mints" is');
  console.log('  the only construction.');
  process.exitCode = 1;
  process.exit();
}

if (DO_REDEEM) {
// ---- 4. the full cycle: B redeems WITHOUT A, using the shipped lib's own
// redeem builder unmodified. B burns the minted DD and signs the collateral's
// Normal leaf — if B can do this, ownership is really B's, end to end. ----
console.log(`\nmining to unlock height ${unlockHeight}…`);
// B needs fee money of their own (a gift should include a fee pocket!)
const buyerAddr = encodeWitnessAddress('dgbrt', 1, ddTokenOutputKey(buyerX));
const feeTxid = await rpc('sendtoaddress', [buyerAddr, 5]);
const needBlocks = unlockHeight + 5 - (await rpc('getblockchaininfo')).blocks;
if (needBlocks > 0) await rpc('generatetoaddress', [needBlocks, (await rpc('getnewaddress'))]);
const tipNow = (await rpc('getblockchaininfo')).blocks;
if (tipNow < unlockHeight) throw new Error(`chain did not reach unlock height (${tipNow} < ${unlockHeight})`);

const feeRaw = await rpc('getrawtransaction', [feeTxid, true]);
const buyerSpk = bytesToHex(p2trScript(ddTokenOutputKey(buyerX)));
const feeCoin = feeRaw.vout.find((o) => o.scriptPubKey.hex === buyerSpk);
if (!feeCoin) throw new Error('no fee coin at the buyer address');

const { hex: redeemHex } = buildSignedRedeemTx({
  collateralUtxo: { txidHex: mintTxid, vout: 0, valueSats: collateralSats, lockHeight: unlockHeight, ddCents },
  ddUtxos: [{ txidHex: mintTxid, vout: 1, ddCents }],
  feeUtxo: { txidHex: feeTxid, vout: feeCoin.n, valueSats: BigInt(Math.round(feeCoin.value * 1e8)) },
  privKeyHex: BUYER_PRIV,
  feeSats,
  dgbChangeScriptHex: bytesToHex(p2trScript(ddTokenOutputKey(buyerX))),
});
try {
  const redeemTxid = await rpc('sendrawtransaction', [redeemHex], '');
  console.log(`✅ BUYER REDEEMED unaided: txid ${redeemTxid}`);
  await rpc('generatetoaddress', [1, (await rpc('getnewaddress'))]);
  console.log('→ the buyer burned the DD and released the collateral with ONLY key B —');
  console.log('  full-cycle mint-to-order is proven: fund with A, own with B, no third party.');
} catch (e) {
  console.log(`❌ buyer redemption REJECTED: ${e.message}`);
  console.log("→ the mint was accepted but the position is not cleanly the buyer's —");
  console.log('  mint-to-order is NOT safe to ship.');
  process.exitCode = 1;
}
}
