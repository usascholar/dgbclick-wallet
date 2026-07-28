// Recover a gift stranded by the address-key bug — MAINNET tool.
//
// A gift minted with ownerKeyHex = the recipient's ADDRESS key Q (instead of
// their raw internal key P) is valid on chain but invisible to every shipped
// wallet. It is fully recoverable with dQ — the once-BIP341-tweaked private
// key of that address — handed to the wallet's OWN builders. Proven end to
// end against real Core in scripts/stranded-gift-recovery-spike.mjs.
//
//   node scripts/recover-stranded-gift.mjs status        # read-only, no key asked
//   node scripts/recover-stranded-gift.mjs recover-dd    # sweep the DD to a wallet you watch
//   node scripts/recover-stranded-gift.mjs redeem        # release the collateral (after maturity)
//
// SAFETY, by construction:
//  · the private key is NEVER a CLI argument (shell history) and never touches
//    disk — it is typed at a hidden prompt, held in memory, used, and dropped;
//  · the script REFUSES to continue unless the key's tweaked pubkey equals the
//    position's owner key, so a wrong/typo'd key stops before any signing;
//  · nothing is broadcast without an explicit typed "yes" after a full preview;
//  · reads chain state through YOUR node only (no third-party service).
//
// Position parameters come from recovery-position.json next to this script
// (gitignored — it names a live position). See docs/stranded-gift-recovery.md.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  xOnlyPubKey, ddTokenOutputKey, encodeWitnessAddress, decodeDDAddress, encodeDDAddress,
  buildSignedTransferTx, buildSignedRedeemTx, MIN_DD_TX_FEE_SATS,
} from '../packages/digidollar-js/src/index.js';

const CFG = JSON.parse(readFileSync(new URL('./recovery-position.json', import.meta.url), 'utf8'));
const MODE = process.argv[2] ?? 'status';
const HRP = CFG.hrp ?? 'dgb';
const NETWORK = CFG.network ?? 'mainnet';
const FEE_SATS = BigInt(CFG.feeSats ?? 12_000_000);

// ---- node RPC (yours only) ----
const RPC_URL = process.env.DGB_RPC_URL ?? CFG.rpcUrl ?? 'http://127.0.0.1:14022';
function rpcAuth() {
  if (process.env.DGB_RPC_USER) return [process.env.DGB_RPC_USER, process.env.DGB_RPC_PASS ?? ''];
  const conf = process.env.DGB_CONF ?? CFG.conf;
  if (conf) {
    const text = readFileSync(conf, 'utf8');
    const user = text.match(/^rpcuser=(.*)$/m)?.[1]?.trim();
    const pass = text.match(/^rpcpassword=(.*)$/m)?.[1]?.trim();
    if (user && pass) return [user, pass];
  }
  throw new Error('no RPC credentials: set DGB_RPC_USER/DGB_RPC_PASS, or "conf" in recovery-position.json');
}
const [RU, RP] = rpcAuth();
async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${RU}:${RP}`).toString('base64'), 'content-type': 'text/plain' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'recover', method, params }),
    signal: AbortSignal.timeout(120_000), // scantxoutset is slow by nature
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

// ---- the recovery primitive ----
const { taggedHash } = schnorr.utils;
const Point = secp256k1.Point;
const CURVE_N = Point.CURVE().n;
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
function tapTweakPrivKey(privKeyHex) {
  const d0 = BigInt('0x' + privKeyHex);
  if (d0 <= 0n || d0 >= CURVE_N) throw new Error('that is not a valid secp256k1 private key');
  const P = Point.BASE.multiply(d0).toAffine();
  const d = (P.y & 1n) === 0n ? d0 : CURVE_N - d0;
  const px = P.x.toString(16).padStart(64, '0');
  const t = BigInt('0x' + bytesToHex(taggedHash('TapTweak', hexToBytes(px))));
  return ((d + t) % CURVE_N).toString(16).padStart(64, '0');
}

const p2trScriptHex = (xOnlyHex) => '5120' + xOnlyHex;
const fmtDGB = (sats) => (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });

// ---- prompts ----
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}
/** Hidden prompt — the key is never echoed, never in argv, never written down. */
function askSecret(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => { // re-blank the line as it is typed
      if (['\n', '\r', ''].includes(String(char))) return;
      process.stdout.write('\x1b[2K\x1b[200D' + question);
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

// WIF → 32-byte hex, done HERE so a cold key never goes near an online
// converter (that is how cold keys die). base58check: [version][32-byte key]
// [optional 0x01 compressed][4-byte checksum].
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function wifToHex(wif) {
  let num = 0n;
  for (const ch of wif) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('not a valid WIF key (bad character)');
    num = num * 58n + BigInt(i);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = hexToBytes(hex);
  for (const ch of wif) { if (ch !== '1') break; bytes = Uint8Array.from([0, ...bytes]); } // leading zeros
  const body = bytes.slice(0, -4);
  const sum = bytes.slice(-4);
  const check = sha256(sha256(body)).slice(0, 4);
  if (bytesToHex(sum) !== bytesToHex(check)) throw new Error('WIF checksum failed — the key was mistyped or truncated');
  const key = body.slice(1, 33); // drop the version byte, take 32
  if (key.length !== 32) throw new Error('WIF did not contain a 32-byte key');
  return bytesToHex(key);
}

/** Ask for the key, DERIVE, and refuse to go on unless it owns this position. */
async function recoveryKey() {
  console.log('\nThe cold wallet\'s private key for the address the gift was sent to.');
  console.log('WIF (L…/K…, straight from `dumpprivkey`) or 64-hex — both accepted.');
  console.log('It is not echoed, not stored, and not passed as an argument. Ctrl+C to abort.');
  const typed = (await askSecret('private key: ')).replace(/^0x/, '');
  const raw = /^[0-9a-fA-F]{64}$/.test(typed) ? typed.toLowerCase() : wifToHex(typed);
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error('could not read that as a WIF or 64-hex private key');
  const P = xOnlyPubKey(raw);
  const Q = ddTokenOutputKey(P);
  if (Q !== CFG.ownerKeyHex) {
    throw new Error('THIS KEY DOES NOT OWN THIS POSITION.\n'
      + `  its address key: ${Q}\n  position wants : ${CFG.ownerKeyHex}\n`
      + '  → wrong wallet, wrong address index, or a typo. Nothing was signed.');
  }
  console.log('✓ key verified: its address key matches the position\'s owner key');
  return { dQ: tapTweakPrivKey(raw), Q };
}

async function confirm(what) {
  const a = await ask(`\n${what}\nType "yes" to broadcast (anything else aborts): `);
  if (a !== 'yes') { console.log('aborted — nothing was broadcast'); process.exit(0); }
}

// ---- chain reads ----
const strandedProgram = ddTokenOutputKey(CFG.ownerKeyHex);          // tweak(Q): where Q's own coins live
const strandedScriptHex = p2trScriptHex(strandedProgram);
const strandedAddress = encodeWitnessAddress(HRP, 1, strandedProgram);

async function coinsAt(scriptHex) {
  const scan = await rpc('scantxoutset', ['start', [{ desc: `raw(${scriptHex})` }]]);
  return (scan.unspents ?? []).map((u) => ({ txid: u.txid, vout: u.vout, sats: BigInt(Math.round(u.amount * 1e8)) }));
}
async function outAlive(txid, vout) {
  return Boolean(await rpc('gettxout', [txid, vout, true]));
}

async function status() {
  const { blocks } = await rpc('getblockchaininfo');
  const collAlive = await outAlive(CFG.mintTxid, 0);
  const ddAlive = await outAlive(CFG.mintTxid, 1);
  const blocksLeft = CFG.unlockHeight - blocks;
  console.log(`\nposition        ${CFG.mintTxid}`);
  console.log(`collateral      ${fmtDGB(CFG.collateralSats)} DGB — ${collAlive ? 'UNSPENT' : 'already spent/redeemed'}`);
  console.log(`digidollar      $${(CFG.ddCents / 100).toFixed(2)} — ${ddAlive ? 'UNSPENT (recoverable now)' : 'already moved'}`);
  console.log(`unlock height   ${CFG.unlockHeight.toLocaleString('en-US')} (tip ${blocks.toLocaleString('en-US')})`);
  console.log(`maturity        ${blocksLeft <= 0 ? 'REACHED — collateral is redeemable' : `${blocksLeft.toLocaleString('en-US')} blocks away (~${(blocksLeft * 15 / 86400).toFixed(0)} days)`}`);
  console.log(`\nstranded address (fund fees here)\n  ${strandedAddress}`);
  const coins = await coinsAt(strandedScriptHex);
  // zero-value outputs there are DigiDollar tokens (incl. this position's own),
  // never fee money — the fee must come from a real DGB coin at that script
  const ddThere = coins.filter((c) => c.sats === 0n);
  const spendable = coins.filter((c) => c.sats >= FEE_SATS);
  console.log(`  DGB for fees: ${spendable.length ? `${spendable.length} coin(s), largest ${fmtDGB(spendable.reduce((m, c) => (c.sats > m ? c.sats : m), 0n))} DGB` : 'NONE'}`);
  console.log(`  DD tokens at that script: ${ddThere.length} (the burn at maturity spends one)`);
  if (!spendable.length) console.log(`  → send ~1 DGB to that address before running recover-dd / redeem`);
  return { blocks, collAlive, ddAlive, coins: spendable };
}

// ---- actions ----
async function recoverDd() {
  const s = await status();
  if (!s.ddAlive) throw new Error('the DD output is already spent — nothing to recover');
  if (!s.coins.length) throw new Error(`no fee coin at the stranded address — send ~1 DGB to ${strandedAddress} first`);
  const dest = await ask('\nDestination DigiDollar address (a wallet you already watch, DD…/dgb1p…): ');
  const to = decodeDDAddress(dest);
  if (to.network !== NETWORK) throw new Error(`that address is for ${to.network}, not ${NETWORK}`);
  const { dQ } = await recoveryKey();
  const fee = s.coins.sort((a, b) => (a.sats < b.sats ? -1 : 1))[0];
  const { hex } = buildSignedTransferTx({
    ddUtxo: { txidHex: CFG.mintTxid, vout: 1, ddCents: BigInt(CFG.ddCents) },
    feeUtxo: { txidHex: fee.txid, vout: fee.vout, valueSats: fee.sats },
    privKeyHex: dQ,
    recipients: [{ outputKeyHex: to.outputKeyHex, cents: BigInt(CFG.ddCents) }],
    feeSats: FEE_SATS,
  });
  await confirm(`Send $${(CFG.ddCents / 100).toFixed(2)} DigiDollar → ${encodeDDAddress(to.outputKeyHex, NETWORK)}\n`
    + `  fee ${fmtDGB(FEE_SATS)} DGB from ${fee.txid.slice(0, 12)}…:${fee.vout}\n  tx size ${hex.length / 2} bytes`);
  console.log('txid:', await rpc('sendrawtransaction', [hex]));
  console.log('→ it appears in that wallet once confirmed (~15s).');
}

async function redeem() {
  const s = await status();
  if (!s.collAlive) throw new Error('the collateral is already spent — this position is closed');
  if (s.blocks < CFG.unlockHeight) throw new Error(`not mature yet: ${(CFG.unlockHeight - s.blocks).toLocaleString('en-US')} blocks to go`);
  if (!s.coins.length) throw new Error(`no fee coin at the stranded address — send ~1 DGB to ${strandedAddress} first`);
  // the burn must come from DD sitting at the stranded script (Q's own script)
  const ddHere = (await coinsAt(strandedScriptHex)).filter((c) => c.sats === 0n);
  if (!ddHere.length) {
    throw new Error(`no DigiDollar at the stranded address. Send $${(CFG.ddCents / 100).toFixed(2)} of DD to:\n  ${strandedAddress}\n`
      + '  (any DD works — DD is fungible), then run redeem again.');
  }
  const ddUtxo = { txidHex: ddHere[0].txid, vout: ddHere[0].vout, ddCents: BigInt(CFG.ddCents) };
  const dest = await ask('\nAddress to receive the released DGB (dgb1p…/dgb1q…): ');
  const { scriptPubKeyFromAddress } = await import('../packages/digidollar-js/src/index.js');
  const dgbChangeScriptHex = scriptPubKeyFromAddress(dest);
  const { dQ } = await recoveryKey();
  const fee = s.coins.sort((a, b) => (a.sats < b.sats ? -1 : 1))[0];
  const { hex } = buildSignedRedeemTx({
    collateralUtxo: { txidHex: CFG.mintTxid, vout: 0, valueSats: BigInt(CFG.collateralSats), lockHeight: CFG.unlockHeight, ddCents: BigInt(CFG.ddCents) },
    ddUtxos: [ddUtxo],
    feeUtxo: { txidHex: fee.txid, vout: fee.vout, valueSats: fee.sats },
    privKeyHex: dQ,
    feeSats: FEE_SATS,
    dgbChangeScriptHex,
  });
  await confirm(`Burn $${(CFG.ddCents / 100).toFixed(2)} DigiDollar and release ${fmtDGB(CFG.collateralSats)} DGB → ${dest}\n`
    + `  tx size ${hex.length / 2} bytes — THIS CLOSES THE POSITION`);
  console.log('txid:', await rpc('sendrawtransaction', [hex]));
}

try {
  if (MODE === 'status') await status();
  else if (MODE === 'recover-dd') await recoverDd();
  else if (MODE === 'redeem') await redeem();
  else { console.log('usage: node scripts/recover-stranded-gift.mjs [status|recover-dd|redeem]'); process.exit(2); }
} catch (e) {
  console.error('\n✖ ' + e.message);
  process.exit(1);
}
