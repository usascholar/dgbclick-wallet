// Treasury split wizard driver (FR-1 happy path + dashboard + FR-4 guard):
// create a wallet, fund it, split into 3 treasuries through the full 4-step
// wizard, watch the batch finish, then check the dashboard card and the
// DD-spend guard. Self-contained except Chrome (wallet server + fake indexer
// start here; the indexer's /__auto mode answers for freshly generated
// treasury addresses — enabled only around the batch so it can't inflate the
// MAIN wallet's balance poll).
//
//   chrome --headless=new --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) &
//   node apps/wallet/scripts/verify-treasury-split.mjs   # exit 0 = all green
// A FRESH user-data-dir per run is required (IndexedDB carries the vault).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './lib/cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IDX_PORT = Number(process.env.IDX_PORT) || 8897;
const APP_PORT = Number(process.env.APP_PORT) || 8896;
const PASS = 'treasury split driver';
const IDX = `http://127.0.0.1:${IDX_PORT}`;

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
const post = (path, body) => fetch(IDX + path, { method: 'POST', body: JSON.stringify(body) });

// -- 1. create the funding wallet --
await b.navigate(APP);
await waitFor(vis('w-none'), 'no-wallet state');
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-create');
await waitFor(vis('w-open'), 'wallet open');
await waitFor(vis('w-backup-view'), 'backup ceremony overlays');
await click('w-backup-done'); // mock chain = testnet: skip is allowed
await waitFor(`!document.getElementById('w-connect-modal').classList.contains('open')`, 'ceremony dismissed');
check(true, 'funding wallet created');

// -- 2. fund it: 60,000 DGB in one confirmed coin (3 treasuries need ≈ 46.2k) --
const address = await evaluate(text('w-address'));
// TEN 6k coins, not one 60k: the split wizard funds treasuries with MULTI-INPUT
// sends (planSpend), so a fragmented funder needs no consolidation — the mint's
// single coin is created by the funding tx itself. This proves it.
const dust = Array.from({ length: 10 }, (_, i) => ({
  txid: String(i + 10).padStart(2, '0').repeat(32), vout: i % 2, valueSats: '600000000000', height: 99_000,
}));
await post('/__fund', { address, utxos: dust });
await waitFor(`${text('w-balance')}.includes('60,000')`, 'balance paints 60,000 DGB');
check(true, 'funding wallet holds 60,000 DGB across 10 small coins (fragmented on purpose)');

// -- 3. the wizard: USD total → size → names → review --
await click('act-treasury');
await waitFor(vis('t-list'), 'treasury dashboard opens');
await click('t-split-open');
await waitFor(vis('sp-step-1'), 'wizard step 1');
// budget semantics: the total (DGB = USD) is stated first, and a budget too
// small for one $100-DD treasury (+ its ~2x collateral) is reminded, not advanced
await waitFor(`${text('sp-total')}.includes('Total: 60,000')`, 'step 1 leads with Total: DGB = USD');
const totalLine = await evaluate(text('sp-total'));
check(/\$[\d,]+\.\d{2}/.test(totalLine) && !totalLine.includes('NaN'),
  `total states a REAL USD value — "${totalLine}"`);
await setVal('sp-amount', '50');
await click('sp-next-1');
await waitFor(`${text('sp-err-1')}.includes('minimum of $100')`, 'sub-minimum budget gets the $100-per-treasury reminder');
check(!(await evaluate(vis('sp-step-2'))), 'wizard does not advance below the floor');
await setVal('sp-amount', '620'); // ≈ 3 × $202 per-treasury cost at the mock price
await click('sp-next-1');
await waitFor(`${text('sp-preview')}.includes('Collateral per treasury')`, 'step 2 preview computed');
const preview = await evaluate(text('sp-preview'));
check(/Treasuries\s*3 × \$100/.test(preview.replace(/\s+/g, ' ')), `step 2: 3 × $100 treasuries at the mock price — ${preview.split('\n')[0]}`);

await click('sp-next-2');
await waitFor(vis('sp-step-3'), 'wizard step 3 (names)');
const nameInputs = await evaluate(`[...document.querySelectorAll('#sp-names [data-name-i]')].map((el) => el.value)`);
check(nameInputs.length === 3 && nameInputs.every((n, i) =>
  new RegExp(`^DD100-\\d{4}-\\d{2}-\\d{2}-${'ABC'[i]}$`).test(n)),
  `step 3: self-describing names suggested — ${nameInputs.join(', ')}`);

await click('sp-next-3');
await waitFor(vis('sp-step-4'), 'wizard step 4 (review)');
const review = await evaluate(text('sp-review'));
check(review.includes('create 3 new wallets') && review.includes('$100 DigiDollar') && review.includes('cannot be spent'),
  'step 4: plain-English review with lock-in warning');

// -- 4. execute the batch (auto-indexer answers for the new treasury addresses) --
await post('/__auto', { on: true });
await click('sp-create');
await waitFor(vis('reauth-modal'), 'password confirmation gates the batch');
await setVal('reauth-pass', PASS);
await click('reauth-go');
await waitFor(`${text('sp-progress-title')}.includes('All 3 treasuries are created')`, 'batch completes', 60_000);
check(true, 'batch engine created + funded + minted all 3 treasuries');
// /__auto stays ON through the dashboard checks — it only answers for UNFUNDED
// addresses (the treasuries); the main wallet has an explicit entry.

// -- 5. the registry tells the truth --
const registry = await evaluate(`JSON.parse(localStorage.getItem('diginaut.treasuries.v1'))`);
const treasuries = Object.values(registry.treasuries);
check(treasuries.length === 3, `registry: 3 treasury records`);
check(treasuries.every((t) => t.mint.positionTxid && BigInt(t.mint.collateralSats) > 0n && t.mint.unlockHeight > 100_000),
  'registry: every record has positionTxid, collateral and unlock height from the mints');
const batches = Object.values(registry.batches);
check(batches.length === 1 && batches[0].state === 'done' && batches[0].items.every((i) => i.state === 'done'),
  'registry: the batch record is fully done (resume would be a no-op)');

// -- 6. the dashboard card --
await evaluate(`document.querySelector('#split-modal [data-close]').click()`);
await click('act-treasury');
await waitFor(`${text('t-list')}.includes('DD100-')`, 'dashboard lists the treasuries');
const listText = await evaluate(text('t-list'));
check(listText.includes('DigiDollar minted') && listText.includes('Fee pocket'), 'card: DD minted + fee pocket rows');
check(listText.includes('✅ DD intact'), 'card: DD-intact flag (FR-4)');
check(listText.includes('Locked'), 'card: Locked status');
const agg = await evaluate(text('t-agg'));
check(agg.includes('300.00'), `aggregate: $300 total DD minted — ${agg.replace(/\s+/g, ' ')}`);
await shot('01-treasury-dashboard.png');

// -- 6b. every Activity row offers the FULL txid for copy (debugging) --
await evaluate(`document.querySelector('#treasury-modal [data-close]').click()`);
await waitFor(`${text('w-history')}.length > 10`, 'activity rows present');
const copyTxid = await evaluate(`document.querySelector('#w-history .icon-btn[data-copy-text]')?.dataset.copyText ?? ''`);
check(/^[0-9a-f]{64}$/.test(copyTxid), `Activity row carries a full-txid copy button (${copyTxid.slice(0, 16)}…)`);
// the gift flow is back, on the Gift-key construction (verify-gift-mint.mjs
// proves the flow itself; here just that the entry point is offered again)
check(await evaluate(`document.getElementById('t-gift-open').style.display`) !== 'none',
  'gift entry point is enabled (Gift-key construction)');

// -- 7. FR-4: spending DD out of a treasury is a hard warning first --
await evaluate(`document.querySelector('#t-list [data-t-open]').click()`);
await waitFor(vis('w-open'), 'treasury wallet open');
await click('act-send');
await evaluate(`{ const s = document.getElementById('send-asset'); s.value = 'dd'; s.dispatchEvent(new Event('change', { bubbles: true })); }`);
await setVal('w-tr-to', address); // any valid recipient — the guard fires before planning
await setVal('w-tr-amount', '10');
await click('w-tr-review');
await waitFor(`document.getElementById('t-guard-modal').classList.contains('open')`, 'FR-4 guard modal blocks the review');
check(true, 'FR-4: DD spend out of a treasury triggers the hard warning');
await click('t-guard-cancel');
await waitFor(`!document.getElementById('t-guard-modal').classList.contains('open')`, 'guard cancelled');
check(await evaluate(vis('w-tr-confirm')) === false, 'FR-4: Cancel aborts the review — no confirm screen');
const reg2 = await evaluate(`JSON.parse(localStorage.getItem('diginaut.treasuries.v1'))`);
check(Object.values(reg2.treasuries).every((t) => t.ddMovedWarning === null),
  'FR-4: cancel logs no override');

await shot('02-treasury-guard.png');
console.log('\nDone.');
b.close();
process.exit(process.exitCode || 0);
