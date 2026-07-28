// Mint-to-order gift driver: create + fund a wallet, gift a locked $100
// treasury to a recipient GIFT KEY the DRIVER derives independently, and check
// the full flow — review math, password gate, success view, gift note, and
// that the UI's tweak of the pasted gift key lands on the recipient's true
// address (proving the raw owner key survived encode → paste → decode).
// Output-shape guarantees (owner in collateral/token/metadata) are pinned by
// packages/digidollar-js/test/mint-to-order.test.js.
// Self-contained except Chrome (wallet server + fake indexer start here).
//
//   chrome --headless=new --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) &
//   node apps/wallet/scripts/verify-gift-mint.mjs   # exit 0 = all green
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './lib/cdp.mjs';
import { generateMnemonic, mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS, encodeGiftKey, encodeDDAddress, ddTokenOutputKey } from 'digidollar-js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IDX_PORT = Number(process.env.IDX_PORT) || 8895;
const APP_PORT = Number(process.env.APP_PORT) || 8894;
const PASS = 'gift mint driver';
const IDX = `http://127.0.0.1:${IDX_PORT}`;

// the recipient: an independent testnet wallet that exists only in this driver.
// The GIVER gets only the gift key (raw owner key, checksummed) — never the
// address; the driver independently derives what the recipient's wallet would
// show, to prove the UI's tweak of the pasted key lands on the same script.
const recipient = deriveTaprootAddress(mnemonicToSeed(generateMnemonic()), { ...HD_NETWORKS.testnet, index: 0 });
const recipientGiftKey = encodeGiftKey(recipient.internalKeyHex, 'testnet');
const recipientDDAddress = encodeDDAddress(ddTokenOutputKey(recipient.internalKeyHex), 'testnet');

const idx = spawn('node', [`${ROOT}scripts/fake-indexer.mjs`], {
  env: { ...process.env, PORT: String(IDX_PORT), TIP: '100000' }, stdio: 'ignore',
});
const app = spawn('node', [`${ROOT}server.js`], {
  env: { ...process.env, PORT: String(APP_PORT), INDEXER_URL: IDX }, stdio: 'ignore',
});
const APP = `http://127.0.0.1:${APP_PORT}`;
for (let i = 0; i < 100; i++) {
  try { await fetch(`${APP}/api/config`); await fetch(`${IDX}/api/address/x/utxos`); break; }
  catch { await new Promise((r) => setTimeout(r, 100)); }
}
await fetch(`${IDX}/__reset`, { method: 'POST' });

let b;
for (const s of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(s, (err) => { idx.kill(); app.kill(); b?.close(); if (err instanceof Error) { console.error(err); process.exit(1); } });
}
b = await connectCdp();
const { evaluate, waitFor, check, setVal, click, text, shot } = b;
const vis = (id) => `document.getElementById('${id}').style.display !== 'none'`;

// -- 1. create + fund the giver wallet --
await b.navigate(APP);
await waitFor(vis('w-none'), 'no-wallet state');
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-create');
await waitFor(vis('w-open'), 'wallet open');
await waitFor(vis('w-backup-view'), 'backup ceremony overlays');
await click('w-backup-done');
await waitFor(`!document.getElementById('w-connect-modal').classList.contains('open')`, 'ceremony dismissed');
const address = await evaluate(text('w-address'));
// THREE 6k coins (18k total): the balance covers the ~15k gift but no single
// coin does — the exact fragmentation case the consolidate helper exists for
await fetch(`${IDX}/__fund`, {
  method: 'POST',
  body: JSON.stringify({
    address,
    utxos: [
      { txid: 'dd'.repeat(32), vout: 0, valueSats: '600000000000', height: 99_000 },
      { txid: 'de'.repeat(32), vout: 0, valueSats: '600000000000', height: 99_000 },
      { txid: 'df'.repeat(32), vout: 1, valueSats: '600000000000', height: 99_000 },
    ],
  }),
});
await waitFor(`${text('w-balance')}.includes('18,000')`, 'balance paints');
check(true, 'giver wallet funded with 18,000 DGB in 3 coins');

// -- 2. the gift flow: Gift key in, address forms rejected --
await click('act-treasury');
await waitFor(vis('t-list'), 'treasury dashboard opens');
check(await evaluate(`document.getElementById('t-gift-open').style.display !== 'none'`), 'gift entry point is enabled again');
await click('t-gift-open');
await waitFor(vis('gf-form'), 'gift modal opens');
// an ADDRESS must be rejected with the teaching error — the stranded-gift bug class
await setVal('gf-to', recipient.address);
await click('gf-review');
await waitFor(`${text('gf-err')}.includes('Gift key')`, 'address paste rejected with the Gift-key explanation');
check(!(await evaluate(vis('gf-confirm'))), 'no review computed for an address');
await setVal('gf-to', recipientGiftKey);
await click('gf-review');
await waitFor(vis('gf-confirm'), 'gift review computed');
const consNote = await evaluate(text('gf-c-cons'));
check(consNote.includes('consolidate your 3 coins into one before creating the treasury'),
  `review states the consolidation step — "${consNote}"`);
check((await evaluate(text('gf-err'))) === '', 'no dead-end fragmentation error');

// -- 3. one Confirm does merge → wait → mint --
await click('gf-go');
await waitFor(vis('reauth-modal'), 'password gate');
// show/hide password toggle: one tap reveals, one tap re-hides
check(await evaluate(`document.querySelector('#reauth-pass').type`) === 'password', 're-auth field is blind by default');
check(await evaluate(`Boolean(document.querySelector('#reauth-pass').parentElement.querySelector('.pw-toggle'))`), 'eye toggle present on the re-auth field');
await evaluate(`document.querySelector('#reauth-pass').parentElement.querySelector('.pw-toggle').click()`);
check(await evaluate(`document.querySelector('#reauth-pass').type`) === 'text', 'one tap reveals the password');
await evaluate(`document.querySelector('#reauth-pass').parentElement.querySelector('.pw-toggle').click()`);
check(await evaluate(`document.querySelector('#reauth-pass').type`) === 'password', 'one tap re-hides it');
await setVal('reauth-pass', PASS);
await click('reauth-go');
await waitFor(`${text('gf-out')}.includes('Step 1') || ${text('gf-out')}.includes('Waiting for the merge')`, 'step 1: merging', 15_000);
check(true, 'step 1: consolidation broadcasts first');
// the chain would now confirm the merged coin — simulate it while the flow waits
await fetch(`${IDX}/__fund`, {
  method: 'POST',
  body: JSON.stringify({ address, utxos: [{ txid: 'dd'.repeat(32), vout: 0, valueSats: '1799970000000', height: 100_000 }] }),
});
await waitFor(`document.getElementById('gift-modal').classList.contains('success')`, 'gift minted after the merge confirms', 60_000);
check(true, 'step 2: mint proceeds automatically once the merge confirms');
// the decisive cross-check: the UI's tweak of the pasted gift key must equal
// the DD address the driver derived INDEPENDENTLY from the recipient's seed —
// the raw owner key survived encode → paste → decode → tweak intact
check((await evaluate(text('gf-c-to'))).startsWith(recipientDDAddress),
  `review names the recipient's true wallet address (${recipientDDAddress.slice(0, 12)}…)`);
check((await evaluate(text('gf-c-dd'))) === '100.00', 'review: $100 DigiDollar');
const coll = await evaluate(text('gf-c-coll'));
check(Number(coll.replace(/,/g, '')) > 10_000, `review: collateral quoted in DGB (${coll})`);
check((await evaluate(text('gf-c-unlock'))).includes('block'), 'review: unlock height shown');

await click('gf-go');
await waitFor(vis('reauth-modal'), 'password gate before the irreversible mint');
await setVal('reauth-pass', PASS);
await click('reauth-go');
await waitFor(`document.getElementById('gift-modal').classList.contains('success')`, 'gift success view', 30_000);
check((await evaluate(`document.querySelector('#gift-modal .tx-title').textContent`)) === 'Gift minted', 'success: Gift minted');
check(await evaluate(vis('gf-note')), 'success: gift note download offered');
await shot('01-gift-success.png');

// -- 3. the broadcast log is clean (record removed on success) --
const log = await evaluate(`localStorage.getItem('diginaut.pendingBroadcasts')`);
check(!log || JSON.parse(log).length === 0, 'no pending broadcasts left after success');

console.log('\nDone.');
b.close();
process.exit(process.exitCode || 0);
