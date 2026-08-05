// Drive the per-transaction spend ceiling (txcap.js) — MOCK MODE, self-contained
// except Chrome.
//
// The ceiling is a guardrail on real money, and the only thing standing between
// "the user chose this" and "the user clicked past this" is the ceremony. So
// what is asserted here is not that the setting works, but that it CANNOT be
// loosened by accident:
//   - a raise stores nothing until the exact phrase is typed
//   - abandoning the ceremony leaves both the ceiling AND the select untouched
//   - tightening never asks for a ceremony (confirming a safer choice only
//     teaches people to click through)
//   - the banner states the ceiling actually in force, so it never reads as a
//     promise the wallet is no longer keeping
//   - the gate itself moves with the setting, on the real send path
//
// Setup (fresh --user-data-dir per run — localStorage carries the setting):
//   PORT=8791 node apps/wallet/server.js &
//   google-chrome --headless=new --remote-debugging-port=9224 \
//     --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-txcap.mjs      # exit 0 = all green
import { connectCdp } from './lib/cdp.mjs';

const APP = process.env.APP_URL || 'http://127.0.0.1:8791';
const PHRASE = 'I ACCEPT THE RISK';

const b = await connectCdp();
const { evaluate, waitFor, check, shot } = b;

const stored = () => evaluate(`localStorage.getItem('diginaut.txcap')`);
const capOpen = () => `document.getElementById('txcap-modal').classList.contains('open')`;
const selectValue = () => evaluate(`document.getElementById('w-txcap').value`);
const pick = (v) => evaluate(
  `{ const s = document.getElementById('w-txcap'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change',{bubbles:true})); }`,
);
const type = (v) => evaluate(
  `{ const i = document.getElementById('w-txcap-input'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input',{bubbles:true})); }`,
);
const goDisabled = () => evaluate(`document.getElementById('w-txcap-go').disabled`);

await b.navigate(APP);
// NOT `#w-txcap !== null`: the select ships in the static markup, so that is
// true before app.js has booted and attached the change listener — the driver
// then picks a value into the void and waits 20s for a ceremony nobody armed.
// enhanceSelect() wraps the native select in a .dd container during boot, one
// line after the setting is wired, so the wrapper is the honest ready signal.
await waitFor(`document.getElementById('w-txcap').parentNode.classList.contains('dd')`,
  'app booted and wired the limit setting');

// ---- the shipped default is the strict one, with nothing stored ----
check((await stored()) === null, 'nothing is stored until the user chooses — an untouched profile is at the default');
check((await selectValue()) === '500', 'the select shows the $500 beta ceiling');

// ---- raising opens the ceremony and stores NOTHING yet ----
await pick('10000');
await waitFor(capOpen(), 'raising opens the risk ceremony');
check((await stored()) === null, 'opening the ceremony stores nothing — the ceiling is unchanged so far');
check(await goDisabled(), 'the confirm button starts disarmed');
check((await evaluate(`document.getElementById('w-txcap-new').textContent`)) === '$10,000'
  && (await evaluate(`document.getElementById('w-txcap-old').textContent`)) === '$500',
  'the ceremony names both the old and the new ceiling');

const body = await evaluate(`document.getElementById('txcap-modal').innerText`);
check(/no liability/i.test(body) && /without warranty/i.test(body),
  'the ceremony states the no-warranty, no-liability position');
check(/irreversible/i.test(body) && /no server-side backup/i.test(body),
  'the ceremony names the concrete risks, not just a generic warning');
check(/enforced\s+in this page only/i.test(body),
  'the ceremony is honest that the limit is a guardrail, not a security control');
await shot('80-txcap-ceremony.png');

// ---- the phrase must be exact ----
await type('i accept the risk');
check(await goDisabled(), 'a lower-case phrase does NOT arm the button');
await type('I ACCEPT THE RISKS');
check(await goDisabled(), 'a near-miss phrase does NOT arm the button');
await type(PHRASE);
check(!(await goDisabled()), 'the exact phrase arms the button');

// ---- abandoning must leave BOTH the ceiling and the UI truthful ----
// "The UI" means the element the user can SEE. The native select is hidden
// behind a styled dropdown facade, and an earlier version of this driver only
// checked the hidden select — which was truthful while the visible label kept
// showing the declined choice indefinitely. Assert the facade label itself.
const visibleLabel = () => evaluate(
  `document.getElementById('w-txcap').parentNode.querySelector('.dd-label').textContent`,
);
check((await visibleLabel()).includes('$10,000'),
  'sanity: picking a raise updates the visible label before the ceremony resolves');
await evaluate(`document.getElementById('w-txcap-cancel').click()`);
await waitFor(`!${capOpen()}`, 'cancel closes the ceremony');
check((await stored()) === null, 'an abandoned ceremony stores nothing');
check((await selectValue()) === '500',
  'and the select snaps back to the ceiling still in force — no UI claiming a raise that did not happen');
check((await visibleLabel()).includes('$500'),
  'the VISIBLE dropdown label snaps back too — the user-facing UI must not keep showing the declined limit');

// ---- completing it applies, and the banner follows ----
await pick('10000');
await waitFor(capOpen(), 'ceremony again');
await type(PHRASE);
await evaluate(`document.getElementById('w-txcap-go').click()`);
await waitFor(`!${capOpen()}`, 'confirming closes the ceremony');
check((await stored()) === '10000', 'the accepted ceiling is persisted for this device');
check((await visibleLabel()).includes('$10,000'), 'the visible label shows the accepted ceiling');

const nc = `(await import('/netchrome.js'))`;
const tc = `(await import('/txcap.js'))`;
const bannerAt = async () => evaluate(`(async () => ${nc}.networkChrome('main', ${tc}.readTxCapUsd()).banner)()`);
check(/\$10,000\/tx cap/.test(await bannerAt()),
  'the mainnet banner states the ceiling actually in force, not the shipped $500');

// ---- the gate moves with the setting ----
const gateAt = async (usd) => evaluate(
  `(async () => ${nc}.betaCapError('mainnet', ${usd}, ${tc}.readTxCapUsd()))()`,
);
check((await gateAt(5000)) === null, '$5,000 is allowed under the accepted $10,000 ceiling');
check(/\$10,000/.test(await gateAt(12000)), '$12,000 is still refused, naming the ceiling the user set');

// ---- no limit: the loudest path ----
await pick('unlimited');
await waitFor(capOpen(), 'removing the ceiling opens the ceremony too');
check((await evaluate(`document.getElementById('w-txcap-unlimited').style.display`)) === 'block',
  'choosing No limit shows the extra warning about mistyped amounts');
await type(PHRASE);
await evaluate(`document.getElementById('w-txcap-go').click()`);
await waitFor(`!${capOpen()}`, 'confirmed');
check((await stored()) === 'unlimited', 'no-limit is stored as its own sentinel, not as a number');
check((await gateAt(1000000)) === null, 'nothing is refused once the user has removed the ceiling');
const noneBanner = await bannerAt();
check(/NO per-tx limit: you removed it/.test(noneBanner) && !/\$500/.test(noneBanner),
  `the banner stops promising a cap it is no longer enforcing: "${noneBanner}"`);
await shot('81-txcap-unlimited.png');

// ---- tightening is friction-free ----
await pick('500');
check(!(await evaluate(capOpen())), 'tightening back down does NOT demand a ceremony');
check((await stored()) === '500', 'and applies immediately');
check((await gateAt(600)) !== null, 'the strict ceiling is enforced again');

// ---- a hostile / stale stored value cannot loosen anything ----
await evaluate(`localStorage.setItem('diginaut.txcap', '999999')`);
check((await gateAt(600)) !== null,
  'a hand-edited localStorage value above the ladder falls back to the default, not to a raised ceiling');
await evaluate(`localStorage.setItem('diginaut.txcap', 'null')`);
check((await gateAt(600)) !== null, 'the string "null" is not read as no-limit');

console.log('\nDone.');
b.close();
process.exit(process.exitCode || 0);
