// Regtest proof for the four fee-leg shapes introduced when the redeem/transfer
// fee leg learned to take any of the wallet's coins (own key, P2TR or P2WPKH):
//   1. redeem  with a P2WPKH fee coin           (the mint-change shape, incident #1)
//   2. redeem  with a fee coin on ANOTHER key   (P2TR)
//   3. transfer with a P2WPKH fee coin
//   4. transfer with a fee coin on ANOTHER key  (P2TR)
// Unit tests assert witness SHAPES; only a real node proves signature VALIDITY.
// Requires the regtest stand: DD_E2E_RPC=http://dd:ddpass@127.0.0.1:18500
import {
  buildSignedMintTx, buildSignedRedeemTx, buildSignedTransferTx,
  xOnlyPubKey, encodeWitnessAddress, ddTokenOutputKey,
} from 'digidollar-js';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32 } from '@scure/base';

const RPC_URL = process.env.DD_E2E_RPC;
if (!RPC_URL) { console.error('set DD_E2E_RPC'); process.exit(1); }

async function rpc(method, params = [], wallet) {
  const url = new URL(RPC_URL);
  const auth = Buffer.from(`${url.username}:${url.password}`).toString('base64');
  const res = await fetch(`${url.origin}/${wallet ? `wallet/${wallet}` : ''}`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'text/plain' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'spike', method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}
const sats = (btc) => BigInt(Math.round(btc * 1e8));

// p2wpkh address for a raw privkey (compressed pubkey hash160, bech32 v0)
function p2wpkhAddressOf(privKeyHex) {
  const pub = secp256k1.getPublicKey(Buffer.from(privKeyHex, 'hex'), true);
  const h160 = createHash('ripemd160').update(createHash('sha256').update(pub).digest()).digest();
  return bech32.encode('dgbrt', [0, ...bech32.toWords(h160)]);
}

async function fundAddress(address, amountDgb, miner) {
  const txid = await rpc('sendtoaddress', [address, amountDgb], 'stand');
  await rpc('generatetoaddress', [1, miner], 'stand');
  const tx = await rpc('getrawtransaction', [txid, true]);
  const vout = tx.vout.findIndex((o) => o.scriptPubKey.address === address);
  assert.notEqual(vout, -1, `funding vout for ${address}`);
  return { txidHex: txid, vout, valueSats: sats(tx.vout[vout].value) };
}

async function mintPosition(privKeyHex, ddCents, fundDgb, miner) {
  await rpc('setmockoracleprice', [13_420]);
  const funding = await fundAddress(encodeWitnessAddress('dgbrt', 1, ddTokenOutputKey(xOnlyPubKey(privKeyHex))), fundDgb, miner);
  const tipHeight = await rpc('getblockcount');
  const { hex, collateralSats, unlockHeight } = buildSignedMintTx({
    utxo: funding, privKeyHex, ddCents, tierId: '1hour', oraclePriceMicroUsd: 13_420n, tipHeight,
  });
  const txid = await rpc('sendrawtransaction', [hex]);
  await rpc('generatetoaddress', [1, miner], 'stand');
  return {
    collateralUtxo: { txidHex: txid, vout: 0, valueSats: collateralSats, lockHeight: unlockHeight, ddCents },
    ddUtxo: { txidHex: txid, vout: 1, ddCents },
    unlockHeight,
  };
}

const miner = await rpc('getnewaddress', ['', 'bech32m'], 'stand');
await rpc('setmockoracleprice', [13_420]);

const results = [];
const shape = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}: ${e.message.slice(0, 140)}`); }
};

// ---- shapes 1+2: redeem ----
for (const [name, feeKind] of [['redeem + P2WPKH fee coin (mint-change shape)', 'p2wpkh'], ['redeem + fee coin on ANOTHER key (P2TR)', 'otherP2tr']]) {
  await shape(name, async () => {
    const owner = randomBytes(32).toString('hex');
    const other = randomBytes(32).toString('hex');
    const pos = await mintPosition(owner, 10_000n, 100_000, miner); // $100 @ 1h tier
    // fee coin per shape: owner's OWN p2wpkh twin, or the other key's P2TR
    const feeKey = feeKind === 'p2wpkh' ? owner : other;
    const feeAddr = feeKind === 'p2wpkh'
      ? p2wpkhAddressOf(owner)
      : encodeWitnessAddress('dgbrt', 1, ddTokenOutputKey(xOnlyPubKey(other)));
    const feeUtxo = { ...(await fundAddress(feeAddr, 2, miner)), ...(feeKind === 'p2wpkh' ? { type: 'p2wpkh' } : {}) };
    // ride past the lock
    const tip = await rpc('getblockcount');
    if (tip <= pos.unlockHeight) await rpc('generatetoaddress', [pos.unlockHeight - tip + 1, miner], 'stand');
    await rpc('setmockoracleprice', [13_420]);
    const { hex } = buildSignedRedeemTx({
      collateralUtxo: pos.collateralUtxo, ddUtxos: [pos.ddUtxo], feeUtxo,
      privKeyHex: owner, feePrivKeyHex: feeKey,
    });
    const txid = await rpc('sendrawtransaction', [hex]); // consensus is the judge
    await rpc('generatetoaddress', [1, miner], 'stand');
    assert.ok((await rpc('getrawtransaction', [txid, true])).confirmations >= 1, 'mined');
  });
}

// ---- shapes 3+4: transfer ----
for (const [name, feeKind] of [['transfer + P2WPKH fee coin', 'p2wpkh'], ['transfer + fee coin on ANOTHER key (P2TR)', 'otherP2tr']]) {
  await shape(name, async () => {
    const owner = randomBytes(32).toString('hex');
    const other = randomBytes(32).toString('hex');
    const recipient = randomBytes(32).toString('hex');
    const pos = await mintPosition(owner, 10_000n, 100_000, miner);
    const feeKey = feeKind === 'p2wpkh' ? owner : other;
    const feeAddr = feeKind === 'p2wpkh'
      ? p2wpkhAddressOf(owner)
      : encodeWitnessAddress('dgbrt', 1, ddTokenOutputKey(xOnlyPubKey(other)));
    const feeUtxo = { ...(await fundAddress(feeAddr, 2, miner)), ...(feeKind === 'p2wpkh' ? { type: 'p2wpkh' } : {}) };
    await rpc('setmockoracleprice', [13_420]);
    const { hex } = buildSignedTransferTx({
      ddUtxo: pos.ddUtxo, feeUtxo, privKeyHex: owner, feePrivKeyHex: feeKey,
      recipients: [{ outputKeyHex: ddTokenOutputKey(xOnlyPubKey(recipient)), cents: 4_000n }],
    });
    const txid = await rpc('sendrawtransaction', [hex]);
    await rpc('generatetoaddress', [1, miner], 'stand');
    assert.ok((await rpc('getrawtransaction', [txid, true])).confirmations >= 1, 'mined');
  });
}

console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
