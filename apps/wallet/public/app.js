// DigiDollar wallet — frontend logic.
// Consensus math comes from the digidollar-js protocol library (served at /lib/),
// which mirrors DigiByte Core v9.26.4 exactly — the same code the differential
// harness (M2) will verify against Core.
import {
  LOCK_TIERS, requiredCollateralSats, effectiveRatioPercent,
  generateMnemonic, validateMnemonic, mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS,
  descriptorKeySource, parseTrDescriptor, parseDescriptorBundle, encodeWitnessAddress,
  planSpend, planMaxSpend, buildSignedSpendTx, scriptPubKeyFromAddress,
  decodeDDAddress, encodeDDAddress, encodeGiftKey, ddTokenOutputKey, decodeAddress, encodeBip21, parseBip21, satsToDgbString,
  buildSignedMintTx, MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS,
  buildSignedTransferTx, buildSignedRedeemTx, DD_TX_LIMITS,
} from '/lib/index.js';
import * as keystore from '/keystore.js';
import { createVaultManager } from '/vault.js';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { networkChrome, betaCapError, backupSkipAllowed } from '/netchrome.js';
import { dcaBpsFromMultiplier, describeDca } from '/dca.js';
import { friendlyDDError, MINT_FREEZE_EXPLANATION, isAlreadyBroadcast } from '/dderrors.js';
import { AUTOLOCK_KEY, AUTOLOCK_DEFAULT_MIN, autolockMinutes } from '/autolock.js';
import { TXCAP_KEY, txCapUsd, txCapStorageValue, txCapLabel, isRaise, readTxCapUsd } from '/txcap.js';
import { initGiftKeyHelper } from '/giftkey.js';
import { createBroadcastLog, txidFromHex } from '/broadcastlog.js';
import { validateUtxos, validateDdUtxos, validatePositions, validateHistory, validateTxDetail, asIncomplete } from '/validate.js';
import { recordFromBulkEntry } from '/scanrecords.js';
import { extraSourcesFingerprint, myAddressSet, dedupeUtxos } from '/walletsync.js';
import { initTreasuryUi } from '/treasury-ui.js';
import { initDirectory } from '/directory.js';
import qrcode from 'qrcode-generator';

const $ = (id) => document.getElementById(id);

// Consensus oracle price bounds, mirrored from Core primitives/oracle.h
// (ORACLE_MIN/MAX_PRICE_MICRO_USD). Sub-cent DGB prices are consensus-valid.
const ORACLE_MIN_PRICE_MICRO_USD = 100n; // $0.0001 / DGB
const ORACLE_MAX_PRICE_MICRO_USD = 100_000_000n; // $100 / DGB

// Escape untrusted strings before they reach an innerHTML sink. The node,
// indexer, and oracle responses are semi-trusted JSON, and txids/addresses can
// be peer-supplied — a malicious value must never break out into markup or an
// inline event handler (#55). Covers both text and double-quoted attribute
// contexts. Prefer textContent where possible; use this for template strings.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Every frontend fetch goes through fetchJson: a hard timeout (a STALLED
// connection — not a refused one — otherwise hangs the poll loop or the confirm
// button forever, audit H1) and a plain-language error instead of AbortError
// stack text. `what` names the thing being reached in user vocabulary.
function friendlyNetError(err, what) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `${what} did not answer in time — it may be down or the connection dropped; try again`;
  }
  return `${what} is unreachable — check the connection and try again`;
}
async function fetchJson(url, opts = {}, timeoutMs = 20_000, what = 'the server') {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(friendlyNetError(err, what));
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${what} returned an unreadable response (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(json.error || `${what} answered with HTTP ${res.status}`);
  return json;
}

async function rpc(method, params = []) {
  const json = await fetchJson('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  }, 20_000, 'the node');
  if (json.error) throw new Error(json.error);
  return json.result;
}

const fmtDGB = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtUSD = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// sendrawtransaction with Core's consensus reject strings translated (#62) —
// "minting-frozen-volatility" is not an error a human can act on.
async function broadcastTx(hex) {
  try {
    return await rpc('sendrawtransaction', [hex]);
  } catch (err) {
    // keep the RAW message when it says "already broadcast": broadcastLogged
    // recognizes the token and treats it as the success it is — translating
    // first would hide it behind friendly wording
    if (isAlreadyBroadcast(err.message)) throw err;
    throw new Error(friendlyDDError(err.message) ?? err.message);
  }
}

// ---- DCA network-health multiplier (#62) ----
// Core scales required collateral by system health (dca.cpp): quoting without
// it under-quotes on a degraded system and the node rejects every mint.
let lastDcaBps = null; // basis points (10000 = healthy 1.0×); null until fetched
let lastDcaInfo = null; // raw getdcamultiplier result — tier_status feeds quote notes

// note like "1.5× collateral — network health: critical", or null when healthy.
// If DD is live but the node wouldn't say its health, say the quote is an
// assumption rather than silently pretending to know.
const dcaNote = () => {
  if (lastDcaInfo) return describeDca(lastDcaInfo);
  return chainState.ddActive ? 'assumes a healthy network — health multiplier unavailable' : null;
};

async function loadDca() {
  try {
    const dca = await rpc('getdcamultiplier');
    lastDcaBps = dcaBpsFromMultiplier(dca.multiplier);
    lastDcaInfo = dca;
  } catch {
    // Pre-activation the RPC throws, and a down node can't answer: previews
    // fall back to healthy 1.0×; the review step re-fetches and fails honestly.
    lastDcaBps = null;
    lastDcaInfo = null;
  }
  recalc();
  updateMintEstimate();
  refreshTierReadout();
}

// rebound by initMintTiers so a late DCA answer updates the tier pill too
let refreshTierReadout = () => {};

// ---- Mint calculator (pure client-side, exact Core arithmetic via digidollar-js) ----
function tierFor() {
  return LOCK_TIERS.find((t) => t.id === $('c-tier').value) || LOCK_TIERS[0];
}
function recalc() {
  const amount = Math.max(0, Number($('c-amount').value) || 0);
  const price = Math.max(0, Number($('c-price').value) || 0);
  const tier = tierFor();
  // the quote is honest about network health: ratio and USD reflect the DCA
  // multiplier the node reports, not the healthy-system base (#62)
  const bps = lastDcaBps ?? 10_000n;
  const effRatio = effectiveRatioPercent(tier.ratioPercent, bps);
  $('r-ratio').textContent = effRatio + '%' + (dcaNote() ? ` (${tier.ratioPercent}% base, ${dcaNote()})` : '');
  $('r-usd').textContent = fmtUSD((amount * effRatio) / 100);
  try {
    const sats = requiredCollateralSats({
      ddCents: BigInt(Math.round(amount * 100)),
      tierId: tier.id,
      oraclePriceMicroUsd: BigInt(Math.round(price * 1_000_000)),
      dcaMultiplierBps: bps,
    });
    $('r-dgb').textContent = fmtDGB(Number(sats) / 1e8);
  } catch {
    $('r-dgb').textContent = '—'; // zero/invalid input
  }
}

function initCalculator() {
  const sel = $('c-tier');
  sel.innerHTML = LOCK_TIERS.map((t) => `<option value="${t.id}">${t.label} — ${t.ratioPercent}% collateral</option>`).join('');
  ['c-amount', 'c-tier', 'c-price'].forEach((id) => $(id).addEventListener('input', recalc));
  enhanceSelect('c-tier');
  recalc();
}

// Kit Dropdown component over a hidden native <select> (the select stays the
// source of truth, so scripts that set .value directly keep working).
function enhanceSelect(id) {
  const sel = $(id);
  if (sel.parentNode.classList?.contains('dd')) return;
  const wrap = document.createElement('div');
  wrap.className = 'dd';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  const trig = document.createElement('button');
  trig.type = 'button';
  trig.className = 'dd-trigger';
  trig.innerHTML = '<span class="dd-label"></span><svg class="dd-caret" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const list = document.createElement('div');
  list.className = 'dd-list';
  wrap.append(trig, list);
  const label = trig.querySelector('.dd-label');
  const sync = () => { label.textContent = sel.selectedOptions[0]?.textContent ?? ''; };
  const rebuild = () => {
    list.innerHTML = '';
    for (const o of sel.options) {
      const el = document.createElement('div');
      el.className = 'dd-option' + (o.value === sel.value ? ' selected' : '');
      el.textContent = o.textContent;
      el.addEventListener('click', () => {
        sel.value = o.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
        wrap.classList.remove('open');
      });
      list.appendChild(el);
    }
  };
  trig.setAttribute('aria-haspopup', 'listbox');
  trig.setAttribute('aria-expanded', 'false');
  // Inside a modal the absolutely-positioned list would be clipped by the
  // modal's own scroll box (double scrollbars) — escape it with position:fixed
  // anchored to the trigger. Viewport coordinates, so the modal never scrolls.
  const positionList = () => {
    if (!wrap.closest('.modal')) return;
    const r = trig.getBoundingClientRect();
    Object.assign(list.style, {
      position: 'fixed', left: r.left + 'px', right: 'auto',
      top: r.bottom + 6 + 'px', width: r.width + 'px', zIndex: 70,
    });
  };
  trig.addEventListener('click', () => {
    const opening = !wrap.classList.contains('open');
    document.querySelectorAll('.dd.open').forEach((d) => { d.classList.remove('open'); d.querySelector('.dd-trigger')?.setAttribute('aria-expanded', 'false'); });
    if (opening) { sync(); rebuild(); wrap.classList.add('open'); positionList(); }
    trig.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) { wrap.classList.remove('open'); trig.setAttribute('aria-expanded', 'false'); } });
  sel.addEventListener('change', sync); // keyboard changes on the native select stay in sync
  sync();
}

// ---- Show/hide toggles on password fields ----
// A mistyped master password costs real money (a vault encrypted under a typo
// is a vault lost), and blind typing is how the typos happen. Every
// input[type=password] gets an eye toggle; the field stays a password by
// default — the reveal is one deliberate tap, per field, per moment.
const EYE_ICON = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.5 8S3.5 3.5 8 3.5 14.5 8 14.5 8 12.5 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5"/></svg>';
function addPasswordToggles() {
  for (const input of document.querySelectorAll('input[type="password"]')) {
    if (input.dataset.pwToggle) continue;
    input.dataset.pwToggle = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.setAttribute('aria-label', 'Show password');
    btn.title = 'Show password';
    btn.innerHTML = EYE_ICON;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
      btn.title = show ? 'Hide password' : 'Show password';
      btn.setAttribute('aria-label', btn.title);
      input.focus(); // keep typing where you were
    });
    wrap.appendChild(btn);
  }
}

// ---- Address-entry tools: paste from clipboard + scan a QR code ----
// Every field that takes an address (or Gift key) grows a 📋 paste button and,
// where the platform can do it (BarcodeDetector + camera — Android Chrome,
// the wallet's main audience), a camera QR-scan button. Typing a 60-char
// address on a phone is how typos happen; both buttons exist to remove typing.
const PASTE_ICON = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4.5" y="2.5" width="7" height="2.5" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 4H3.5A1 1 0 0 0 2.5 5v8a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const CAMERA_ICON = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 5.5A1 1 0 0 1 3.5 4.5h1.6l1-1.5h3.8l1 1.5h1.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8.2" r="2.2" stroke="currentColor" stroke-width="1.5"/></svg>';
const ADDRESS_INPUT_IDS = ['w-send-to', 'w-tr-to', 'gf-to'];

function addAddressTools() {
  const canScan = 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);
  const canPaste = Boolean(navigator.clipboard?.readText);
  const setValue = (input, raw) => {
    let v = String(raw ?? '').trim();
    // a scanned/copied BIP21 URI carries the address inside it
    if (/^digibyte:/i.test(v)) { try { v = parseBip21(v).address; } catch { /* leave as scanned */ } }
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  const mkBtn = (title, icon, right) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pw-toggle';
    b.style.right = right + 'px';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon;
    return b;
  };
  for (const id of ADDRESS_INPUT_IDS) {
    const input = $(id);
    if (!input || input.dataset.addrTools) continue;
    input.dataset.addrTools = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    let right = 6;
    if (canScan) {
      const scan = mkBtn('Scan a QR code', CAMERA_ICON, right);
      scan.addEventListener('click', () => scanQrInto(input, setValue));
      wrap.appendChild(scan);
      right += 34;
    }
    if (canPaste) {
      const paste = mkBtn('Paste from clipboard', PASTE_ICON, right);
      paste.addEventListener('click', async () => {
        try { const t = await navigator.clipboard.readText(); if (t?.trim()) setValue(input, t); }
        catch { paste.title = 'Clipboard blocked by the browser — paste manually (Ctrl+V / long-press)'; }
      });
      wrap.appendChild(paste);
      right += 34;
    }
    if (right > 6) input.style.paddingRight = right + 'px';
  }
}

// Camera overlay: created once, shared by every field. Stream and detector
// are torn down on every exit path — a wallet must never hold the camera open.
let qrOverlay = null;
async function scanQrInto(input, setValue) {
  if (!qrOverlay) {
    qrOverlay = document.createElement('div');
    qrOverlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(10,14,20,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px';
    qrOverlay.innerHTML = '<video autoplay playsinline style="max-width:min(92vw,480px);max-height:60vh;border-radius:12px"></video>'
      + '<div style="color:#cfd6df;font-size:14px">Point the camera at the QR code</div>'
      + '<button type="button" class="secondary" style="width:auto;padding:10px 22px">Cancel</button>';
    document.body.appendChild(qrOverlay);
  }
  const video = qrOverlay.querySelector('video');
  const cancel = qrOverlay.querySelector('button');
  qrOverlay.style.display = 'flex';
  let stream = null, timer = null;
  const stop = () => {
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    qrOverlay.style.display = 'none';
    cancel.onclick = null;
  };
  cancel.onclick = stop;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    timer = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) { const v = codes[0].rawValue; stop(); setValue(input, v); }
      } catch { /* frame not ready yet */ }
    }, 250);
  } catch (e) {
    stop();
    alert('Camera unavailable: ' + (e?.message ?? e) + ' — paste the value instead.');
  }
}

// ---- Status ----
function statusLine(active, textActive, textInactive) {
  const cls = active ? 'good' : 'warn';
  return `<span class="dot ${cls}"></span>${esc(active ? textActive : textInactive)}`;
}

// header dot = aggregate of softfork state + oracle freshness.
// TWO consecutive misses before either flag goes false: a single failed poll
// (a deploy restarting the server mid-request, a phone throttling a dimmed
// tab) painted the dot red for up to a full poll interval and read as "the
// network disconnected" (user report 2026-07-27). One blip is noise; two in
// a row is a signal. A failed oracle poll also reschedules fast (5s).
const netHealth = { dd: null, oracle: null };
const netFails = { dd: 0, oracle: 0 };
let lastOracleOk = true;
// a FAILED POLL is debounced; an ANSWER that says "inactive"/"stale" is truth
// and lands immediately (those paths reset the counter and set the flag direct)
function healthMiss(key) {
  netFails[key] += 1;
  if (netFails[key] >= 2) netHealth[key] = false;
}
function renderNetDot() {
  const bad = netHealth.dd === false || netHealth.oracle === false;
  const ok = netHealth.dd === true && netHealth.oracle === true;
  $('net-dot').className = 'dot ' + (bad ? 'bad' : ok ? 'good' : 'warn');
}

// ---- Mainnet beta interstitial (#54/#63) ----
// One-time BLOCKING ack on first mainnet use, persisted in localStorage.
// Continue is the only way through; Cancel keeps the modal (and the wallet)
// blocked. A storage failure (private mode) just means it shows every load.
const MAINNET_ACK_KEY = 'diginaut-mainnet-ack';
let mainnetAckShown = false; // don't re-open over a Cancel'd modal on a later poll
function maybeShowMainnetAck(chain) {
  if (chain !== 'main' || mainnetAckShown) return;
  let acked = false;
  try { acked = localStorage.getItem(MAINNET_ACK_KEY) === '1'; } catch { /* show it */ }
  if (acked) return;
  mainnetAckShown = true;
  $('mainnet-ack-modal').classList.add('open');
  $('mainnet-ack-continue').focus(); // pull focus in so the trap below can hold it
}
$('mainnet-ack-continue').addEventListener('click', () => {
  try { localStorage.setItem(MAINNET_ACK_KEY, '1'); } catch { /* re-shows next load */ }
  $('mainnet-ack-modal').classList.remove('open');
});
$('mainnet-ack-cancel').addEventListener('click', () => {
  $('mainnet-ack-note').style.display = 'block';
});
// Keep the interstitial genuinely BLOCKING for the keyboard too, not just the
// pointer (#54, decision 3). The backdrop only occluds clicks; without this a
// user could Tab into the wallet behind it (the modal sits late in the DOM) and
// transact unacknowledged. Snap any focus that escapes back onto Continue, and
// swallow Escape so there is no keyboard route past it.
document.addEventListener('focusin', (e) => {
  const modal = $('mainnet-ack-modal');
  if (modal.classList.contains('open') && !modal.contains(e.target)) {
    $('mainnet-ack-continue').focus();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('mainnet-ack-modal').classList.contains('open')) e.preventDefault();
}, true);

// The network pill must survive scroll (#54): once the topbar scrolls away it
// floats to a fixed corner just below the sticky banner. Two subtleties, both
// mobile-borne: the threshold is the header's real bottom edge (a fixed 64px
// fired while the topbar was still on screen), and it has hysteresis — the
// float removes the pill from the header flow, which can shrink the header by
// a wrapped row, and a single shared threshold then oscillates every frame.
window.addEventListener('scroll', () => {
  const pill = $('net-pill');
  const hdr = document.querySelector('header');
  const hdrBottom = hdr.offsetTop + hdr.offsetHeight;
  const floating = pill.classList.contains('floating');
  const on = floating ? window.scrollY > Math.max(hdrBottom - 80, 8) : window.scrollY > hdrBottom;
  if (on) {
    const banner = $('net-banner'); // sits below the sticky banner, whatever its wrapped height right now
    pill.style.top = (banner.hidden ? 8 : banner.offsetHeight + 8) + 'px';
  } else {
    pill.style.top = '';
  }
  pill.classList.toggle('floating', on);
}, { passive: true });

// Poll cadences for the three things the UI presents as live. 60s matches what
// loadDca already did; the status poll is slower because height and softfork
// state are cheap to be a minute stale and it is the heaviest of the three
// (two RPCs). PRICE_MAX_AGE_MS must stay a small multiple of ORACLE_POLL_MS so
// one dropped tick does not disable USD entry.
const ORACLE_POLL_MS = 60_000;
const STATUS_POLL_MS = 60_000;
const DCA_POLL_MS = 60_000;

async function loadStatus() {
  // Rebuilt from scratch each poll: line ~301 APPENDS the deployment error, so
  // a node that keeps failing would otherwise grow this string a clause a minute.
  $('s-err').textContent = '';
  try {
    const info = await rpc('getblockchaininfo');
    $('s-chain').textContent = info.chain;
    $('s-height').textContent = Number(info.blocks).toLocaleString('en-US');
    // derive receive addresses for the chain the node is actually on
    const net = { main: 'mainnet', test: 'testnet', regtest: 'regtest' }[info.chain];
    if (net) {
      chainState.netName = net; // consensus DD limits are per-network
      chainState.netKnown = true; // safe to render addresses now
      wallet.network = HD_NETWORKS[net];
      // a wallet unlocked before the node named its chain has no addresses yet
      // — this is the first moment its chain can be scanned
      if (wallet.seed) { renderAddress(); syncReceiveIndex(); syncExtraChainDepths(); scanStrandedGifts(); }
    }
    // banner + tab title follow the node's chain — same build on every network
    const { title, banner, level, pill } = networkChrome(info.chain, currentTxCapUsd());
    document.title = title;
    const bannerEl = $('net-banner');
    bannerEl.textContent = banner ?? '';
    bannerEl.hidden = banner === null;
    bannerEl.classList.toggle('danger', level === 'danger'); // mainnet is RED, not amber (#54)
    const pillEl = $('net-pill');
    pillEl.textContent = pill ?? '';
    pillEl.hidden = pill == null;
    pillEl.classList.toggle('danger', level === 'danger');
    pillEl.classList.toggle('warn', level === 'warn');
    maybeShowMainnetAck(info.chain);
  } catch (e) {
    $('s-err').textContent = 'blockchain: ' + e.message;
  }
  try {
    const dep = await rpc('getdeploymentinfo');
    const dd = dep?.deployments?.digidollar;
    const tr = dep?.deployments?.taproot;
    const ddActive = dd?.active === true || dd?.bip9?.status === 'active';
    chainState.ddActive = ddActive; // the mint flow refuses to start when inactive
    netFails.dd = 0;
    netHealth.dd = ddActive; // an answered "inactive" is truth, not a miss
    $('s-dd').innerHTML = statusLine(ddActive, 'active', dd?.bip9?.status || 'not active');
    $('s-tr').innerHTML = statusLine(tr?.active === true, 'active', tr?.bip9?.status || 'not active');
  } catch (e) {
    healthMiss('dd'); // two consecutive misses before the dot goes red
    $('s-err').textContent += (e ? ' · deployment: ' + e.message : '');
  }
  renderNetDot();
}

let lastPriceUsd = null; // feeds the fiat equivalents in the hero and asset rows
let lastPriceMicroUsd = null; // feeds the live mint collateral estimate
let lastPriceAt = null; // Date.now() of the quote above — see PRICE_MAX_AGE_MS

async function loadOracle() {
  try {
    const price = await rpc('getoracleprice');
    if (price?.price_usd) {
      lastPriceAt = Date.now();
      // sub-cent DGB prices need more than fmtUSD's 2 decimals
      $('o-price').textContent = '$' + price.price_usd.toLocaleString('en-US', { maximumFractionDigits: 5 }) + (price.is_stale ? ' (stale)' : '');
      lastPriceUsd = price.price_usd;
      if (price.price_micro_usd) lastPriceMicroUsd = BigInt(price.price_micro_usd);
      lastOracleOk = true;
      netFails.oracle = 0;
      netHealth.oracle = !price.is_stale; // an answered "stale" is truth, not a miss
      renderFiat();
      updateMintEstimate();
      // seed the calculator price with the live oracle price
      const priceInput = $('c-price');
      if (priceInput && !priceInput.dataset.touched) {
        priceInput.value = price.price_usd;
        $('c-pricesrc').textContent = '(from oracle)';
        recalc();
      }
    }
  } catch (e) {
    lastOracleOk = false;
    healthMiss('oracle'); // two consecutive misses before the dot goes red
    $('o-hint').innerHTML = `<span class="err">oracle: ${esc(e.message)}</span>`;
  }
  renderNetDot();
  syncSendPriceGate(); // USD send entry follows oracle freshness (#70)
  // The rate just moved, and the ≈-line under the amount is the only place the
  // user sees what their USD figure is worth. It is otherwise repainted only on
  // typing, on the currency toggle and on Max — so without this a polled price
  // leaves "$1.00 ≈ 74.5 DGB" on screen while Review builds 294.1 DGB.
  updateSendEq();
  try {
    const list = await rpc('getoracles');
    if (Array.isArray(list) && list.length) {
      const { active_oracle_count: active, total_oracle_slots: slots, consensus_threshold: need } = list[0];
      const ok = active >= need;
      $('o-consensus').innerHTML = `<span class="dot ${ok ? 'good' : 'bad'}"></span>${esc(active)}/${esc(slots)} · need ${esc(need)}`;
      $('o-active').textContent = `${active} of ${slots}`;
      $('o-grid').innerHTML = list
        .map((o, i) => {
          const on = o.is_active !== false;
          const bg = on ? 'var(--good-bg)' : 'var(--bad-bg)';
          const col = on ? 'var(--good)' : 'var(--bad)';
          return `<div class="oracle" style="background:${bg};color:${col}" title="${esc(`${o.name ?? ''} ${o.pubkey ?? ''}`)}">${esc(o.oracle_id ?? i)}</div>`;
        })
        .join('');
    }
  } catch { /* grid is optional */ }
}

// mark price as user-touched so the oracle doesn't overwrite it
$('c-price').addEventListener('input', () => { $('c-price').dataset.touched = '1'; $('c-pricesrc').textContent = ''; });

// ---- Wallet (non-custodial: mnemonic + keys never leave this page) ----
let appConfig = { mock: true, faucet: false, indexer: false };
// netName is a provisional default until the node names its chain (netKnown);
// addresses are never rendered from the guess — see renderAddress.
const chainState = { ddActive: null, netName: 'testnet', netKnown: false };
const wallet = {
  id: null, // active wallet id in the vault (meta.activeId)
  mnemonic: null, // set only while unlocked
  seed: null,
  index: 0,
  network: HD_NETWORKS.testnet, // refined from the node's `chain` once known
};

// The vault manager owns metadata + mnemonics (vault.js); keystore.js is its
// browser storage. One master password for every wallet on this device.
const vault = createVaultManager(keystore);

// ---- Storage persistence + vault tombstone (audit C2) ----
// The vault lives in IndexedDB, which browsers evict under storage pressure,
// on "clear site data", and aggressively on mobile — and eviction here is
// TOTAL LOSS for any wallet without a seed backup. Two controls:
//  1. navigator.storage.persist() — the only API that asks the browser not to
//     auto-evict. Requested when a vault exists; the outcome is surfaced in
//     Network → "Browser storage protection", and a non-persisted answer
//     escalates the backup nag (renderBackupStrip).
//  2. A localStorage tombstone written whenever a vault exists. localStorage
//     and IndexedDB are USUALLY evicted together — but not always (partial
//     eviction, IDB corruption, quota trimming). A tombstone without a vault
//     means "you HAD a wallet here"; the guest hero then shows recovery
//     guidance instead of impersonating a fresh install.
const VAULT_TOMBSTONE_KEY = 'diginaut.hadVault';
// localStorage can throw (private mode, disabled storage): never let a
// best-effort marker break a funds flow.
const safeStorage = {
  getItem(k) { try { return localStorage.getItem(k); } catch { return null; } },
  setItem(k, v) { try { localStorage.setItem(k, v); } catch { /* best effort */ } },
  removeItem(k) { try { localStorage.removeItem(k); } catch { /* best effort */ } },
};
let storagePersisted = null; // null = API missing or unanswered; boolean = persisted()
async function refreshStoragePersistence(request = false) {
  try {
    if (!navigator.storage?.persisted) return;
    storagePersisted = await navigator.storage.persisted();
    if (request && !storagePersisted && navigator.storage.persist) {
      storagePersisted = await navigator.storage.persist();
    }
  } catch { /* flaky API — the status stays unknown, nothing breaks */ }
  renderStoragePersistence();
}
function renderStoragePersistence() {
  $('s-persist').textContent = storagePersisted === null ? 'unknown'
    : storagePersisted ? 'protected — the browser won’t auto-evict this wallet'
      : 'NOT protected';
  $('s-persist-warn').style.display = storagePersisted === false ? 'block' : 'none';
  renderBackupStrip(); // a non-persisted answer escalates backup urgency
}
function markVaultTombstone() { safeStorage.setItem(VAULT_TOMBSTONE_KEY, '1'); }
function clearVaultTombstone() { safeStorage.removeItem(VAULT_TOMBSTONE_KEY); }
function renderTombstoneNote(showNote) {
  $('w-tombstone-note').style.display = showNote ? 'block' : 'none';
}

// ---- Pending-broadcast survival (audit C1) ----
// If sendrawtransaction times out or the connection drops mid-request, the
// signed transaction MAY OR MAY NOT be in the mempool. The signed hex (plus
// its locally computed txid) is persisted BEFORE the network call, so an
// ambiguous outcome — or a page kill between sign and broadcast — can always
// be reconciled: rebroadcast the IDENTICAL transaction (same txid, idempotent)
// or check the indexer for the txid. Never silently rebuild over the same
// UTXOs: that is how a user panics a second, conflicting transaction into
// being. The log is localStorage — public data (a signed tx is broadcast
// anyway), worthless for spending without keys.
const broadcastLog = createBroadcastLog(safeStorage);

/** Node consensus/policy rejections are FINAL — the node saw the tx and
 * refused it. Everything else (timeout, dropped connection, proxy 5xx without
 * a reject token) is AMBIGUOUS. */
function isDefiniteBroadcastReject(msg) {
  if (friendlyDDError(msg)) return true;
  return /bad-txns|rejected|insufficient (fee|funds)|dust|nonstandard|non-standard|mandatory-script|too (large|long)|min relay fee/i.test(msg);
}

/** Broadcast with the signed hex persisted first. Returns the txid. Throws the
 * original error on a DEFINITE reject; throws an honest "may have been
 * broadcast" error on an ambiguous outcome (the record stays in the log and
 * the recovery card appears). */
async function broadcastLogged(hex, kind) {
  let rec = null;
  try {
    rec = await broadcastLog.record({ hex, kind, net: chainState.netName });
  } catch { /* storage full/blocked: broadcast anyway — recovery degrades, the send must not */ }
  try {
    const txid = await broadcastTx(hex);
    if (rec) broadcastLog.remove(rec.id);
    markExtraChainsDue(); // we just moved coins: re-read every chain, not just the fast one
    return txid;
  } catch (err) {
    if (isAlreadyBroadcast(err.message)) {
      // an earlier attempt DID land — this is success with extra steps
      if (rec) broadcastLog.remove(rec.id);
      return rec?.txid ?? (await txidFromHex(hex));
    }
    if (isDefiniteBroadcastReject(err.message)) {
      if (rec) broadcastLog.remove(rec.id);
      throw err;
    }
    pendingTxNote = ''; // a fresh interruption replaces any stale outcome line
    renderPendingTx(); // the recovery card appears immediately
    const e = new Error(
      'the network dropped the answer — this transaction MAY have been broadcast. ' +
      'Do NOT rebuild and resend (that risks a conflicting second transaction). ' +
      'Use the recovery card at the top of the page to check its status or rebroadcast the identical transaction.');
    e.ambiguous = true;
    throw e;
  }
}

const PENDING_TX_KIND = {
  send: 'DGB send', transfer: 'DigiDollar transfer', mint: 'Mint',
  redeem: 'Redemption', consolidate: 'Consolidation',
  'treasury-fund': 'Treasury funding', 'treasury-mint': 'Treasury mint',
  'gift-mint': 'Gifted treasury mint',
};
let pendingTxNote = ''; // latest outcome line from Check/Rebroadcast
function renderPendingTx() {
  const list = broadcastLog.list();
  const card = $('w-pending-tx');
  // an empty list WITH a note keeps the card up as a bare outcome line ("the
  // network HAS this transaction…") — resolving the last record must not
  // swallow the answer the user clicked for
  if (!list.length && !pendingTxNote) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  $('w-pending-tx-text').textContent = pendingTxNote || (list.length === 1
    ? 'A transaction was signed but its broadcast answer was lost — it MAY already be in the network. Do not rebuild it; check its status or rebroadcast the identical transaction:'
    : `${list.length} signed transactions have a lost broadcast answer — they MAY already be in the network. Do not rebuild them:`);
  $('w-pending-tx-list').innerHTML = list.map((r) => {
    const when = new Date(r.createdAt).toLocaleString('en-CA');
    const tx = r.txid ? `${r.txid.slice(0, 12)}…` : 'txid unknown';
    return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap">'
      + `<span style="flex:1;min-width:180px">${esc(PENDING_TX_KIND[r.kind] ?? r.kind)} · ${esc(when)} · <span class="mono">${esc(tx)}</span>${txCopyBtn(r.txid)}</span>`
      + `<button type="button" class="secondary" style="width:auto;margin:0;padding:6px 12px;font-size:12px" data-ptx-check="${esc(r.id)}">Check status</button>`
      + `<button type="button" class="secondary" style="width:auto;margin:0;padding:6px 12px;font-size:12px" data-ptx-rebroadcast="${esc(r.id)}">Rebroadcast</button>`
      + '</div>';
  }).join('');
  for (const el of $('w-pending-tx-list').querySelectorAll('.icon-btn')) el.innerHTML = COPY_ICON;
}
$('w-pending-tx-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ptx-check],[data-ptx-rebroadcast]');
  if (!btn) return;
  const id = btn.dataset.ptxCheck ?? btn.dataset.ptxRebroadcast;
  const rec = broadcastLog.list().find((r) => r.id === id);
  if (!rec) { renderPendingTx(); return; }
  btn.disabled = true;
  const say = (t) => { pendingTxNote = t; renderPendingTx(); };
  try {
    if (btn.dataset.ptxCheck) {
      // Reconcile via the indexer. The txid was computed locally at sign time,
      // so this does not depend on the node ever having answered us.
      const txid = rec.txid ?? (await txidFromHex(rec.hex));
      if (!appConfig.indexer) {
        say('This deployment has no indexer to check against — use Rebroadcast; sending the identical transaction again is safe (same txid).');
        return;
      }
      try {
        await fetchIndexer(`/tx/${txid}`);
        broadcastLog.remove(rec.id);
        say('The network HAS this transaction — the broadcast went through after all. It will confirm with the next blocks.');
        refreshMoney();
      } catch (err) {
        say(/malformed/.test(err.message) ? err.message
          : 'The indexer does not see this transaction — it likely never reached the network. Rebroadcast is safe: the identical transaction, the same txid.');
      }
    } else {
      // Idempotent by construction: the same signed bytes produce the same txid.
      const txid = await broadcastTx(rec.hex);
      broadcastLog.remove(rec.id);
      say(`Rebroadcast accepted — tx ${txid.slice(0, 16)}…. It appears in Activity as pending until it confirms.`);
      refreshMoney();
    }
  } catch (err) {
    if (isAlreadyBroadcast(err.message)) {
      broadcastLog.remove(rec.id);
      say('The network already has this transaction — the earlier broadcast went through. It will confirm with the next blocks.');
      refreshMoney();
    } else if (isDefiniteBroadcastReject(err.message)) {
      broadcastLog.remove(rec.id);
      say(`The node has now definitely rejected this transaction (a later one may have spent its coins). Cleared. Node said: ${err.message}`);
    } else {
      say('Still unreachable — nothing new was sent. The signed transaction is kept; try again later.');
    }
  } finally {
    btn.disabled = false;
    renderPendingTx();
  }
});

let shownState = 'loading'; // what the app currently renders — cross-tab sync diffs against it
function show(state) {
  shownState = state;
  // the boot card is the whole wrapper: leaving it in the main grid while
  // empty would add a stray row gap under the header
  $('wallet-card').style.display = state === 'loading' ? 'block' : 'none';
  $('w-loading').style.display = state === 'loading' ? 'block' : 'none';
  $('w-open').style.display = state === 'open' ? 'grid' : 'none';
  // EVM-style corner control: Connect when idle, address chip when connected
  const open = state === 'open';
  $('hero-guest').style.display = state === 'none' || state === 'locked' ? 'block' : 'none';
  $('w-connect').style.display = open || state === 'loading' ? 'none' : 'inline-block';
  $('w-chip').style.display = open ? 'inline-flex' : 'none';
  // backup-status surfaces belong to an OPEN wallet; renderBackupCta shows
  // them again (or not) once openWallet knows the active wallet's flag
  if (!open) { $('w-backup-badge').style.display = 'none'; $('w-backup-strip').style.display = 'none'; }
  $('wallet-open-card').style.display = open ? 'grid' : 'none';
  $('net-wallet-sec').style.display = open ? 'block' : 'none'; // seed/lock need an unlocked wallet
  // no indexer on this deployment: the money grid never loads, so say why (#61).
  // Gated on a LOADED config — a failed /api/config fetch must not produce a
  // confident false "no indexer here" claim on an indexer-equipped deployment.
  $('w-no-indexer').style.display = open && appConfig.loaded && !appConfig.indexer ? 'block' : 'none';
  if (open) {
    // the backup ceremony OVERLAYS the already-open wallet (drivers depend on
    // the wallet opening immediately); any other modal content closes
    if (!['backup', 'quiz', 'backup-done'].includes(connectMode)) closeConnectModal();
  } else {
    // the modal's inner mode follows the app state while no wallet is open;
    // while open it is driven solely by the ceremony/add-wallet flows (§2)
    setConnectMode(state === 'locked' ? 'unlock' : 'choice');
    // action modals must not survive a lock/disconnect
    for (const id of ['send-modal', 'receive-modal', 'mint-modal', 'wallet-modal', 'consolidate-modal',
      'treasury-modal', 'split-modal', 'handover-modal', 'gh-modal', 'gift-modal', 't-guard-modal']) $(id).classList.remove('open');
  }
  dockPriceBlock(open);
  // loading veil covers the gap between unlock and the first indexer answer
  // (only once the chain is known — before that "syncing" would be a lie)
  $('loading-veil').style.display =
    open && appConfig.indexer && chainState.netKnown && $('w-money').style.display === 'none' ? 'block' : 'none';
}

// The price block lives inside the hero card while connected (chart right
// under the balance, like the reference wallets) and as its own card
// otherwise. Same node, one set of ids — just re-parented.
function dockPriceBlock(open) {
  const docked = open && appConfig.indexer;
  const slot = $(docked ? 'price-slot-hero' : 'price-slot-guest');
  const block = $('price-block');
  if (block.parentNode !== slot) {
    slot.appendChild(block);
    renderSparkline(lastPriceSeries); // the new slot has a different width
  }
  // guests never see the market chart; the standalone card only serves the
  // connected-but-no-indexer edge case
  const card = $('price-card');
  const visible = open && !appConfig.indexer;
  const wasHidden = card.style.display === 'none';
  card.style.display = visible ? 'block' : 'none';
  // the card boots hidden, so its first chart was measured at zero width —
  // draw it again the moment it actually has a box
  if (visible && wasHidden) renderSparkline(lastPriceSeries);
}

// swap a modal's form for the success view once the tx is broadcast
function showTxSuccess(modalId, txid, title, note) {
  const modal = $(modalId);
  const box = modal.querySelector('.tx-success');
  box.querySelector('.tx-title').textContent = title;
  box.querySelector('.tx-note').textContent = note;
  const link = box.querySelector('.tx-link');
  link.textContent = txid.slice(0, 18) + '…' + txid.slice(-10);
  if (appConfig.explorerTxUrl && /^[0-9a-f]{64}$/.test(txid)) {
    link.href = appConfig.explorerTxUrl + txid;
  } else {
    link.removeAttribute('href'); // no explorer on this network (e.g. regtest)
  }
  // full txid, one tap away (debugging) — attached once per success box
  let copyBtn = box.querySelector('.icon-btn[data-copy-text]');
  if (!copyBtn) {
    copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'icon-btn';
    copyBtn.title = 'Copy full transaction id';
    copyBtn.setAttribute('aria-label', 'Copy full transaction id');
    link.after(copyBtn);
  }
  copyBtn.dataset.copyText = txid;
  copyBtn.innerHTML = COPY_ICON;
  modal.classList.add('success');
}

// ---- Connect modal mode machine (spec §2) ----
// The modal's inner step visibility is driven SOLELY by this mode, decoupled
// from the app's none/locked/open state — so add-wallet/backup flows can run
// while the wallet stays open. show() only decides whether the modal closes.
// Modes: 'choice' | 'create' | 'restore' | 'import' | 'unlock' | 'erase' |
// 'backup' | 'quiz' | 'backup-done'.
let connectMode = 'choice';
let pendingImport = null; // parsed keystore-file envelope while the import step is open (§4)

function setConnectMode(mode) {
  connectMode = mode;
  $('w-none').style.display = ['choice', 'create', 'restore', 'import', 'descriptor'].includes(mode) ? 'block' : 'none';
  $('w-choice').style.display = mode === 'choice' ? 'block' : 'none';
  $('w-form').style.display = ['create', 'restore', 'import', 'descriptor'].includes(mode) ? 'block' : 'none';
  $('w-restore').style.display = mode === 'restore' ? 'block' : 'none';
  $('w-import').style.display = mode === 'import' ? 'block' : 'none';
  $('w-desc').style.display = mode === 'descriptor' ? 'block' : 'none';
  $('w-desc-go').style.display = mode === 'descriptor' ? 'block' : 'none';
  if (mode !== 'descriptor') { $('w-desc-text').value = ''; $('w-desc-ack').value = ''; } // no key material (or stale ack) left in the DOM
  $('w-name-field').style.display = mode === 'import' ? 'none' : 'block'; // import names the wallet from the file
  $('w-create').style.display = mode === 'create' ? 'block' : 'none';
  $('w-restore-go').style.display = mode === 'restore' ? 'block' : 'none';
  $('w-import-go').style.display = mode === 'import' ? 'block' : 'none';
  // a parsed envelope (and the file password) never outlives the import step
  if (mode !== 'import') {
    pendingImport = null;
    $('w-import-file').value = '';
    $('w-import-pass').value = '';
    $('w-import-info').style.display = 'none';
    $('w-import-warn').style.display = 'none';
  }
  // master password fields only exist while no vault does (§2.1)
  $('w-pass-fields').style.display = vault.status === 'none' ? 'block' : 'none';
  $('w-locked').style.display = mode === 'unlock' ? 'block' : 'none';
  if (mode === 'unlock') renderLockedNames();
  $('w-erase-view').style.display = mode === 'erase' ? 'block' : 'none';
  // the typed ERASE never survives leaving the ceremony — re-entry re-arms
  if (mode !== 'erase') { $('w-erase-input').value = ''; $('w-erase-go').disabled = true; $('w-erase-err').textContent = ''; }
  $('w-backup-view').style.display = mode === 'backup' ? 'block' : 'none';
  $('w-quiz-view').style.display = mode === 'quiz' ? 'block' : 'none';
  $('w-backup-success').style.display = mode === 'backup-done' ? 'block' : 'none';
  // Remind-me-later is shared by both ceremony steps (id kept stable — drivers
  // dismiss the whole flow with one click on it). Hidden where
  // backupSkipAllowed says strict (mainnet, or chain unknown): real funds do
  // not get a skip (audit C3).
  $('w-backup-done').style.display =
    (mode === 'backup' || mode === 'quiz') && backupSkipAllowed(chainState.netName) ? 'block' : 'none';
  document.querySelector('#w-connect-modal .modal-head h3').textContent =
    ['backup', 'quiz', 'backup-done'].includes(mode) ? 'Back up your seed phrase'
      : mode === 'erase' ? 'Erase all wallets' : 'Get started';
  // real words live in the ceremony DOM only while its steps are open
  if (mode !== 'backup') $('w-backup-words').innerHTML = '';
  if (mode !== 'quiz') { $('w-quiz-slots').innerHTML = ''; $('w-quiz-chips').innerHTML = ''; $('w-quiz-err').textContent = ''; }
  $('w-none-err').textContent = '';
}
function openConnectModal() {
  setConnectMode(vault.status === 'locked' ? 'unlock' : 'choice');
  $('w-connect-modal').classList.add('open');
}
function closeConnectModal(fromUser = false) {
  // Mainnet — and an UNKNOWN chain, which may be mainnet with a dead node —
  // has no "Remind me later" and no dismiss (audit C3): the ceremony ends only
  // with a passed quiz. fromUser=false paths (lock/switch teardown, success)
  // must always close.
  if (fromUser && ['backup', 'quiz'].includes(connectMode) && !backupSkipAllowed(chainState.netName)) {
    (connectMode === 'quiz' ? $('w-quiz-err') : $('w-backup-err')).textContent =
      'Back up first — on mainnet this cannot be postponed. Complete the word check to finish.';
    return;
  }
  $('w-connect-modal').classList.remove('open');
  ceremony = null; // drop the plaintext words held for the reveal/quiz steps
  // resetting the mode wipes the ceremony word nodes and restores the title
  setConnectMode(vault.status === 'locked' ? 'unlock' : 'choice');
}

// ---- v3 action modals: Send / Receive / Mint / Network ----
const openModal = (id) => $(id).classList.add('open');
// Closing a modal abandons whatever draft it held. Anything armed out-of-band
// from the visible fields — "Max", a pending signed draft — has to go with it,
// or it silently applies to the next thing the user does.
function onModalClosed(id) {
  if (id === 'net-modal') hideSeed(); // a revealed seed must not outlive the modal (§5)
  if (id === 'send-modal') resetSend();
}
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => {
    const modal = b.closest('.modal-backdrop');
    modal.classList.remove('open');
    onModalClosed(modal.id);
  }));
    for (const id of ['send-modal', 'receive-modal', 'mint-modal', 'net-modal', 'disclaimer-modal', 'wallet-modal', 'consolidate-modal',
  'treasury-modal', 'split-modal', 'handover-modal', 'gh-modal', 'gift-modal', 'spend-modal']) {
  $(id).addEventListener('click', (e) => {
    if (e.target !== $(id)) return;
    $(id).classList.remove('open');
    onModalClosed(id);
  });
}
$('footer-disclaimer').addEventListener('click', () => openModal('disclaimer-modal'));
$('act-send').addEventListener('click', () => { $('send-modal').classList.remove('success'); openModal('send-modal'); });
// both receive entry points go through the backup interception gate (spec §3)
$('act-receive').addEventListener('click', openReceiveModal);
$('w-no-indexer-receive').addEventListener('click', openReceiveModal);
$('act-mint').addEventListener('click', () => { $('mint-modal').classList.remove('success'); openModal('mint-modal'); updateMintEstimate(); });
$('dd-mint-open').addEventListener('click', () => { $('mint-modal').classList.remove('success'); openModal('mint-modal'); updateMintEstimate(); });
$('net-btn').addEventListener('click', () => { renderStoragePersistence(); openModal('net-modal'); });
$('hero-connect').addEventListener('click', () => openConnectModal());
// the asset dropdown decides which send form shows — via classes on the modal,
// never inline styles on w-send/w-transfer (drivers read their inline display)
$('send-asset').addEventListener('change', () => {
  const dgb = $('send-asset').value === 'dgb';
  $('send-modal').classList.toggle('asset-dgb', dgb);
  $('send-modal').classList.toggle('asset-dd', !dgb);
});
$('w-create-choice').addEventListener('click', () => { setConnectMode('create'); $('w-create-name').value = nextWalletName(); $('w-create-pass').focus(); });
$('w-form-back').addEventListener('click', () => setConnectMode('choice'));
// Remind me later: the wallet simply stays backedUp:false — the badge nags
$('w-backup-done').addEventListener('click', closeConnectModal);
$('w-backup-success-done').addEventListener('click', closeConnectModal);
$('w-connect').addEventListener('click', openConnectModal);
// the address chip is the wallet-switcher trigger (spec §7); its embedded
// Disconnect button keeps its own job
$('w-chip').addEventListener('click', (e) => {
  if (e.target.closest('#w-disconnect')) return;
  openWalletModal();
});
// the chip is a role="button" span (a real <button> can't nest Disconnect), so
// Enter/Space must open the switcher for keyboard/AT users too — it is the
// ONLY entry point to add/switch/rename/export/remove (spec §7)
$('w-chip').addEventListener('keydown', (e) => {
  if (e.target !== $('w-chip')) return; // the inner Disconnect button handles its own keys
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault(); // Space must not scroll the page
  openWalletModal();
});
$('w-modal-close').addEventListener('click', () => closeConnectModal(true));
$('w-connect-modal').addEventListener('click', (e) => { if (e.target === $('w-connect-modal')) closeConnectModal(true); });
$('w-disconnect').addEventListener('click', () => lockWallet());

// Every script form this wallet will pay, by decodeAddress's `type` label.
// Deliberately an allow-list: witnessType() falls through to `witness_v<n>` for
// anything it does not recognise, and a future witness version is a script the
// user's coins would land in with no way back out.
const PAYABLE_ADDRESS_TYPES = new Set(['p2wpkh', 'p2wsh', 'p2tr', 'p2pkh', 'p2sh']);

function renderAddress() {
  // Never show an address for a guessed network: on a mainnet deployment with
  // an unreachable node the default would be testnet-encoded — confusing at
  // best. loadStatus retries until the node names its chain, then re-renders.
  const addressActions = [$('w-copy'), $('w-next'), $('w-faucet'), $('w-copy-dd'), $('w-compat-copy'),
    $('w-copy-icon'), $('w-copy-dd-icon'), $('w-prev-toggle')];
  if (!chainState.netKnown) {
    $('w-path').textContent = '';
    $('w-address').textContent = 'waiting for the node to report a supported network…';
    $('w-dd-address').textContent = '';
    $('w-compat-address').textContent = '';
    $('w-chip-addr').textContent = '…';
    $('w-qr').innerHTML = '';
    $('w-compat-qr').innerHTML = '';
    $('w-dd-qr').innerHTML = '';
    $('w-prev-list').innerHTML = '';
    for (const b of addressActions) b.disabled = true; // nothing here to copy/claim
    return;
  }
  for (const b of addressActions) b.disabled = false;
  const { path, address, p2wpkhAddress, internalKeyHex } = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index });
  $('w-path').textContent = path;
  $('w-address').textContent = address;
  // Gift key: the RAW x-only owner key behind this derivation, for receiving
  // mint-to-order treasuries. Public information (a pubkey) — but distinct
  // from the address, whose program is its one-way tweak; a gift minted to an
  // ADDRESS key strands the DD at a script no wallet watches.
  $('w-gift-key').textContent = encodeGiftKey(internalKeyHex, chainState.netName);
  // The SAME key's P2WPKH twin (dgb1q…, same index) for senders that cannot
  // pay taproot (#103 decision 1). Already watched for balance/history (#38),
  // so funds arriving here show up like any other coin.
  $('w-compat-address').textContent = p2wpkhAddress;
  // Same taproot key in DigiDollar base58check form — the ONLY encoding Core /
  // mobile wallets accept as a DigiDollar recipient (their senddigidollar checks
  // the DD…/TD…/RD… prefix). decodeDDAddress(address) yields the shared key.
  $('w-dd-address').textContent = encodeDDAddress(decodeDDAddress(address).outputKeyHex, chainState.netName);
  $('w-chip-addr').textContent = address.slice(0, 10) + '…' + address.slice(-4);
  updateReceiveQr();
  renderPrevAddresses();
}

// Receive QR + payment-request copy (#71). Bare address by default; when the
// user requests a specific amount, both switch to a BIP21 `digibyte:` URI so a
// mobile scan prefills address + amount. The address is encoded VERBATIM in
// byte mode — the uppercase/alphanumeric-mode trick makes a sparser QR, but
// BIP-173's "decoders must accept upper" is fiction in the wild: ecosystem
// wallets reject all-caps bech32, and the scan then reads as "invalid
// address" even though the same address pasted as text works (#103 spirit:
// interop beats elegance).
function drawAddressQr(el, address, requestSats) {
  const qr = qrcode(0, 'M');
  qr.addData(requestSats > 0n ? encodeBip21({ address, amountSats: requestSats }) : address, 'Byte');
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function updateReceiveQr() {
  if (!chainState.netKnown) return;
  const address = $('w-address').textContent;
  let requestSats = 0n;
  try {
    const raw = $('w-req-amount').value.trim();
    if (raw) requestSats = dgbToSats(raw);
  } catch { requestSats = 0n; } // partial/invalid input → fall back to bare address
  const useUri = requestSats > 0n;
  drawAddressQr($('w-qr'), address, requestSats);
  $('w-copy-uri').style.display = useUri ? '' : 'none';
  // the compat view mirrors the same request on the P2WPKH twin (#103): the
  // BIP21 amount applies to whichever address the sender is shown
  if ($('w-compat-section').style.display !== 'none') {
    drawAddressQr($('w-compat-qr'), $('w-compat-address').textContent, requestSats);
    $('w-compat-copy-uri').style.display = useUri ? '' : 'none';
  }
  // The DigiDollar form gets no amount: Core's senddigidollar takes an address,
  // not a URI, so a `digibyte:…?amount=` QR would be a request no DigiDollar
  // sender can act on. Bare address, always.
  if ($('rx-pane-dd').style.display !== 'none') drawAddressQr($('w-dd-qr'), $('w-dd-address').textContent, 0n);
}

// ---- Receive: DGB / DigiDollar form switch ----
// Not two addresses — one key in the two encodings the ecosystem needs. Core
// and mobile wallets reject dgb1p… for a DigiDollar send (#72) and this wallet
// would otherwise offer that form as a copy line with no QR to scan.
function setReceiveTab(tab) {
  const dd = tab === 'dd';
  $('rx-pane-dgb').style.display = dd ? 'none' : 'block';
  $('rx-pane-dd').style.display = dd ? 'block' : 'none';
  for (const [el, on] of [[$('rx-tab-dgb'), !dd], [$('rx-tab-dd'), dd]]) {
    el.classList.toggle('on', on);
    el.setAttribute('aria-selected', String(on));
  }
  if (dd) updateReceiveQr(); // the DD QR renders lazily, only when its pane is up
  renderPrevAddresses();     // the list re-encodes to match (no-op while collapsed)
}
$('rx-tab-dgb').addEventListener('click', () => setReceiveTab('dgb'));
$('rx-tab-dd').addEventListener('click', () => setReceiveTab('dd'));

// ---- Copy affordance on the address boxes ----
// data-copy names the element holding the text; data-copy-text carries it
// directly (the previous-address rows, which are built as markup).
const COPY_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 3.5A1.5 1.5 0 0 0 9 2H4a2 2 0 0 0-2 2v5a1.5 1.5 0 0 0 1.5 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const DONE_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
for (const el of document.querySelectorAll('.icon-btn')) el.innerHTML = COPY_ICON;
const copyTimers = new WeakMap(); // button → pending revert timer
const copyLabels = new WeakMap(); // button → its resting aria-label

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.icon-btn');
  if (!btn) return;
  const text = btn.dataset.copyText ?? $(btn.dataset.copy)?.textContent ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    $('w-open-err').textContent = surfaceError(err); // clipboard denied: say so, don't fake a tick
    return;
  }
  const label = copyLabels.get(btn) ?? btn.getAttribute('aria-label');
  copyLabels.set(btn, label); // a second tap mid-tick must not save "Copied" as the label
  btn.innerHTML = DONE_ICON;
  btn.classList.add('copied');
  btn.setAttribute('aria-label', 'Copied');
  clearTimeout(copyTimers.get(btn));
  copyTimers.set(btn, setTimeout(() => {
    btn.innerHTML = COPY_ICON;
    btn.classList.remove('copied');
    btn.setAttribute('aria-label', label);
  }, 1400));
});

// ---- Previously used addresses ----
// The receive chain is a list, not a single address: "Next address" hands out
// another one and the old ones stay watched (see syncReceiveIndex). This shows
// what has been handed out, and — from the data the money poll already
// fetches, so no extra requests — which of them have actually been paid.
let addressUse = new Map(); // derivation index → { used, sats }

// Address strings only. deriveTaprootAddress also returns privKeyHex, and key
// material must not sit in a cache that outlives a lock — this holds neither.
const prevAddrCache = new Map(); // `${walletGen}:${net}:${index}` → address
function receiveAddressAt(index) {
  const key = `${walletGen}:${chainState.netName}:${index}`;
  let hit = prevAddrCache.get(key);
  if (!hit) {
    hit = deriveTaprootAddress(wallet.seed, { ...wallet.network, index }).address;
    prevAddrCache.set(key, hit);
  }
  return hit;
}

function renderPrevAddresses() {
  const list = $('w-prev-list');
  if (list.style.display === 'none' || !wallet.seed || !chainState.netKnown) return;
  // the list speaks whichever form the tab does: a row copied while the
  // DigiDollar pane is up must be a DD… address, not the dgb1p… a DigiDollar
  // sender would reject (#72)
  const asDD = $('rx-pane-dd').style.display !== 'none';
  const rows = [];
  for (let i = wallet.index; i >= 0; i--) {
    const derived = receiveAddressAt(i);
    const address = asDD
      ? encodeDDAddress(decodeDDAddress(derived).outputKeyHex, chainState.netName)
      : derived;
    const use = addressUse.get(i);
    // three states worth distinguishing: the one on display, one that has been
    // paid, and one handed out that nobody has used yet
    const tag = i === wallet.index
      ? '<span class="rx-tag now">showing</span>'
      : use?.used
        ? '<span class="rx-tag">received</span>'
        : `<span class="rx-tag idle">${appConfig.indexer ? 'unused' : 'handed out'}</span>`;
    rows.push(`<div class="rx-row"><span class="rx-i mono">#${i}</span>`
      + `<span class="rx-addr mono" title="${esc(address)}">${esc(address.slice(0, 14))}…${esc(address.slice(-6))}</span>`
      + `${tag}<button type="button" class="icon-btn" data-copy-text="${esc(address)}" title="Copy address" aria-label="Copy address #${i}"></button></div>`);
  }
  list.innerHTML = rows.join('');
  for (const el of list.querySelectorAll('.icon-btn')) el.innerHTML = COPY_ICON;
}

function setPrevShown(show) {
  $('w-prev-list').style.display = show ? 'block' : 'none';
  $('w-prev-toggle').textContent = show ? 'Hide previous addresses' : 'Previously used addresses';
  if (show) renderPrevAddresses();
}
$('w-prev-toggle').addEventListener('click', () => {
  setPrevShown($('w-prev-list').style.display === 'none');
});

// Receive compat toggle (#103 decision 1, prominence raised): the receive view
// is taproot-first, but most third-party DGB wallets (Coinomi, exchanges)
// cannot pay dgb1p… yet — so the twin sits behind a full-size labeled button
// rather than a low-emphasis link. Still re-hides on every open.
function setCompatShown(show) {
  $('w-compat-section').style.display = show ? 'block' : 'none';
  $('w-compat-toggle').textContent = show ? 'Hide compatible address' : 'Use compatible address';
  if (show) updateReceiveQr(); // the twin QR renders lazily, only when revealed
}
$('w-compat-toggle').addEventListener('click', () => {
  setCompatShown($('w-compat-section').style.display === 'none');
});

// Bumped on every open. Async work started for one wallet must not land on the
// next one, and a wallet id is not enough to tell them apart: erasing the vault
// and restoring hands the same id ('w-1') to a completely different seed.
let walletGen = 0;

/** A vault secret is a Core descriptor rather than a mnemonic. */
const isDescriptorSecret = (secret) => /^(tr\(|\{"descbundle")/.test(String(secret ?? '').trim());
/** A stored descriptor secret → { primary, extra[] }. A single pasted line
 * still parses as a bundle of one, so older imports keep working. */
function descriptorBundleOf(secret) {
  const text = String(secret ?? '').trim();
  if (text.startsWith('{')) { const b = JSON.parse(text); return { primary: b.primary, extra: b.extra ?? [] }; }
  return { primary: text, extra: [] };
}

function openWallet(id, mnemonic) {
  walletGen += 1;
  wallet.id = id;
  wallet.mnemonic = mnemonic;
  // Two secret kinds live in the vault: a BIP39 mnemonic, or a DigiByte Core
  // private tr() descriptor (Core has no mnemonic to give — descriptors are
  // its only export). Everything downstream takes wallet.seed opaquely, so
  // both kinds behave identically from here on.
  wallet.isDescriptor = isDescriptorSecret(mnemonic);
  if (wallet.isDescriptor) {
    const bundle = descriptorBundleOf(mnemonic);
    wallet.seed = descriptorKeySource(bundle.primary);
    // Core exports one descriptor per address type AND per chain, so the
    // extras hold the REST of the same wallet (taproot change chain, native
    // segwit). Their coins must count toward the balance and be spendable —
    // otherwise an imported Core wallet shows a treasury but no DGB.
    wallet.extraSources = bundle.extra.map((d) => { try { return descriptorKeySource(d); } catch { return null; } }).filter(Boolean);
  } else {
    wallet.seed = mnemonicToSeed(mnemonic);
    wallet.extraSources = [];
  }
  // An address handed out in an earlier session must stay watched: opening at
  // index 0 would narrow the watch window to 0…2 (watchedDerivations) and hide
  // — and make unspendable — anything received further down the chain. The
  // vault counter remembers this device's handouts even before anyone pays
  // them; syncReceiveIndex covers what the counter cannot know.
  wallet.index = vault.meta()?.wallets.find((w) => w.id === id)?.receiveIndex ?? 0;
  syncExtraChainDepths(); // a Core chain's used range is unknown until we look
  scanStrandedGifts(); // a mis-gifted position must be visible from the first paint
  renderAddress();
  hideSeed();
  renderBackupCta();
  $('w-open-err').textContent = '';
  show('open');
  startMoneyPolling();
  syncReceiveIndex(); // ask the chain how far this seed has actually been used
  armAutolock(); // the inactivity countdown starts (only) with an unlocked wallet
}

// ---- Receive-chain rediscovery ----
// The vault counter is a per-device memory: a seed restored on another device
// (or in a re-created vault) knows nothing about the addresses it handed out.
// So on every open, ask the indexer how far down the chain this seed has been
// used, and open the watch window at least that wide. BIP44's gap limit is the
// stopping rule: 20 unused indices in a row means the chain ends there.
const RECEIVE_GAP = 20;
const RECEIVE_SCAN_BATCH = 5; // indices per round → 10 parallel history reads
let receiveScanGen = -1;      // walletGen whose scan COMPLETED (see walletGen: ids repeat, generations don't)
let receiveScanBusy = -1;     // walletGen whose scan is in flight
let receiveScanFailGen = -1;  // walletGen the failure count below belongs to
let receiveScanFails = 0;
// Backoff for a failing indexer. No ceiling on purpose: capping the retries
// reintroduces a slower version of the bug this replaces — a wallet that has
// silently stopped looking for its own coins — and the last step is a minute,
// so an indexer that stays down costs one request per minute per open wallet.
const RECEIVE_RETRY_MS = [2_000, 5_000, 15_000, 60_000];

/** Has either form of this derivation ever appeared on chain? The twin counts:
 * the compat flow (#103) hands out the P2WPKH form of an otherwise untouched
 * index, so a taproot-only scan would walk straight past a paid address. */
async function derivationUsed(d) {
  const [taproot, twin] = await Promise.all([
    fetchIndexer(`/address/${d.address}/history`),
    fetchIndexer(`/address/${d.p2wpkhAddress}/history`),
  ]);
  return taproot.history.length > 0 || twin.history.length > 0;
}

/** Batch form of derivationUsed — the gap walks check addresses in rounds, and
 * one bulk POST covers a whole round's taproot + twin histories where the old
 * path cost two GETs per derivation. Falls back per-derivation when the
 * indexer lacks the bulk endpoint. A failed entry throws (a read failure is
 * NOT an unused address — see the discovery-truncation fix). */
async function derivationsUsed(ds) {
  if (bulkIndexer) {
    const json = await fetchBulk(ds.flatMap((d) => [d.address, d.p2wpkhAddress]), ['history']);
    if (json) {
      return ds.map((d) => {
        const pair = [json.results?.[d.address], json.results?.[d.p2wpkhAddress]];
        // F3: an incomplete entry is UNKNOWN too — validateHistory would
        // tolerate the absent array into [] and read a USED address as fresh,
        // truncating the gap-limit walk past the wallet's own coins.
        if (pair.some((e) => !e || e.error || asIncomplete(e))) throw new Error('the balance index could not answer a discovery read');
        return pair.some((e) => validateHistory({ history: e.history }).history.length > 0);
      });
    }
  }
  return Promise.all(ds.map(derivationUsed));
}

// ---- Sync progress ----
// An imported Core wallet walks several key chains at login (gap-limit
// discovery per chain), which can take a few seconds — a single frozen
// "Syncing your wallet…" reads like a hang. Name the chain being scanned and
// the total so the wait is visibly progressing.
function totalChainCount() {
  return 1 + (wallet.extraSources?.length ?? 0); // the primary chain plus each imported one
}
function setSyncStatus(n, label) {
  const el = $('sync-status');
  if (!el) return;
  const total = totalChainCount();
  el.textContent = total > 1
    ? `Syncing chain ${n} of ${total}${label ? ` (${label})` : ''}…`
    : 'Syncing your wallet…';
}

async function syncReceiveIndex() {
  if (!wallet.seed || !appConfig.indexer || !chainState.netKnown) return;
  const gen = walletGen;
  // One scan per open, not one per netKnown re-render — openWallet and
  // loadStatus both call this. Two flags, not one: marking the generation
  // SCANNED before the I/O (which is what this used to do) meant a single
  // indexer error retired rediscovery for the rest of the session, and the
  // catch swallowed it, so a restored wallet sat there showing a confidently
  // wrong balance and never looked again.
  if (receiveScanGen === gen || receiveScanBusy === gen) return;
  if (receiveScanFailGen !== gen) { receiveScanFailGen = gen; receiveScanFails = 0; }
  receiveScanBusy = gen;
  setSyncStatus(1, wallet.isDescriptor ? 'taproot' : ''); // chain 1 of N
  let highest = -1;
  try {
    for (let from = 0, gap = 0; gap < RECEIVE_GAP; from += RECEIVE_SCAN_BATCH) {
      const batch = Array.from({ length: RECEIVE_SCAN_BATCH }, (_, k) => from + k);
      const used = await derivationsUsed(batch.map((i) =>
        deriveTaprootAddress(wallet.seed, { ...wallet.network, index: i })));
      // locked or switched mid-scan: this answer belongs to a wallet that is
      // no longer on screen, and wallet.seed may already be gone
      // Deliberately leaves receiveScanBusy set to this generation: the wallet
      // it belonged to is gone, and every route back in (openWallet) bumps
      // walletGen, so nothing can be deadlocked by a flag naming a dead one.
      if (!wallet.seed || walletGen !== gen) return;
      used.forEach((isUsed, k) => { if (isUsed) { highest = batch[k]; gap = 0; } else gap += 1; });
    }
  } catch (e) {
    // An indexer hiccup used to end rediscovery for the session. Retry with
    // backoff instead, and say so — the original complaint about this path was
    // as much that it failed invisibly as that it failed permanently.
    receiveScanBusy = -1;
    const wait = RECEIVE_RETRY_MS[Math.min(receiveScanFails, RECEIVE_RETRY_MS.length - 1)];
    receiveScanFails += 1;
    console.warn(`receive-chain scan failed (attempt ${receiveScanFails}), retrying in ${wait}ms:`, e.message);
    setTimeout(() => { if (walletGen === gen) syncReceiveIndex(); }, wait);
    return;
  }
  receiveScanGen = gen; // only now: the chain actually answered
  // One PAST the last index the chain has seen. `highest` was by definition
  // already paid, so offering it again on the receive screen re-uses an
  // address for no benefit; the watch window counts from 0, so moving one
  // further along stops nothing being watched.
  const next = highest + 1;
  if (next <= wallet.index) return;
  wallet.index = next;
  renderAddress();
  refreshMoney();
  rememberReceiveIndex(); // teach this device what the chain just taught us
}

/** Persist the handout counter. Best effort by design: losing it costs an
 * as-yet-unpaid address its watch until the next scan finds it funded — never
 * a coin — so it must not interrupt the receive flow with an error.
 *
 * Serialized: tapping "Next address" three times fires three vault writes, and
 * each one CAS-checks the rev it was computed from. Run in parallel, the later
 * two lose the race and get dropped — the wallet would come back at index 1
 * having handed out index 3. Queued behind each other, each write sees the
 * previous rev; one retry covers a conflict from another tab (the manager
 * re-synced before rethrowing, so the retry computes from fresh meta). */
let receivePersist = Promise.resolve();
function rememberReceiveIndex() {
  if (!wallet.id || vault.status !== 'unlocked') return;
  const gen = walletGen;
  // reads wallet.index when the write RUNS, not when it was queued: three fast
  // taps collapse into one landed write plus two no-ops (the vault skips a
  // write that wouldn't move the counter) instead of three serialized commits
  const write = () => (walletGen === gen && vault.status === 'unlocked'
    ? vault.setReceiveIndex(wallet.id, wallet.index)
    : Promise.resolve()); // switched or locked while queued — not our counter any more
  receivePersist = receivePersist.then(write).catch(write).catch(() => {});
}

// Shared teardown for lock AND wallet switch (spec §7): every pending draft
// holds per-UTXO private keys, and history/positions/balances belong to the
// outgoing wallet. Does NOT touch the vault key — lockWallet drops that on top.
function resetWalletState() {
  resetSend(); // pendingSend holds per-UTXO private keys — drop them with the seed
  resetMint(); // pendingMint holds the funding UTXO's private key — same
  resetTransfer(); // pendingTransfer holds DD + fee UTXO keys — same
  resetRedeem(); // pendingRedeem holds burn + fee UTXO keys — same
  resetConsolidate(); // pendingConsolidate holds every spendable coin's key — same
  $('w-send-out').textContent = '';
  $('w-mint-out').textContent = '';
  $('w-tr-out').textContent = '';
  $('w-rd-out').textContent = '';
  clearInterval(moneyTimer);
  $('w-money').style.display = 'none';
  // drop this wallet's Activity view so the next wallet doesn't inherit its
  // expanded page or see its rows flash before the first refresh (#69).
  allHistory = []; historyLimit = 8; myAddrSet = new Set(); $('w-history').innerHTML = '';
  // the outgoing wallet's used-address markers must not label the next one's
  addressUse = new Map(); $('w-prev-list').innerHTML = '';
  // the next wallet's balances are unknown until its first refresh — a stale
  // figure must not leak into fiat rows or the remove-ceremony warning
  lastConfirmedDgb = null; lastDdUsd = 0; openPositions = new Map(); lastIndexerTip = null;
  strandedPositions = []; renderStranded(); // the outgoing wallet's finds must not linger
  extraPerAddr = []; extraAddrMeta = []; extraChainsDue = true; extraChainUsed = []; // …nor its cached chains
  lastGoodRecords.clear(); // …nor its last-good scan records (F3): an address string may recur across wallets
  renderBackupStrip(); // funds unknown again — the outgoing wallet's nag must not carry over
  hideSeed(); // an open reveal must not float over the next view (§5)
  closeConnectModal(); // nor a mid-ceremony backup view — words wiped with it
  closeWalletModal(); // nor the switcher (lock teardown, §5)
  // nor a pending re-auth prompt: its promise must settle (false) so the
  // awaiting flow dies here instead of resuming against a torn-down wallet,
  // and the password box must not float over the locked screen (§5)
  settleReauth(false);
  clearTimeout(autolockTimer); // openWallet re-arms it on switch/unlock
}

function lockWallet() {
  vault.lock(); // drops the session key + every plaintext mnemonic
  wallet.id = null;
  wallet.mnemonic = null;
  wallet.seed = null;
  resetWalletState();
  $('w-unlock-pass').value = '';
  $('w-locked-err').textContent = '';
  show('locked');
}

/** Switch the open view to another wallet in the unlocked vault: the full
 * lock-style state reset (drafts, history, positions) WITHOUT dropping the
 * vault key, then open the new wallet (spec §7). */
function switchToWallet(id) {
  resetWalletState();
  openWallet(id, vault.getMnemonic(id));
}

// ---- Cross-tab sync (spec §1) ----
// The vault manager refreshes its own record on BroadcastChannel writes, but
// the UI must follow: an erased vault relocks this tab (dropping the seed from
// the page), a cross-tab switch/remove re-opens the wallet the vault now says
// is active, and meta-driven surfaces (switcher list, backup badge, locked
// names) re-render. Also runs after a VaultConflictError — the manager
// refreshed before rethrowing, so the same reconciliation applies.
function reconcileVaultUi() {
  const st = vault.status;
  if (st === 'unlocked') {
    const m = vault.meta();
    if (wallet.id && m.activeId !== wallet.id) {
      // another tab switched away from (or removed) the wallet on display —
      // the shown address and its guard state must come from the same wallet
      switchToWallet(m.activeId);
    } else {
      renderBackupCta(); // badge/strip may have changed (quiz pass elsewhere)
      if ($('wallet-modal').classList.contains('open')) renderWalletList();
    }
    return;
  }
  // dropped out of unlocked: the vault was erased or re-created under a new
  // salt in another tab. The in-memory seed is torn down like a lock.
  if (wallet.seed || wallet.id) {
    wallet.id = null;
    wallet.mnemonic = null;
    wallet.seed = null;
    resetWalletState();
  }
  const target = st === 'none' ? 'none' : 'locked';
  if (shownState !== target) show(target);
  else if (target === 'locked' && connectMode === 'unlock') renderLockedNames(); // names may have changed
}
keystore.onVaultChanged(() => {
  vault.refresh().then(reconcileVaultUi).catch(() => {});
});

// Locked screen: every wallet's name from the cleartext meta and ONE password
// field (spec §7). A not-yet-migrated v1 record has no names → line hidden.
function renderLockedNames() {
  const el = $('w-locked-names');
  const wallets = vault.meta()?.wallets ?? [];
  el.textContent = wallets.length > 1
    ? `${wallets.length} wallets · ${wallets.map((w) => w.name).join(', ')}`
    : wallets[0]?.name ?? '';
  el.style.display = el.textContent ? 'block' : 'none';
}

// "Wallet N" prefill for the create/restore name field — N past every taken
// default so an untouched submit never trips the duplicate-name guard.
function nextWalletName() {
  const names = new Set((vault.meta()?.wallets ?? []).map((w) => w.name.trim().toLowerCase()));
  let n = names.size + 1;
  while (names.has(`wallet ${n}`)) n += 1;
  return `Wallet ${n}`;
}

/** Put a wallet into the vault: first one creates the vault (master password
 * fields), later ones ride the unlocked session key — no password re-prompt.
 * `masterPass` lets flows whose UI can't reach this form's fields (the GitHub
 * restore modal) hand in a password they collected and validated themselves. */
async function createWalletEntry({ name, mnemonic, backedUp = false, masterPass }) {
  if (vault.status === 'unlocked') {
    // duplicate-mnemonic contract: an existing seed comes back existed:true
    const { id, existed } = await vault.addWallet({ name, mnemonic, backedUp });
    await vault.setActive(id); // new or duplicate, it becomes the active wallet
    markVaultTombstone();
    refreshStoragePersistence(true);
    return { id, existed };
  }
  const pass = masterPass ?? $('w-create-pass').value;
  if (pass.length < 8) throw new Error('password must be at least 8 characters');
  if (masterPass == null && pass !== $('w-create-pass2').value) throw new Error('passwords do not match');
  const id = await vault.createVault(pass, { name, mnemonic, backedUp });
  markVaultTombstone();
  refreshStoragePersistence(true); // there is now something worth protecting
  return { id, existed: false };
}

// Error → user copy at the UI boundary. A lost CAS race must never leak the
// internal VaultConflictError message (spec §1): show the mandated copy and
// re-drive the UI — the manager already re-synced from storage before
// rethrowing, so reconcile renders what the other tab wrote.
function surfaceError(e) {
  if (e instanceof keystore.VaultConflictError) {
    reconcileVaultUi();
    return 'This wallet was changed in another tab — reloading.';
  }
  return e.message;
}

async function busy(btn, errId, fn) {
  const el = $(errId);
  el.textContent = '';
  // A fragmentation error (consolidatable flag) reveals the "Consolidate
  // coins" offer that sits under this error area, when one exists (#103
  // decision 2). Any other outcome — success or a different error — hides it,
  // so a stale offer never outlives the error it belongs to.
  const offer = $(errId + '-consolidate');
  if (offer) offer.style.display = 'none';
  btn.disabled = true;
  // A silently-greyed button reads as a hang while the coin scans run
  // (seconds of network work behind Redeem/Transfer) — say so and pulse.
  // Text-only buttons get the label swap; anything with markup keeps its
  // content and just pulses.
  const label = btn.childElementCount === 0 ? btn.textContent : null;
  btn.classList.add('is-busy');
  if (label) btn.textContent = 'Working…';
  try {
    await fn();
  } catch (e) {
    el.textContent = surfaceError(e);
    if (offer && e.consolidatable) offer.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    if (label) btn.textContent = label;
  }
}

$('w-create').addEventListener('click', (e) =>
  busy(e.target, 'w-none-err', async () => {
    const name = $('w-create-name').value.trim() || nextWalletName();
    const mnemonic = generateMnemonic();
    const { id } = await createWalletEntry({ name, mnemonic });
    // the wallet opens immediately; the backup ceremony overlays it (drivers
    // click w-backup-done once to dismiss and find the wallet already open).
    // switchToWallet also resets the previous wallet's state (add-while-open).
    switchToWallet(id);
    beginBackupCeremony(id, mnemonic);
  }));

$('w-show-restore').addEventListener('click', () => { setConnectMode('restore'); $('w-create-name').value = nextWalletName(); $('w-restore-seed').focus(); });

// ---- Core descriptor import ----
// The migration path off DigiByte Core, which has no BIP39 phrase to export.
// The descriptor IS the secret: stored encrypted like a mnemonic, and marked
// backed up because it came from a wallet the user already keeps (Core).
$('w-show-desc').addEventListener('click', () => {
  setConnectMode('descriptor');
  $('w-create-name').value = nextWalletName();
  $('w-desc-text').focus();
});
$('w-desc-go').addEventListener('click', (e) =>
  busy(e.target, 'w-none-err', async () => {
    const pasted = $('w-desc-text').value.trim();
    // Accepts the WHOLE `listdescriptors true` output: Core emits one
    // descriptor per address type AND per chain, so importing a single line
    // brings in a fraction of the wallet (the "I see the treasury but none of
    // my DGB" report). Everything usable is kept; the rest is reported.
    const bundle = parseDescriptorBundle(pasted);
    const desc = bundle.primary;
    const parsed = parseTrDescriptor(desc);            // throws with a plain-language reason
    // typed acknowledgement AFTER the descriptor parses: no point demanding it
    // for a paste that was never going to work
    if ($('w-desc-ack').value.trim().toUpperCase() !== 'IMPORT') {
      throw new Error('type IMPORT in the confirmation box — this gives this browser spending control of that Core wallet');
    }
    if (!chainState.netKnown) throw new Error('still connecting to the node — try again in a moment');
    const probe = deriveTaprootAddress(descriptorKeySource(desc), { ...HD_NETWORKS[chainState.netName], index: 0 });
    if (!probe.address) throw new Error('that descriptor did not produce an address');
    const name = $('w-create-name').value.trim() || nextWalletName();
    // the WHOLE usable set is the wallet's secret — one JSON string so the
    // vault schema (one secret per wallet) is unchanged
    const secret = bundle.extra.length
      ? JSON.stringify({ descbundle: 1, primary: bundle.primary, extra: bundle.extra })
      : bundle.primary;
    const { id, existed } = await createWalletEntry({ name, mnemonic: secret, backedUp: true });
    $('w-desc-text').value = ''; $('w-desc-ack').value = ''; // key material never lingers in the DOM (§2)
    switchToWallet(id);
    if (existed) {
      const w = vault.meta().wallets.find((x) => x.id === id);
      openWalletModal(`You already have this descriptor (${w.name}) — switched to it.`);
    } else {
      // say exactly what came across — and what did not, so missing coins are
      // never a mystery the user has to discover from a wrong balance
      const chains = 1 + bundle.extra.length;
      const missed = bundle.unsupported.length
        ? ` Not imported: ${bundle.unsupported.join(', ')} address types — DGBclick Wallet handles taproot and native segwit only, so move any coins on those inside Core first.`
        : '';
      openWalletModal(`Imported from Core${parsed.origin ? ` (${parsed.origin})` : ''}: ${chains} key chain${chains === 1 ? '' : 's'}. `
        + `Its first receive address is ${probe.address.slice(0, 14)}… — check it matches the one Core shows.${missed}`);
    }
  }));

$('w-restore-go').addEventListener('click', (e) =>
  busy(e.target, 'w-none-err', async () => {
    const words = $('w-restore-seed').value.trim().toLowerCase().split(/\s+/).join(' ');
    if (!validateMnemonic(words)) throw new Error('not a valid BIP39 seed phrase (check the words and their order)');
    const name = $('w-create-name').value.trim() || nextWalletName();
    // typing the words proves possession — a restored wallet IS backed up (§2)
    const { id, existed } = await createWalletEntry({ name, mnemonic: words, backedUp: true });
    $('w-restore-seed').value = ''; // no mnemonic left in the DOM (§2 rules)
    switchToWallet(id);
    // duplicate-mnemonic contract (§2): say so in the wallet switcher
    if (existed) {
      const w = vault.meta().wallets.find((x) => x.id === id);
      openWalletModal(`You already have this wallet (${w.name}) — switched to it.`);
    }
  }));

// ---- Keystore file import (spec §4) ----
// Picker → validate the envelope (clear errors) → the FILE's password →
// decrypt → add as a new wallet and switch to it. A file import proves the
// password, not the words, so the wallet stays backedUp:false.
$('w-show-import').addEventListener('click', () => { setConnectMode('import'); });

$('w-import-file').addEventListener('change', (e) =>
  busy(e.target, 'w-none-err', async () => {
    pendingImport = null;
    $('w-import-info').style.display = 'none';
    $('w-import-warn').style.display = 'none';
    const file = $('w-import-file').files[0];
    if (!file) return;
    pendingImport = keystore.parseKeystoreFile(await file.text());
    const when = new Date(pendingImport.exportedAt);
    $('w-import-info').textContent = `“${pendingImport.name}”` +
      (Number.isNaN(when.getTime()) ? '' : ` — exported ${when.toLocaleDateString('en-CA')}`) +
      (pendingImport.network ? ` on ${pendingImport.network}` : '');
    $('w-import-info').style.display = 'block';
    // network mismatch: warn but allow (§4) — mnemonics are network-agnostic,
    // the same seed just derives different-looking addresses per chain
    if (pendingImport.network && chainState.netKnown && pendingImport.network !== chainState.netName) {
      $('w-import-warn').textContent = `This file was exported on ${pendingImport.network}, but this wallet runs on ` +
        `${chainState.netName}. The seed phrase works on both networks — only the addresses look different.`;
      $('w-import-warn').style.display = 'block';
    }
    $('w-import-pass').focus();
  }));

// name from the envelope, de-duplicated against the vault ("Trading" → "Trading 2")
function importedWalletName(name) {
  const base = String(name ?? '').trim() || nextWalletName();
  const taken = new Set((vault.meta()?.wallets ?? []).map((w) => w.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base.toLowerCase()} ${n}`)) n += 1;
  return `${base} ${n}`;
}

$('w-import-go').addEventListener('click', (e) =>
  busy(e.target, 'w-none-err', async () => {
    if (!pendingImport) throw new Error('pick a backup file first');
    let mnemonic;
    try {
      mnemonic = await keystore.decryptKeystoreFile(pendingImport, $('w-import-pass').value);
    } catch (err) {
      throw err?.name === 'OperationError' ? new Error('wrong password for this file') : err;
    }
    if (!validateMnemonic(mnemonic)) throw new Error('the file decrypted, but it does not hold a valid seed phrase');
    const name = importedWalletName(pendingImport.name);
    const { id, existed } = await createWalletEntry({ name, mnemonic, backedUp: false });
    switchToWallet(id); // also resets the import step (mode leaves 'import')
    // duplicate-mnemonic contract (§2): say so in the wallet switcher
    if (existed) {
      const w = vault.meta().wallets.find((x) => x.id === id);
      openWalletModal(`You already have this wallet (${w.name}) — switched to it.`);
    }
  }));

$('w-unlock').addEventListener('click', (e) =>
  busy(e.target, 'w-locked-err', async () => {
    let meta;
    try {
      meta = await vault.unlock($('w-unlock-pass').value); // migrates v1 transparently
    } catch (err) {
      // GCM auth failure = wrong password; anything else (storage failure,
      // interrupted migration) deserves its real message
      throw err?.name === 'OperationError' ? new Error('wrong password') : err;
    }
    $('w-unlock-pass').value = '';
    markVaultTombstone();
    refreshStoragePersistence(true); // an unlocked vault is worth protecting
    // one password opens the whole vault; the switcher picks any other wallet
    openWallet(meta.activeId, vault.getMnemonic(meta.activeId));
  }));
$('w-unlock-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('w-unlock').click(); });

// ---- Global reset ceremony (spec §5, locked screen only) ----
// "Erase all wallets on this device": list every wallet's name, arm the
// button only on a typed ERASE, then wipe v1 and v2 records alike. A
// not-yet-migrated v1 record has no names — it migrates to "Wallet 1", so
// call it that here too.
$('w-forget').addEventListener('click', (e) => {
  e.preventDefault();
  const names = (vault.meta()?.wallets ?? []).map((w) => w.name);
  $('w-erase-names').innerHTML = (names.length ? names : ['Wallet 1 (created by an older version)'])
    .map((n) => `<li>${esc(n)}</li>`).join('');
  setConnectMode('erase');
  $('w-erase-input').focus();
});
$('w-erase-input').addEventListener('input', () => {
  $('w-erase-go').disabled = $('w-erase-input').value.trim() !== 'ERASE';
});
$('w-erase-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('w-erase-go').disabled) $('w-erase-go').click(); });
$('w-erase-cancel').addEventListener('click', () => setConnectMode('unlock'));
$('w-erase-go').addEventListener('click', (e) =>
  busy(e.target, 'w-erase-err', async () => {
    await keystore.deleteAllRecords();
    await vault.load();
    clearVaultTombstone(); // deliberate erase — no "you had a wallet" ghost
    show('none'); // back to the guest hero; the modal drops to choice mode
  }));

$('w-lock').addEventListener('click', lockWallet);
$('w-next').addEventListener('click', () => {
  wallet.index += 1;
  renderAddress();
  refreshMoney();
  rememberReceiveIndex(); // this address is now out in the world — keep watching it
});
$('w-copy').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () => navigator.clipboard.writeText($('w-address').textContent)));
$('w-copy-dd').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () => navigator.clipboard.writeText($('w-dd-address').textContent)));
// BIP21 request amount (#71): live-redraw the QR, and copy the full payment URI.
$('w-req-amount').addEventListener('input', updateReceiveQr);
$('w-copy-uri').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () =>
    navigator.clipboard.writeText(encodeBip21({ address: $('w-address').textContent, amountSats: dgbToSats($('w-req-amount').value) }))));
// compat twin copy buttons (#103 decision 1) — the payment request carries the
// twin address, so the BIP21 amount applies to the address actually shown
$('w-compat-copy').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () => navigator.clipboard.writeText($('w-compat-address').textContent)));
$('w-compat-copy-uri').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () =>
    navigator.clipboard.writeText(encodeBip21({ address: $('w-compat-address').textContent, amountSats: dgbToSats($('w-req-amount').value) }))));
$('w-faucet').addEventListener('click', (e) =>
  busy(e.target, 'w-open-err', async () => {
    $('w-faucet-out').textContent = 'Requesting…';
    try {
      // 35s: the server proxies the claim with its own 30s upstream timeout
      const json = await fetchJson('/api/faucet/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: $('w-address').textContent }),
      }, 35_000, 'the faucet');
      $('w-faucet-out').textContent = `Sent ${json.amountDgb.toLocaleString('en-US')} DGB — tx ${json.txid.slice(0, 16)}…`;
    } catch (err) {
      $('w-faucet-out').textContent = '';
      throw err;
    }
  }));

// ---- Inactivity auto-lock (spec §5) ----
// Device-scoped preference in localStorage (minutes; 0 = Never) — NOT in the
// vault, so it is readable without an unlock and never follows a keystore
// file to another device. The ?autolockSecs= override exists for drivers and
// is honored ONLY in mock mode: on a live deployment a crafted link must not
// silently disable (or stretch) auto-lock.
function autolockDelayMs() {
  if (appConfig.mock) {
    const secs = Number(new URLSearchParams(location.search).get('autolockSecs'));
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  let raw = null;
  try { raw = localStorage.getItem(AUTOLOCK_KEY); } catch { /* private mode → default */ }
  return autolockMinutes(raw) * 60_000; // 0 = Never
}
let autolockTimer = null;
function armAutolock() {
  clearTimeout(autolockTimer);
  if (vault.status !== 'unlocked') return; // the timer only runs while unlocked
  const ms = autolockDelayMs();
  if (!ms) return; // Never
  // re-check on fire: the vault may have been erased/removed since arming
  autolockTimer = setTimeout(() => { if (vault.status === 'unlocked') lockWallet(); }, ms);
}
// Activity = pointerdown/keydown anywhere, throttled to one re-arm a second —
// typing must not schedule hundreds of timers.
let lastActivityArm = 0;
function noteActivity() {
  if (Date.now() - lastActivityArm < 1000) return;
  lastActivityArm = Date.now();
  armAutolock();
}
document.addEventListener('pointerdown', noteActivity, true);
document.addEventListener('keydown', noteActivity, true);
$('w-autolock').addEventListener('change', () => {
  try { localStorage.setItem(AUTOLOCK_KEY, $('w-autolock').value); } catch { /* stays a session preference */ }
  armAutolock();
});

// ---- Per-transaction spend ceiling (txcap.js) ----
// Read fresh on every use rather than cached: a second tab may have changed it,
// and a stale cached ceiling is exactly the wrong thing to be holding when the
// question is "may this transaction proceed".
const currentTxCapUsd = () => readTxCapUsd();

/** Re-render the banner so it always states the ceiling actually in force. */
function refreshCapChrome() {
  const chain = chainState.chain;
  if (!chain) return;
  const { banner } = networkChrome(chain, currentTxCapUsd());
  const bannerEl = $('net-banner');
  bannerEl.textContent = banner ?? '';
  bannerEl.hidden = banner === null;
}

// The select is the REQUEST; the stored value is the decision. They are kept
// apart on purpose: an unfinished ceremony must leave the ceiling untouched,
// so the select is snapped back to reality whenever the user backs out.
let pendingCapChoice = null;
function renderCapSelect() {
  $('w-txcap').value = txCapStorageValue(currentTxCapUsd());
}
function closeCapCeremony() {
  $('txcap-modal').classList.remove('open');
  $('w-txcap-input').value = '';
  $('w-txcap-go').disabled = true;
  $('w-txcap-err').textContent = '';
  pendingCapChoice = null;
  renderCapSelect(); // abandoning the ceremony must not leave the UI lying
}

$('w-txcap').addEventListener('change', () => {
  const current = currentTxCapUsd();
  const next = txCapUsd($('w-txcap').value);
  if (!isRaise(current, next)) {
    // Tightening, or re-picking what is already set: apply immediately. Making
    // people confirm a SAFER choice just teaches them to click through.
    try { localStorage.setItem(TXCAP_KEY, txCapStorageValue(next)); } catch { /* session-only */ }
    renderCapSelect();
    refreshCapChrome();
    return;
  }
  pendingCapChoice = next;
  $('w-txcap-new').textContent = txCapLabel(next);
  $('w-txcap-old').textContent = txCapLabel(current);
  $('w-txcap-unlimited').style.display = next === null ? 'block' : 'none';
  $('txcap-modal').classList.add('open');
  $('w-txcap-input').focus();
});

const CAP_ACK_PHRASE = 'I ACCEPT THE RISK';
$('w-txcap-input').addEventListener('input', () => {
  // Exact phrase, trimmed for stray whitespace but not case-folded: typing it
  // out is the point of the ceremony.
  $('w-txcap-go').disabled = $('w-txcap-input').value.trim() !== CAP_ACK_PHRASE;
});
$('w-txcap-go').addEventListener('click', () => {
  if (pendingCapChoice === undefined) return;
  if ($('w-txcap-input').value.trim() !== CAP_ACK_PHRASE) return; // belt and braces
  try {
    localStorage.setItem(TXCAP_KEY, txCapStorageValue(pendingCapChoice));
  } catch {
    $('w-txcap-err').textContent = 'This browser refused to store the setting (private mode?). The limit is unchanged.';
    return;
  }
  pendingCapChoice = null;
  closeCapCeremony();
  refreshCapChrome();
});
$('w-txcap-cancel').addEventListener('click', closeCapCeremony);
$('txcap-modal').addEventListener('click', (e) => {
  if (e.target === $('txcap-modal') || e.target.hasAttribute('data-close')) closeCapCeremony();
});

// ---- Password re-auth (spec §5) ----
// One small prompt reused by every sensitive action: seed reveal, backup
// re-entry, and keystore export. Remove-wallet uses its own type-the-name
// ceremony instead. Resolves the TYPED password (truthy) only after
// verifyPassword — a decrypt probe against storage, no state change — and
// false on cancel; boolean callers and the export (which derives the file's
// key from the password) share the same gate.
let reauthResolve = null;
function requireReauth(hint) {
  return new Promise((resolve) => {
    reauthResolve = resolve;
    $('reauth-hint').textContent = hint;
    $('reauth-pass').value = '';
    $('reauth-err').textContent = '';
    $('reauth-modal').classList.add('open');
    $('reauth-pass').focus();
  });
}
function settleReauth(ok) {
  const pass = ok && $('reauth-pass').value; // never empty: createVault enforces ≥8 chars
  $('reauth-modal').classList.remove('open');
  $('reauth-pass').value = '';
  reauthResolve?.(pass);
  reauthResolve = null;
}
$('reauth-go').addEventListener('click', (e) =>
  busy(e.target, 'reauth-err', async () => {
    if (!(await vault.verifyPassword($('reauth-pass').value))) throw new Error('wrong password');
    settleReauth(true);
  }));
$('reauth-cancel').addEventListener('click', () => settleReauth(false));
$('reauth-modal').addEventListener('click', (e) => { if (e.target === $('reauth-modal')) settleReauth(false); });
$('reauth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('reauth-go').click(); });

// ---- Seed reveal ceremony + backup quiz (spec §2/§5) ----
// While blurred the grids hold DECOY words (random BIP39, re-rolled per open)
// so the blur cannot be peeked through; "Tap to reveal" swaps in the real
// words. Real words exist in the DOM only while a reveal step is open.
function randomBip39Words(n, exclude = new Set()) {
  const out = [];
  while (out.length < n) {
    const w = wordlist[crypto.getRandomValues(new Uint32Array(1))[0] % wordlist.length];
    if (!exclude.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}
function shuffle(arr) { // Fisher–Yates over a copy
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// newline-joined so the grid's textContent stays space-separable words —
// drivers capture the mnemonic with textContent.trim().split(/\s+/)
const wordGridHtml = (words) => words.map((w) => `<li>${esc(w)}</li>`).join('\n');

let ceremony = null; // { id, words, quiz } while the backup flow is open

function renderBackupGrid(revealed) {
  $('w-backup-words').innerHTML = wordGridHtml(revealed ? ceremony.words : randomBip39Words(ceremony.words.length));
  $('w-backup-reveal').classList.toggle('blurred', !revealed);
}
/** Open the reveal → quiz flow over the (already open) wallet. */
function beginBackupCeremony(id, mnemonic) {
  ceremony = { id, words: mnemonic.trim().split(/\s+/), quiz: null };
  renderBackupGrid(false);
  setConnectMode('backup');
  $('w-connect-modal').classList.add('open');
}
$('w-backup-show').addEventListener('click', () => { renderBackupGrid(true); armSeedHide(); });
$('w-backup-continue').addEventListener('click', () => { buildQuiz(); setConnectMode('quiz'); });

// Quiz: 3 slots at distinct random indices (ascending); chips are ONLY the 3
// removed words + 6 random decoys — never the full seed in legible plaintext.
// Every attempt re-randomizes indices and re-rolls decoys (unlimited retries).
function buildQuiz() {
  const { words } = ceremony;
  const idxs = shuffle([...words.keys()]).slice(0, 3).sort((a, b) => a - b);
  const chips = shuffle([...idxs.map((i) => words[i]), ...randomBip39Words(6, new Set(words))]);
  ceremony.quiz = { idxs, chips, filled: [null, null, null] }; // filled = chip indices (words can repeat)
  renderQuiz();
}
function renderQuiz() {
  const q = ceremony.quiz;
  $('w-quiz-slots').innerHTML = q.idxs.map((wi, s) => {
    const chip = q.filled[s];
    return `<button type="button" class="quiz-slot${chip == null ? '' : ' filled'}" data-slot="${s}">` +
      `<span class="qn">Word #${wi + 1}</span><span class="mono">${chip == null ? '·' : esc(q.chips[chip])}</span></button>`;
  }).join('');
  $('w-quiz-chips').innerHTML = q.chips.map((w, i) =>
    `<button type="button" class="quiz-chip secondary" data-chip="${i}"${q.filled.includes(i) ? ' disabled' : ''}>${esc(w)}</button>`).join('');
}
$('w-quiz-chips').addEventListener('click', (e) => {
  const i = e.target?.dataset?.chip;
  if (i == null || !ceremony?.quiz) return;
  const q = ceremony.quiz;
  const slot = q.filled.indexOf(null); // chips fill the next empty slot
  if (slot === -1 || q.filled.includes(Number(i))) return;
  q.filled[slot] = Number(i);
  renderQuiz();
});
$('w-quiz-slots').addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-slot]');
  if (!btn || !ceremony?.quiz) return;
  const q = ceremony.quiz;
  if (q.filled[btn.dataset.slot] == null) return;
  q.filled[btn.dataset.slot] = null; // click a filled slot to clear it
  renderQuiz();
});
$('w-quiz-verify').addEventListener('click', (e) =>
  busy(e.target, 'w-quiz-err', async () => {
    const q = ceremony.quiz;
    if (q.filled.some((c) => c == null)) throw new Error('fill in all three words first');
    if (!q.idxs.every((wi, s) => q.chips[q.filled[s]] === ceremony.words[wi])) {
      buildQuiz(); // fresh indices, fresh decoys, cleared slots
      throw new Error('Not quite — check your written copy and try again.');
    }
    await vault.setBackedUp(ceremony.id); // cleared ONLY by this quiz pass
    renderBackupCta();
    setConnectMode('backup-done'); // success beat; Done closes
  }));

// Encrypted backup file offered AT the ceremony's success beat (audit M1) —
// not only buried in the switcher. Same re-auth gate as the switcher export:
// it re-proves the password the file will need. Export does not set backedUp
// (the quiz just did that, honestly); the file stays messaged as secondary.
$('w-backup-file').addEventListener('click', (e) =>
  busy(e.target, 'w-backup-file-out', async () => {
    const id = ceremony?.id ?? wallet.id;
    if (!id) throw new Error('no wallet to export');
    const pass = await requireReauth('Confirm your password to save an encrypted backup file.');
    if (!pass) return;
    const w = vault.meta().wallets.find((x) => x.id === id);
    downloadKeystoreFile(await keystore.buildKeystoreFile({
      name: w.name,
      network: chainState.netKnown ? chainState.netName : null,
      mnemonic: vault.getMnemonic(id),
      password: pass,
    }));
    $('w-backup-file-out').textContent = `Saved ${keystore.keystoreFileName(w.name)} — it only opens with your password. ` +
      'It is a convenience copy, NOT a replacement for the written words.';
  }));

// ---- Backup-status surfaces (spec §3) ----
// The active wallet's backedUp flag drives the header badge, the net-modal
// button and the balance-gated strip; all re-render on wallet switch
// (openWallet) and on quiz pass. The flag is cleared ONLY by a quiz pass.
function renderBackupCta() {
  // keyed to the DISPLAYED wallet (wallet.id), not vault activeId: a cross-tab
  // setActive must not borrow another wallet's flag for the shown address
  const m = vault.meta();
  const active = m?.wallets.find((w) => w.id === wallet.id);
  const nag = Boolean(active && !active.backedUp);
  $('w-backup-now').style.display = nag ? 'block' : 'none';
  $('w-backup-badge').style.display = nag ? 'inline-block' : 'none';
  renderBackupStrip();
}

/** Every backup re-entry surface (badge, strip, receive guard, net-modal
 * button) funnels here — re-auth gated like any other seed access (§5). */
async function reenterBackupCeremony() {
  if (!wallet.id) return;
  if (!(await requireReauth('Confirm your password to back up this wallet.'))) return;
  $('net-modal').classList.remove('open');
  beginBackupCeremony(wallet.id, vault.getMnemonic(wallet.id));
}
$('w-backup-now').addEventListener('click', reenterBackupCeremony);
$('w-backup-badge').addEventListener('click', reenterBackupCeremony);

// Balance-gated warning strip: the active wallet is not backed up AND holds
// anything the indexer can see (confirmed DGB, spendable DD, or a locked
// position) — OR the browser has REFUSED persistent storage (audit C2): an
// evictable vault is at risk even at zero balance, so the nag escalates.
// Dismiss is per wallet, per page load — the nag comes back next
// session by design. A no-indexer deployment never learns the balance, so
// the receive interception below is the only funds-arriving guard there.
const stripDismissed = new Set(); // wallet ids dismissed this session
function renderBackupStrip() {
  const m = vault.status === 'unlocked' ? vault.meta() : null;
  const active = m?.wallets.find((w) => w.id === wallet.id); // the wallet on display
  if (!active) { $('w-backup-strip').style.display = 'none'; return; }
  const funds = (lastConfirmedDgb ?? 0) > 0 || lastDdUsd > 0 || openPositions.size > 0;
  const evictable = storagePersisted === false;
  const nag = Boolean(!active.backedUp && (funds || evictable) && !stripDismissed.has(active.id));
  if (nag) {
    $('w-backup-strip-text').textContent = funds
      ? 'This wallet holds funds but has no backup — if this browser data is lost, the funds are gone.'
      : 'This browser has NOT promised to keep site data — it may erase this wallet under storage pressure, and the wallet has no backup. Back up the seed phrase now.';
  }
  $('w-backup-strip').style.display = nag ? 'block' : 'none';
}
$('w-backup-strip-go').addEventListener('click', reenterBackupCeremony);
$('w-backup-strip-dismiss').addEventListener('click', () => {
  stripDismissed.add(wallet.id);
  renderBackupStrip();
});

// Receive interception (BlueWallet pattern, spec §3): opening Receive on an
// un-backed-up wallet shows a warning step first — EVERY open until the quiz
// passes; "Continue anyway" is good for that one open. Both entry points
// (act-receive and the no-indexer card) come through this gate.
function openReceiveModal() {
  // the guard must judge the wallet whose ADDRESS is shown (wallet.id) — a
  // cross-tab setActive to a backed-up wallet must not skip the interception
  // for this tab's still-displayed, un-backed-up address (spec §3)
  const m = vault.meta();
  const active = m?.wallets.find((w) => w.id === wallet.id);
  const guard = Boolean(active && !active.backedUp);
  $('w-receive-guard').style.display = guard ? 'block' : 'none';
  $('w-receive-body').style.display = guard ? 'none' : 'block';
  setCompatShown(false); // taproot-first on every open (#103 decision 1)
  setReceiveTab('dgb'); // DGB is the default form; DigiDollar is a deliberate switch
  setPrevShown(false);  // the current address is the answer to "receive" — history is opt-in
  openModal('receive-modal');
}
$('w-receive-anyway').addEventListener('click', () => {
  $('w-receive-guard').style.display = 'none';
  $('w-receive-body').style.display = 'block';
});
$('w-receive-backup').addEventListener('click', () => {
  $('receive-modal').classList.remove('open');
  reenterBackupCeremony();
});

// Show seed phrase (net-modal): re-auth, then the same blur + decoy ceremony.
// After the tap, w-seed-words holds the REAL mnemonic as plain text.
function renderSeedGrid(revealed) {
  const words = wallet.mnemonic.trim().split(/\s+/);
  $('w-seed-words').innerHTML = wordGridHtml(revealed ? words : randomBip39Words(words.length));
  $('w-seed-reveal').classList.toggle('blurred', !revealed);
}
function hideSeed() {
  clearTimeout(seedHideTimer);
  $('w-seed').style.display = 'none';
  $('w-seed-words').innerHTML = ''; // never leave a seed in the DOM
  $('w-backup').textContent = 'Show seed phrase';
}
$('w-backup').addEventListener('click', async () => {
  if ($('w-seed').style.display !== 'none') return hideSeed();
  if (!(await requireReauth("Confirm your password to reveal this wallet's seed phrase."))) return;
  renderSeedGrid(false); // blurred decoys until the tap
  $('w-seed').style.display = 'block';
  $('w-backup').textContent = 'Hide seed phrase';
});
$('w-seed-show').addEventListener('click', () => { renderSeedGrid(true); armSeedHide(); });

// A revealed seed auto-hides after 60 s, and switching tabs hides it at once
// (spec §5): both grids — w-seed-words AND the backup ceremony's words — are
// wiped and re-blurred (fresh decoys), so a walked-away-from screen or a
// backgrounded tab never keeps a legible seed.
let seedHideTimer = null;
function armSeedHide() {
  clearTimeout(seedHideTimer);
  seedHideTimer = setTimeout(wipeRevealedSeeds, 60_000);
}
function wipeRevealedSeeds() {
  clearTimeout(seedHideTimer);
  if ($('w-seed').style.display !== 'none') hideSeed();
  if (connectMode === 'backup' && ceremony) renderBackupGrid(false); // decoys + blur back on
}
document.addEventListener('visibilitychange', () => { if (document.hidden) wipeRevealedSeeds(); });

// ---- Wallet switcher (spec §7) ----
// Names + backup flags come from the CLEARTEXT vault meta; the address is
// derived lazily and only for the ACTIVE wallet — deriving every wallet's
// would drag every mnemonic through seed derivation just for a list row.
let managingId = null; // wallet id with the manage row (rename/remove) expanded
let removingId = null; // wallet id the remove ceremony is aimed at

function openWalletModal(note) {
  managingId = null;
  $('w-wallet-note').textContent = note ?? '';
  $('w-wallet-note').style.display = note ? 'block' : 'none';
  $('w-wallet-err').textContent = '';
  showRemoveView(null);
  renderWalletList();
  $('wallet-modal').classList.add('open');
}
function closeWalletModal() {
  $('wallet-modal').classList.remove('open');
}

/** Open the switcher straight into the remove ceremony for one wallet — the
 * handover flow's "remove from this device" lands here (FR-7). */
function openWalletModalRemove(id) {
  openWalletModal();
  showRemoveView(id);
}

function renderWalletList() {
  const m = vault.meta();
  if (!m) { $('w-wallet-list').innerHTML = ''; return; } // vault gone — modal is closing anyway
  $('w-wallet-list').innerHTML = m.wallets.map((w) => {
    const active = w.id === m.activeId;
    const dot = w.backedUp ? '' : ' <span class="wal-dot" title="Not backed up"></span>';
    const sub = active ? `<div class="wal-sub mono">${esc($('w-chip-addr').textContent)}</div>` : '';
    return `<div class="wal-row">` +
      `<button type="button" class="wal-pick" data-switch="${esc(w.id)}">` +
      `<span><span class="wal-name">${esc(w.name)}</span>${dot}${sub}</span>` +
      (active ? '<span class="wal-check">✓</span>' : '') +
      `</button>` +
      `<button type="button" class="wal-manage secondary" data-manage="${esc(w.id)}" title="Rename or remove">⋯</button>` +
      `</div>` +
      (managingId === w.id ? walletEditHtml(w) : '');
  }).join('');
}

function walletEditHtml(w) {
  return `<div class="wal-edit">` +
    `<input id="w-rename-input" autocomplete="off" value="${esc(w.name)}" />` +
    `<div class="grid">` +
    `<button type="button" id="w-rename-go" class="secondary" data-rename="${esc(w.id)}">Rename</button>` +
    `<button type="button" id="w-remove-open" class="danger" data-remove="${esc(w.id)}">Remove…</button>` +
    `</div>` +
    // deliberately SECONDARY messaging (§4): the file is a convenience copy
    `<button type="button" id="w-export-go" class="secondary" data-export="${esc(w.id)}">Export backup file</button>` +
    `<p class="hint" style="margin:6px 0 0">An encrypted copy of this wallet. It only opens with your password — it is NOT a replacement for the seed phrase.</p>` +
    `</div>`;
}

// Hand the envelope to the browser as a download (Blob URL, §4 filename).
// Revoke on a timeout — revoking synchronously can abort the save.
function downloadKeystoreFile(envelope) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = keystore.keystoreFileName(envelope.name, new Date(envelope.exportedAt));
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('w-wallet-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-switch],[data-manage],[data-rename],[data-export],[data-remove]');
  if (!btn) return;
  $('w-wallet-err').textContent = '';
  try {
    if (btn.dataset.switch) {
      if (btn.dataset.switch === wallet.id) return closeWalletModal(); // already open
      await vault.setActive(btn.dataset.switch); // persisted so unlock reopens it
      switchToWallet(btn.dataset.switch); // the full state reset closes this modal
    } else if (btn.dataset.manage) {
      managingId = managingId === btn.dataset.manage ? null : btn.dataset.manage;
      renderWalletList();
    } else if (btn.dataset.rename) {
      await vault.renameWallet(btn.dataset.rename, $('w-rename-input').value); // duplicate guard inside
      treasuryHooks.onWalletRenamed(btn.dataset.rename, $('w-rename-input').value); // treasury cards follow the new name
      managingId = null;
      renderWalletList();
    } else if (btn.dataset.export) {
      // export requires typing the password (§4/§5) — it re-proves the user
      // can open what they save, and the file's fresh KDF runs on that string
      const pass = await requireReauth('Confirm your password to export an encrypted copy of this wallet.');
      if (!pass) return;
      const w = vault.meta().wallets.find((x) => x.id === btn.dataset.export);
      downloadKeystoreFile(await keystore.buildKeystoreFile({
        name: w.name,
        network: chainState.netKnown ? chainState.netName : null,
        mnemonic: vault.getMnemonic(w.id), // export does NOT set backedUp (§4)
        password: pass,
      }));
      managingId = null;
      openWalletModal(`Saved ${keystore.keystoreFileName(w.name)} — it only opens with your password.`);
    } else if (btn.dataset.remove) {
      showRemoveView(btn.dataset.remove);
    }
  } catch (err) {
    $('w-wallet-err').textContent = surfaceError(err); // duplicate name, tab conflict, …
  }
});

// Add wallet: the connect modal in choice mode while the app stays OPEN —
// password fields stay hidden (the vault exists), create/restore/import ride
// the unlocked session key (§2 modal-mode decoupling).
$('w-add-wallet').addEventListener('click', () => {
  closeWalletModal();
  openConnectModal();
});

/** Swap the switcher between its list and the remove ceremony (id=null → list). */
function showRemoveView(id) {
  removingId = id;
  $('w-wallet-main').style.display = id ? 'none' : 'block';
  $('w-remove-view').style.display = id ? 'block' : 'none';
  if (!id) return;
  const m = vault.meta();
  const w = m.wallets.find((x) => x.id === id);
  $('w-remove-target').textContent = w.name;
  // the balance is only known for the ACTIVE wallet — that's the one the
  // indexer poll watches; anything else is honestly "not checked"
  const held = [];
  if (id === m.activeId && lastConfirmedDgb != null) {
    if (lastConfirmedDgb > 0) held.push(`${fmtDGB(lastConfirmedDgb)} DGB`);
    if (lastDdUsd > 0) held.push(`${fmtUSD(lastDdUsd)} DigiDollar`);
    if (openPositions.size > 0) held.push(`${openPositions.size} locked position${openPositions.size === 1 ? '' : 's'}`);
  }
  const lines = [];
  if (held.length) lines.push(`This wallet holds ${held.join(', ')}.`);
  else if (id === m.activeId) {
    lines.push(lastConfirmedDgb != null
      ? 'This wallet holds no funds the indexer can see.'
      : 'Its balance could not be checked.'); // no indexer on this deployment
  } else lines.push('Its balance was not checked — only the active wallet is watched.');
  lines.push(w.backedUp
    ? 'You verified its seed phrase backup — that phrase can restore it later.'
    : 'This wallet is NOT backed up — removing it without the seed phrase means the funds are unrecoverable.');
  if (m.wallets.length === 1) lines.push('It is the last wallet on this device: removing it erases the vault entirely.');
  $('w-remove-warnings').innerHTML = lines.map((l) => `<li>${esc(l)}</li>`).join('');
  $('w-remove-name').value = '';
  $('w-remove-go').disabled = true;
  $('w-remove-err').textContent = '';
}

// the confirm button arms only on an exact (trimmed) name match
$('w-remove-name').addEventListener('input', () => {
  const w = vault.meta()?.wallets.find((x) => x.id === removingId);
  $('w-remove-go').disabled = !w || $('w-remove-name').value.trim() !== w.name;
});
$('w-remove-name').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('w-remove-go').disabled) $('w-remove-go').click(); });
$('w-remove-cancel').addEventListener('click', () => showRemoveView(null));

$('w-remove-go').addEventListener('click', (e) =>
  busy(e.target, 'w-remove-err', async () => {
    const id = removingId;
    await vault.removeWallet(id); // last wallet → deletes the vault record (§5)
    treasuryHooks.onWalletRemoved(id); // a removed TREASURY becomes "transferred out" in the registry
    showRemoveView(null);
    if (vault.status === 'none') {
      // nothing left on this device — back to the guest hero
      wallet.id = null; wallet.mnemonic = null; wallet.seed = null;
      clearVaultTombstone(); // deliberate removal — no tombstone ghost
      resetWalletState();
      show('none');
    } else if (id === wallet.id) {
      // removed the wallet being viewed: the vault handed active to the
      // adjacent one; re-run the switch path so the open view never keeps
      // showing a removed wallet (§5)
      switchToWallet(vault.meta().activeId);
    } else {
      renderWalletList(); // stay in the list, minus one row
    }
  }));

// ---- Balance & history (#5): every query goes through the indexer seam ----
const fmtSats = (sats) => fmtDGB(Number(sats) / 1e8);

// ---- Bulk indexer reads ----
// One POST answers a whole watch set (utxos+history, plus positions+dd-utxos
// for DD addresses) instead of 2-4 GETs PER ADDRESS: a multi-chain login went
// from hundreds of round trips — each able to catch an indexer stall — to a
// handful. Falls back to the per-address GETs when the deployment's indexer
// pre-dates the endpoint (404/405), e.g. a peer wallet's public surface.
const BULK_CHUNK = 200; // the indexer's per-request address cap
let bulkIndexer = true; // optimistic until the endpoint says it doesn't exist

async function fetchBulk(addresses, want) {
  const merged = { tipHeight: 0, results: {} };
  for (let at = 0; at < addresses.length; at += BULK_CHUNK) {
    const chunk = addresses.slice(at, at + BULK_CHUNK);
    // Same restart-outlasting ladder as fetchIndexer: bulk is the PRIMARY
    // transport, and without retries a login racing a deploy died on the
    // very first read (report 2026-07-28). Reads are idempotent — safe to
    // repeat on network failure.
    const BULK_RETRY_MS = [500, 1_000, 2_000, 3_000];
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch('/api/indexer/addresses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ addresses: chunk, want }),
          signal: AbortSignal.timeout(45_000),
        });
        if (res.status >= 500) throw new Error(`the balance index answered with HTTP ${res.status}`);
        break;
      } catch (err) {
        if (attempt >= BULK_RETRY_MS.length) {
          throw err instanceof TypeError || err.name === 'TimeoutError'
            ? new Error(friendlyNetError(err, 'the balance index')) : err;
        }
        await new Promise((r) => setTimeout(r, BULK_RETRY_MS[attempt]));
      }
    }
    if (res.status === 404 || res.status === 405) { bulkIndexer = false; return null; }
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`the balance index returned an unreadable response (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(json.error || `the balance index answered with HTTP ${res.status}`);
    merged.tipHeight = Math.max(merged.tipHeight, Number(json.tipHeight) || 0);
    Object.assign(merged.results, json.results ?? {});
  }
  return merged;
}

/** The per-address records refreshMoney consumes, in addrs order — bulk when
 * the indexer supports it, the per-address GET path otherwise. Every field
 * passes the SAME validators as the GET path: the trust boundary (audit H2)
 * does not move because the transport got faster. */
async function fetchAddrRecords(addrs) {
  if (bulkIndexer) {
    const ddAddrs = addrs.filter((x) => x.dd).map((x) => x.address);
    const plainAddrs = addrs.filter((x) => !x.dd).map((x) => x.address);
    const [ddJson, plainJson] = await Promise.all([
      ddAddrs.length ? fetchBulk(ddAddrs, ['utxos', 'history', 'positions', 'dd-utxos']) : { tipHeight: 0, results: {} },
      plainAddrs.length ? fetchBulk(plainAddrs, ['utxos', 'history']) : { tipHeight: 0, results: {} },
    ]);
    if (ddJson && plainJson) {
      const tipHeight = Math.max(ddJson.tipHeight, plainJson.tipHeight);
      // recordFromBulkEntry enforces complete-or-absent (F3): an incomplete
      // scan substitutes the last good record — never an empty money field.
      return addrs.map(({ address: a, dd }) => recordFromBulkEntry({
        entry: (dd ? ddJson : plainJson).results?.[a],
        address: a,
        dd,
        tipHeight,
        cache: lastGoodRecords,
      }));
    }
    // fell through: endpoint unsupported — bulkIndexer is now false
  }
  return mapLimited(addrs, async ({ address: a, dd }) => ({
    utxos: (await fetchIndexer(`/address/${a}/utxos`)).utxos,
    history: (await fetchIndexer(`/address/${a}/history`)).history,
    positions: dd ? await fetchIndexer(`/address/${a}/positions`) : { address: a, positions: [], tipHeight: 0 },
    ddCents: dd ? BigInt((await fetchIndexer(`/address/${a}/dd-utxos`)).totalCents) : 0n,
  }));
}

async function fetchIndexer(path) {
  // One slow or dropped read must not paint "the balance index is
  // unreachable" over a healthy wallet: an index under load (or a phone
  // switching networks) blips, and the honest answer is to ask again.
  // Two quick retries, then the error stands — a real outage still shows.
  let json;
  // The ladder must OUTLAST a deploy: a service restart takes ~2-3s, and the
  // old 3 tries × 400ms all fell inside that window — a login racing a deploy
  // tore down to "the balance index is unreachable" (report 2026-07-28).
  // Five attempts spanning ~6.5s ride out a restart; a real outage still
  // surfaces, just seconds later.
  const INDEXER_RETRY_MS = [500, 1_000, 2_000, 3_000];
  for (let attempt = 0; ; attempt++) {
    try {
      json = await fetchJson('/api/indexer' + path, {}, 45_000, 'the balance index');
      break;
    } catch (e) {
      if (attempt >= INDEXER_RETRY_MS.length) throw e;
      await new Promise((r) => setTimeout(r, INDEXER_RETRY_MS[attempt]));
    }
  }
  // Trust boundary (audit H2): INDEXER_URL may be a third-party service, and
  // transactions are BUILT from this JSON. Signing inputs (utxos / dd-utxos /
  // positions) are strict — one malformed entry refuses the whole answer
  // rather than let poisoned data near a signature; display data (history,
  // tx detail) tolerates and drops bad entries.
  const strict = (v) => {
    // F3: an incomplete-scan marker is "unknown, retry" — never undefined
    // data walked into the signing path. Fail closed with a retryable error.
    if (v && v.complete === false) {
      const e = new Error('the balance index is busy — still scanning; retry in a few seconds');
      e.retryable = true;
      throw e;
    }
    return v;
  };
  if (path.endsWith('/dd-utxos')) return strict(validateDdUtxos(json)); // before /utxos — it is a suffix of it
  if (path.endsWith('/utxos')) return strict(validateUtxos(json));
  if (path.endsWith('/positions')) return strict(validatePositions(json));
  if (path.endsWith('/history')) return validateHistory(json);
  if (path.startsWith('/tx/')) return validateTxDetail(json);
  return json;
}

/** Every derivation the wallet watches: indices up to the current one, +2 lookahead. */
// ---- Extra-chain refresh policy ----
// The primary chain polls fast (money the user is actively moving). The EXTRA
// chains of an imported Core wallet (its segwit and change chains) only change
// when the blockchain does, so re-reading them every 8s is pure waste: they
// refresh when a block arrives (server push), right after our own broadcast,
// on wallet open, and as a slow safety net. A late payment to an old Core
// address therefore still appears within one block — never silently missed.
let extraChainsDue = true;         // first poll after open always includes them
let extraPerAddr = [];             // last answer for the extra chains (reused between blocks)
let extraAddrMeta = [];            // …and the address metadata that pairs with it
// F3: the indexer can answer an address with { complete: false, reason } when
// a scan blows its abuse budget — that is "unknown", NEVER "empty". The
// display then keeps this address's last fully-assembled record (balance,
// history, positions all stay on screen) and the next poll retries. Signing
// paths do NOT use this cache: a spend built on a stale utxo set is a
// guaranteed node rejection, so they fail closed with a retryable error.
const lastGoodRecords = new Map(); // address → last complete { utxos, history, positions, ddCents }
let lastExtraScanAt = 0;
const EXTRA_CHAIN_MAX_AGE_MS = 120_000; // belt-and-braces if push is unavailable
const markExtraChainsDue = () => { extraChainsDue = true; };
document.addEventListener('dgb:block', markExtraChainsDue);
function extraChainsWanted() {
  return extraChainsDue || (Date.now() - lastExtraScanAt) > EXTRA_CHAIN_MAX_AGE_MS;
}

// Bounded-concurrency map for indexer reads. A multi-chain Core import watches
// several times more addresses than a seeded wallet, and firing every lookup at
// once (plain Promise.all) buried the indexer at login: ~200 simultaneous
// requests, none answering inside the timeout, surfacing as "the balance index
// is unreachable or still syncing" on a perfectly healthy stack. Six at a time
// keeps the pipe full without stampeding it.
const INDEXER_CONCURRENCY = 6;
async function mapLimited(items, fn, limit = INDEXER_CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}

function watchedDerivations() {
  return Array.from({ length: wallet.index + 3 }, (_, i) =>
    deriveTaprootAddress(wallet.seed, { ...wallet.network, index: i }));
}

// Derivations from the wallet's EXTRA descriptor sources (Core's other chains
// and address types). They never appear as receive addresses — the receive
// screen stays on the primary taproot chain — but their coins are part of this
// wallet's money, so balance, history and spending must include them.
// Watch exactly the indices that have EVER been used on each chain, plus a
// lookahead past the deepest one (where the next payment can land). A Core
// wallet whose deepest used index is 60 but which only touched 12 addresses
// then costs 12 + lookahead reads a poll instead of 60 — and nothing that ever
// held coins is ever dropped from the watch set.
function extraWatchIndices(s) {
  const used = extraChainUsed[s] ?? [];
  const deepest = used.length ? Math.max(...used) : -1;
  const ahead = Array.from({ length: EXTRA_LOOKAHEAD }, (_, k) => deepest + 1 + k);
  const all = new Set([...used, ...ahead]);
  for (let i = 0; i < EXTRA_SOURCE_DEPTH; i++) all.add(i); // a fresh chain still gets a floor
  return [...all].sort((a, b) => a - b);
}
function extraDerivations() {
  if (!wallet.extraSources?.length) return [];
  return wallet.extraSources.flatMap((src, s) =>
    // carry which chain and index each came from, so a used FRONTIER address
    // can extend the window without re-walking every chain from zero
    extraWatchIndices(s).map((i) => ({ ...deriveTaprootAddress(src, { ...wallet.network, index: i }), srcIndex: s, chainIndex: i })));
}
const EXTRA_SOURCE_DEPTH = 5;   // starting depth per extra chain, before discovery
const EXTRA_LOOKAHEAD = 5;      // …plus this much room past the deepest USED address
let extraChainUsed = [];        // per extra chain: the indices that have ever had history

// Gap-limit discovery for the EXTRA chains, mirroring syncReceiveIndex on the
// primary one. An imported Core wallet has history: Core hands out its NEXT
// unused address (commonly segwit), which can sit far past a fixed window — a
// real payment landed outside it and simply never appeared (report 2026-07-27).
// Money that is invisible is the worst bug this wallet can have, so each extra
// chain is walked until RECEIVE_GAP consecutive unused addresses, then watched
// to the deepest used index plus lookahead.
// Discovered depths are CACHED per wallet: the gap-limit walk costs hundreds of
// index reads, and ElectrumX pauses ~1s on roughly one read in seven (its own
// periodic mempool refresh — measured: median 1ms, p95 996ms), so re-walking
// every login is what made a 4-chain wallet take a minute and a half to open.
// The cached depths paint immediately; the walk then re-runs in the background
// to pick up any newly used address, and only widens the window.
const DEPTHS_KEY = 'diginaut.chainUsed.v3'; // v3: entries carry a descriptor-set fingerprint
// v2 entries (bare used-index arrays) are IGNORED, not migrated. The cache is
// keyed by wallet.id, which is a device-local epoch (`w<Date.now>`) — a
// remove + same-millisecond reimport, or a clock rollback, can hand a
// DIFFERENT wallet the same id, and trusting the old entry would load that
// wallet's used indices and skip discovery of this one's (money invisibility).
// The v3 fingerprint check rejects exactly that; a stale v2 blob simply costs
// one cold walk at the next login.
function loadCachedDepths(id) {
  try { return JSON.parse(localStorage.getItem(DEPTHS_KEY) || '{}')[id] ?? null; } catch { return null; }
}
function saveCachedDepths(id, fp, depths) {
  try {
    const all = JSON.parse(localStorage.getItem(DEPTHS_KEY) || '{}');
    all[id] = { fp, used: depths };
    localStorage.setItem(DEPTHS_KEY, JSON.stringify(all));
  } catch { /* private mode: discovery just runs again next login */ }
}

let extraScanGen = null;    // the wallet generation whose chains have been walked
let extraScanBusy = null;   // …and the one being walked right now
let extraScanFailGen = null; // walletGen the failure count below belongs to
let extraScanFails = 0;
async function syncExtraChainDepths() {
  if (!wallet.extraSources?.length || !appConfig.indexer || !chainState.netKnown) return;
  const gen = walletGen;
  // ONCE per opened wallet, like syncReceiveIndex. loadStatus calls this on
  // every status poll, and without the guard each poll re-walked the gap
  // window on every chain — a warm login cost MORE reads than a cold one
  // (951 vs 508, measured). Between walks, a new address becoming used is
  // picked up by the watch window's lookahead (frontier check in refreshMoney).
  if (extraScanGen === gen || extraScanBusy === gen) return;
  if (extraScanFailGen !== gen) { extraScanFailGen = gen; extraScanFails = 0; }
  extraScanBusy = gen;
  const walletId = wallet.id;
  const fp = extraSourcesFingerprint(wallet.extraSources);
  // Paint from cache first — the wallet is usable immediately while the walk
  // re-checks. The cache is ADDRESS-LEVEL: which indices on each chain have
  // ever had history. Those addresses stay watched forever (their coins are
  // ours); everything else on the chain is untouched, so discovery only has
  // to probe FORWARD of the deepest known one instead of restarting at zero.
  // The fingerprint must match the CURRENT extraSources: the cache is keyed by
  // wallet.id, a device-local epoch that a remove + same-ms reimport (or a
  // clock rollback) can collide with — a mismatched entry is another wallet's
  // answer and is ignored, forcing a full walk from zero.
  const cached = loadCachedDepths(walletId);
  if (cached?.fp === fp && cached.used?.length === wallet.extraSources.length && !extraChainUsed.length) {
    extraChainUsed = cached.used.map((c) => (Array.isArray(c) ? c : []));
    markExtraChainsDue(); // notices new activity (frontier check in refreshMoney)
    refreshMoney();
    // NO early return, and extraScanGen is NOT set yet: a warm start still
    // walks forward in the background. The walk is cheap from here — it starts
    // one past each chain's deepest known-used index — but it must RUN: a
    // payment received while the wallet was closed, further down a chain than
    // the lookahead reaches, is otherwise invisible forever (the gap-limit
    // walk would never run again for this wallet). The cached window already
    // painted; a completed walk only widens it.
  }
  const found = [];
  try {
    for (const [s, src] of wallet.extraSources.entries()) {
      setSyncStatus(s + 2, src.kind === 'wpkh' ? 'segwit' : 'taproot'); // chains 2…N
      const known = new Set(extraChainUsed[s] ?? []);
      let highest = known.size ? Math.max(...known) : -1;
      // start one past the deepest known-used index: everything below it is
      // already accounted for, and re-reading it is what cost a minute a login
      const start = highest + 1;
      for (let from = start, gap = 0; gap < RECEIVE_GAP; from += RECEIVE_SCAN_BATCH) {
        const batch = Array.from({ length: RECEIVE_SCAN_BATCH }, (_, k) => from + k);
        // No .catch(() => false) here: a failed read is not an unused address.
        // Swallowing an indexer error into `false` truncated discovery at the
        // outage point and then PERSISTED the truncation to the cache — the
        // walk must abort instead and retry whole.
        const used = await derivationsUsed(batch.map((i) =>
          deriveTaprootAddress(src, { ...wallet.network, index: i })));
        if (!wallet.seed || walletGen !== gen) return;
        used.forEach((u, k) => { if (u) { known.add(batch[k]); highest = Math.max(highest, batch[k]); } });
        gap = from + RECEIVE_SCAN_BATCH - 1 - highest;
      }
      found.push([...known].sort((a, b) => a - b));
    }
  } catch (e) {
    // Retry with backoff like syncReceiveIndex: a hiccup must not end
    // discovery for the session. The cache is only written after a FULLY
    // successful walk below, so nothing half-read is ever persisted — the
    // next attempt re-walks from the same frontier.
    extraScanBusy = null;
    const wait = RECEIVE_RETRY_MS[Math.min(extraScanFails, RECEIVE_RETRY_MS.length - 1)];
    extraScanFails += 1;
    console.warn(`extra-chain scan failed (attempt ${extraScanFails}), retrying in ${wait}ms:`, e.message);
    setTimeout(() => { if (walletGen === gen) syncExtraChainDepths(); }, wait);
    return;
  }
  if (!wallet.seed || walletGen !== gen) { extraScanBusy = null; return; }
  extraScanGen = gen; extraScanBusy = null; // walked once for this opened wallet
  // union, never a narrowing: a cache may only gain indices
  extraChainUsed = found.map((list, i) => [...new Set([...(extraChainUsed[i] ?? []), ...list])].sort((a, b) => a - b));
  saveCachedDepths(walletId, fp, extraChainUsed);
  markExtraChainsDue(); // the newly-visible addresses must be read on the next poll
  refreshMoney();
}

// ---- Mis-gifted ("stranded") positions ----
// A gift built by the old address-key flow named this wallet's ADDRESS key Q
// as the position owner instead of its internal key P. Such a position is
// valid and ours, but every ordinary scan looks for owner == P, so nothing
// shows it — the incident class documented in docs/stranded-gift-recovery.md. We look in the
// one place they can be: positions owned by Q, which live at tweak(Q).
// Read-only surfacing: signing needs the once-tweaked key, which
// scripts/recover-stranded-gift.mjs holds (deliberately outside the browser).
let strandedPositions = [];
const STRANDED_SCAN_MIN = 10;   // a gift can land on any handed-out address, not just the live window
const STRANDED_SCAN_STEP = 25;  // one "look deeper" tap
const STRANDED_SCAN_MAX = 200;  // ceiling: 200 indexed reads is already a big ask
let strandedDepth = STRANDED_SCAN_MIN;
let strandedScanning = false;
let strandedScanGen = -1;   // walletGen whose auto scan already ran (see receiveScanGen)
async function scanStrandedGifts() {
  if (!wallet.seed || !appConfig.indexer || !chainState.netKnown || strandedScanning) return;
  const gen = walletGen;
  const depth = Math.max(strandedDepth, wallet.index + 3);
  // ONCE per open, like syncReceiveIndex/syncExtraChainDepths: loadStatus calls
  // this on every 60s status poll, and a full pass is `depth` SEQUENTIAL
  // /positions reads — each O(address history) server-side — making it the
  // heaviest steady-state Electrum load in the app. Re-running is reserved for
  // when there is something new to look at: a freshly opened wallet (the
  // generation bumps) or a deeper requested depth (the manual "check more
  // addresses" tap grows strandedDepth first). An unchanged depth on the same
  // generation is a poll re-entry and must be a no-op.
  if (strandedScanGen === gen && strandedScannedTo >= depth) return;
  strandedScanning = true;
  renderStranded();
  const found = [];
  try {
    for (let i = 0; i < depth; i++) {
      const d = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: i });
      const addr = encodeWitnessAddress(wallet.network.hrp, 1, ddTokenOutputKey(d.outputKeyHex));
      try {
        const { positions, tipHeight } = await fetchIndexer(`/address/${addr}/positions`);
        for (const p of positions) found.push({ ...p, strandedAddr: addr, ownerIndex: i, tipHeight });
      } catch { /* a blip here must never disturb the dashboard */ }
      if (!wallet.seed || walletGen !== gen) return; // switched/locked mid-scan
    }
    strandedPositions = found;
    strandedScannedTo = depth;
    strandedScanGen = gen; // completed: polls for this wallet stop re-running it
  } finally {
    strandedScanning = false;
    if (wallet.seed && walletGen === gen) renderStranded();
  }
}
let strandedScannedTo = 0;
function renderStranded() {
  const box = $('w-stranded');
  // The deeper-sweep control stays available even with nothing found — a gift
  // may sit on an address far past the live window, and the user is the only
  // one who knows they are expecting one.
  const more = strandedScanning
    ? '<div class="hint" style="margin-top:8px">Checking addresses for mis-gifted positions…</div>'
    : strandedScannedTo >= STRANDED_SCAN_MAX
      ? `<div class="hint" style="margin-top:8px">Checked the first ${STRANDED_SCAN_MAX} addresses — that is as deep as this scan goes.</div>`
      : `<button id="w-stranded-more" class="textlink" type="button">Expecting a gifted treasury you cannot see? Check ${STRANDED_SCAN_STEP} more addresses (checked ${strandedScannedTo} so far)</button>`;
  if (!strandedPositions.length) {
    box.style.display = strandedScannedTo ? 'block' : 'none';
    box.innerHTML = more;
    return;
  }
  box.style.display = 'block';
  box.innerHTML = more + '<div class="hint warn-text" style="margin-top:10px"><strong>Mis-gifted position'
    + (strandedPositions.length > 1 ? 's' : '') + ' found.</strong> These were minted to this wallet\'s '
    + 'address key by an early version of the gift flow, so ordinary wallet scans (here and in Core) cannot see them. '
    + 'The funds are yours and nothing expires — releasing them needs the tweaked key, via '
    + '<span class="mono">scripts/recover-stranded-gift.mjs</span>.</div>'
    + strandedPositions.map((p) => {
      const blocksLeft = p.unlockHeight - (p.tipHeight || 0);
      const when = blocksLeft > 0
        ? `unlocks ≈ ${new Date(Date.now() + blocksLeft * SECONDS_PER_BLOCK * 1000).toLocaleDateString('en-CA')} (block ${p.unlockHeight.toLocaleString('en-US')})`
        : 'MATURE — redeemable now';
      return `<div class="hint" style="margin-top:4px">${fmtUSD(Number(p.ddCents) / 100)} · `
        + `locked ${fmtSats(BigInt(p.collateralSats))} DGB · ${esc(when)}<br>`
        + `<span class="mono" style="font-size:11px">position ${esc(p.txid)}</span><br>`
        + `<span class="mono" style="font-size:11px">at ${esc(p.strandedAddr)}</span></div>`;
    }).join('');
}
// delegated: the control is re-rendered on every scan, so it cannot hold a listener
$('w-stranded').addEventListener('click', (e) => {
  if (e.target.id !== 'w-stranded-more') return;
  strandedDepth = Math.min(strandedScannedTo + STRANDED_SCAN_STEP, STRANDED_SCAN_MAX);
  scanStrandedGifts();
});

// DigiDollar positions (#13): locked mints are NOT part of the DGB balance —
// they render as their own list ($ amount, tier, collateral, expiry date).
const SECONDS_PER_BLOCK = 15;
let openPositions = new Map(); // txid → { position, address } — feeds the redeem flow

// Activity list state (#69): the merged per-address history plus a client-side
// cache of each tx's enrichment. Non-final txs are re-fetched each poll (their
// confirmation count still climbs); a tx is cached for good only once final.
const FINAL_CONF = 6;            // Android parity: 6+ confirmations = final
let allHistory = [];             // merged {txid, height}, newest-first
let historyLimit = 8;            // "Show more" bumps this by 8
const txDetailCache = new Map(); // txid → /api/tx enrichment
let myAddrSet = new Set();       // lowercased wallet addresses (P2TR + P2WPKH twin)
// history amounts/fees want sat-level precision — fmtDGB caps at 2 decimals and
// would swallow a fee to "0". Trim to significant digits instead.
const fmtDgb8 = (sats) => (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });
function renderPositions(perAddr) {
  const seen = new Set();
  const positions = perAddr.flatMap((r) => r.positions.positions.map((p) => ({ ...p, address: r.positions.address })))
    .filter((p) => (seen.has(p.txid) ? false : seen.add(p.txid)));
  openPositions = new Map(positions.map((p) => [p.txid, p]));
  const tipHeight = Math.max(0, ...perAddr.map((r) => r.positions.tipHeight));
  const totalCents = positions.reduce((n, p) => n + Number(p.ddCents), 0);
  $('w-dd-total').textContent = positions.length ? fmtUSD(totalCents / 100) : '';
  if (!positions.length) {
    $('w-positions').textContent = 'No open positions.';
    return;
  }
  $('w-positions').innerHTML = positions.map((p) => {
    const blocksLeft = p.unlockHeight - tipHeight;
    // AC (#16): a still-locked position says exactly when it opens instead of
    // offering a redeem that consensus (CLTV) would reject.
    const state = blocksLeft > 0
      ? `<span class="warn-text">locked until ≈ ${new Date(Date.now() + blocksLeft * SECONDS_PER_BLOCK * 1000).toLocaleDateString('en-CA')} (block ${p.unlockHeight.toLocaleString('en-US')})</span>`
      : `<button class="secondary" data-redeem="${esc(p.txid)}" style="width:auto;padding:1px 10px;margin:0">Redeem</button>`;
    return `<div>${fmtUSD(Number(p.ddCents) / 100)} · ${esc(p.tierLabel)} · ` +
      `locked ${fmtSats(BigInt(p.collateralSats))} DGB · ${state}</div>`;
  }).join('');
}

async function refreshMoney() {
  // netKnown gate: querying the indexer with addresses derived for a GUESSED
  // network would render a confident zero balance — wait for the real chain
  // (the 8s poll picks up automatically once loadStatus succeeds).
  if (!wallet.seed || !appConfig.indexer || !chainState.netKnown) return;
  // Which wallet this poll belongs to. clearInterval on switch stops FUTURE
  // ticks; it cannot cancel one already in flight, and the seed check below is
  // not enough on its own — a switch REPLACES wallet.seed rather than nulling
  // it, so the outgoing poll sails through and paints the previous wallet's
  // balance, history and positions onto the wallet now on screen.
  const gen = walletGen;
  try {
    // Each derivation is watched at TWO addresses: its P2TR (receive address,
    // carries DD positions/tokens) and its P2WPKH twin — mint change lands
    // there by consensus (#38), so it must count toward balance and history.
    // DD lives on P2TR only; the twin contributes plain DGB.
    const primaryAddrs = watchedDerivations().flatMap((d, index) => [
      { address: d.address, dd: true, index },
      { address: d.p2wpkhAddress, dd: false, index },
    ]);
    // extra descriptor sources (Core's other chains/address types): their
    // coins are this wallet's money, but they are never receive slots —
    // index -1 keeps them out of the receive screen's address list. Re-read
    // only when the chain moved (or we just spent); otherwise the previous
    // answer is reused, so the balance never dips while they are skipped.
    const includeExtras = extraChainsWanted();
    const extraAddrs = includeExtras
      ? extraDerivations().flatMap((d) => [
        { address: d.address, dd: true, index: -1, src: d.srcIndex, idx: d.chainIndex },
        { address: d.p2wpkhAddress, dd: false, index: -1, src: d.srcIndex, idx: d.chainIndex },
      ])
      : [];
    const addrs = [...primaryAddrs, ...extraAddrs];
    const fetched = await fetchAddrRecords(addrs);
    // locked (seed nulled, generation unchanged) or switched (generation bumped)
    // while we were fetching — either way this answer is not about the wallet
    // the user is looking at
    if (!wallet.seed || walletGen !== gen) return;
    // Splice the extra chains back in: freshly read this cycle, or the cached
    // answer from the last block. Skipping a read must never look like the
    // money left — the totals below see the same set either way.
    if (includeExtras) {
      extraPerAddr = fetched.slice(primaryAddrs.length);
      extraAddrMeta = extraAddrs;
      extraChainsDue = false;
      lastExtraScanAt = Date.now();
    }
    const perAddr = includeExtras ? fetched : [...fetched, ...extraPerAddr];
    const addrMeta = includeExtras ? addrs : [...primaryAddrs, ...extraAddrMeta];
    // Which derivations have actually seen money — for the receive view's
    // address list. Both forms of an index count as that index: a payer who
    // used the compat twin paid the same address as far as the user is
    // concerned. History, not UTXOs: a spent-clean address was still used.
    // Frontier check: an extra chain's window is "used indices + lookahead".
    // If one of those lookahead addresses now has history, the chain grew —
    // record it and let the next walk extend from there. This is what makes a
    // warm login cheap: no chain is re-walked unless its frontier moved.
    let frontierMoved = false;
    perAddr.forEach((r, i) => {
      const m = addrMeta[i];
      if (m.index >= 0 || m.src == null || !r.history.length) return;
      const used = extraChainUsed[m.src] ?? [];
      if (!used.includes(m.idx)) {
        extraChainUsed[m.src] = [...used, m.idx].sort((a, b) => a - b);
        frontierMoved = true;
      }
    });
    if (frontierMoved) {
      saveCachedDepths(wallet.id, extraSourcesFingerprint(wallet.extraSources), extraChainUsed);
      extraScanGen = null;      // let discovery walk again, now from the new frontier
      markExtraChainsDue();
      syncExtraChainDepths();
    }

    addressUse = new Map();
    perAddr.forEach((r, i) => {
      const { index } = addrMeta[i];
      if (index < 0) return; // extra-source address: real money, but not a receive slot
      const at = addressUse.get(index) ?? { used: false, sats: 0 };
      at.used = at.used || r.history.length > 0;
      at.sats += r.utxos.reduce((n, u) => n + Number(u.valueSats), 0);
      addressUse.set(index, at);
    });
    renderPrevAddresses(); // no-op unless the list is open
    // one coin, one entry: overlapping watched addresses (two descriptors that
    // resolve to the same chain, a twin counted twice) can surface the SAME
    // outpoint more than once. Deduping here keeps the balance honest — and
    // the SAME dedupe runs inside spendableUtxos, so a duplicated outpoint is
    // never selected twice into one transaction either.
    const utxos = dedupeUtxos(perAddr.flatMap((r) => r.utxos));
    const confirmed = utxos.filter((u) => u.height > 0).reduce((n, u) => n + Number(u.valueSats), 0);
    const pending = utxos.filter((u) => u.height === 0).reduce((n, u) => n + Number(u.valueSats), 0);
    $('w-balance').textContent = fmtDGB(confirmed / 1e8);
    $('as-dgb').textContent = fmtDGB(confirmed / 1e8);
    lastConfirmedDgb = confirmed / 1e8;
    renderFiat();
    $('w-pending-row').style.display = pending > 0 ? 'flex' : 'none';
    if (pending > 0) $('w-pending').textContent = fmtDGB(pending / 1e8);
    // Anything unconfirmed means the extra chains' CACHED answer may already be
    // out of date (their coin confirmed since the last full sweep), so keep
    // re-reading them until nothing is pending — otherwise a confirmed payment
    // on a Core chain can sit reading "pending" indefinitely.
    if (pending > 0) markExtraChainsDue();

    // Activity (#69): merge per-address history, then enrich the visible page
    // (direction, signed amount, fee, date, confirmations) via /api/tx/:txid.
    // Classification is wallet-side — only here is the full watched-address set
    // known, so a self-send between our own addresses nets correctly.
    // Built from addrMeta (the per-entry list aligned with perAddr), NOT from
    // this cycle's fetch list `addrs`: on cycles where the extra chains reuse
    // their cached answer, `addrs` holds only primary addresses, and receipts
    // on extra-chain Core addresses then classified as "not mine" — blank
    // received amounts and self-sends mislabeled "Sent" until the next block.
    myAddrSet = myAddressSet(addrMeta);
    const seen = new Set();
    allHistory = perAddr.flatMap((r) => r.history)
      .filter((h) => (seen.has(h.txid) ? false : seen.add(h.txid)))
      .sort((a, b) => (a.height === 0 ? Infinity : a.height) < (b.height === 0 ? Infinity : b.height) ? 1 : -1);
    renderHistory();
    enrichVisible();
    const ddCents = perAddr.reduce((s, r) => s + r.ddCents, 0n);
    lastDdUsd = Number(ddCents) / 100;
    $('w-dd-balance').textContent = lastDdUsd.toLocaleString('en-US', { minimumFractionDigits: 2 });
    // freshness at signing time (audit H5): the confirm screens compare this
    // tip against the node's height and warn when the index is behind
    lastIndexerTip = Math.max(0, ...perAddr.map((r) => r.positions.tipHeight));
    renderPositions(perAddr);
    renderBackupStrip(); // balance-gated (§3): fresh funds may summon the backup nag
    // a transient indexer hiccup shouldn't leave a stale error after recovery
    if ($('w-open-err').textContent.startsWith('indexer:')) $('w-open-err').textContent = '';
    const firstShow = $('w-money').style.display === 'none';
    $('loading-veil').style.display = 'none';
    $('w-money').style.display = 'grid';
    if (firstShow) renderSparkline(lastPriceSeries); // real width only now
  } catch (e) {
    // Same reasoning as the success path: the outgoing wallet's indexer error
    // is not the incoming wallet's, and tearing down the veil here would
    // uncover a panel the new wallet has not painted yet. Dropping this is
    // safe because the incoming wallet always has its own poll running
    // (openWallet → startMoneyPolling), which hides the veil on either outcome.
    if (walletGen !== gen) return;
    $('loading-veil').style.display = 'none';
    // transport-level failures mean the index isn't serving yet (e.g. initial
    // ElectrumX sync after a deployment) or the connection dropped — the poll
    // keeps retrying either way; say that, not ECONNREFUSED
    $('w-open-err').textContent = /ECONNREFUSED|ETIMEDOUT|unreachable|did not answer|socket|502|503/i.test(e.message)
      ? 'indexer: the balance index is unreachable or still syncing — balances and history appear once it answers (your on-chain funds are unaffected)'
      : 'indexer: ' + e.message;
  }
}

// ---- Activity rendering (#69) ----
const DD_LABEL = { mint: 'Minted DigiDollar', redeem: 'Redeemed DigiDollar', transfer: 'DigiDollar transfer' };
const truncAddr = (a) => (a ? a.slice(0, 10) + '…' + a.slice(-4) : '');
function relTime(unixSec) {
  if (!unixSec) return null;
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString('en-CA');
}

function txExplorerLink(txid) {
  const short = txid.slice(0, 12) + '…';
  return appConfig.explorerTxUrl && /^[0-9a-f]{64}$/.test(txid)
    ? `<a href="${appConfig.explorerTxUrl}${txid}" target="_blank" rel="noopener">${short}</a>`
    : `<span class="mono">${esc(short)}</span>`;
}

/** Full-txid copy button next to the truncated link — debugging needs all 64
 * chars, never a retype. The .icon-btn delegation (data-copy-text) handles the
 * click; renderHistory/renderPendingTx fills in COPY_ICON. */
const txCopyBtn = (txid) =>
  /^[0-9a-f]{64}$/.test(txid)
    ? `<button type="button" class="icon-btn" data-copy-text="${esc(txid)}" title="Copy full transaction id" aria-label="Copy full transaction id"></button>`
    : '';

/** One Activity row. Thin (txid + pending/confirmed) until enrichment arrives. */
function historyRow(h) {
  const link = txExplorerLink(h.txid);
  const detail = txDetailCache.get(h.txid);
  if (!detail) {
    const conf = h.height === 0
      ? '<span class="tx-conf pending">pending</span>'
      : '<span class="tx-conf partial">confirmed</span>';
    return `<div class="tx"><div class="tx-icon out">·</div>` +
      `<div class="tx-main"><div class="tx-title">Transaction</div><div class="tx-sub">${link}${txCopyBtn(h.txid)}</div></div>` +
      `<div class="tx-right">${conf}</div></div>`;
  }
  // The indexer is treated as untrusted (#55): parse only well-formed integers,
  // tolerate null/garbage array elements, and never interpolate a raw field.
  const sat = (x) => (typeof x === 'string' && /^\d+$/.test(x) ? BigInt(x) : 0n);
  const isMine = (a) => typeof a === 'string' && myAddrSet.has(a.toLowerCase());
  const vin = (Array.isArray(detail.vin) ? detail.vin : []).filter((v) => v && typeof v === 'object');
  const vout = (Array.isArray(detail.vout) ? detail.vout : []).filter((o) => o && typeof o === 'object');
  // Amounts use OUTPUT flow, not net-of-inputs: the indexer caps prevout
  // resolution (server.js MAX_VIN_RESOLVE), so Σ(my inputs) is unreliable for a
  // >40-input send/consolidation. What LEFT the wallet = Σ(outputs to others);
  // what ARRIVED = Σ(outputs to us). Both come from vout, which is never capped.
  // We only need inputs to answer "did we send?" — true for any wallet-built tx
  // since its own coins fund vin[0] (within the resolved window). Fee is shown
  // separately, so excluding it from the amount matches how wallets read.
  const toOthers = vout.filter((o) => o.address && !isMine(o.address)).reduce((s, o) => s + sat(o.valueSats), 0n);
  const toMine = vout.filter((o) => isMine(o.address)).reduce((s, o) => s + sat(o.valueSats), 0n);
  const sent = vin.some((v) => isMine(v.address)); // we funded at least one (resolved) input
  const coinbase = vin.length > 0 && vin.every((v) => v.address == null && v.valueSats == null);
  const extOut = vout.find((o) => o.address && !isMine(o.address) && sat(o.valueSats) > 0n);
  const extIn = vin.find((v) => v.address && !isMine(v.address));

  let title, iconCls, icon, cp = '', amt;
  if (detail.type !== 'dgb') {
    // The DGB shown for a DD tx is the collateral movement: a mint locks it
    // (out), a redeem frees it (back to us); a DD-only transfer is DGB-neutral
    // (just the fee), so no DGB amount — the label carries the meaning.
    title = DD_LABEL[detail.type] || 'DigiDollar';
    iconCls = 'dd'; icon = '◆';
    amt = detail.type === 'mint' ? -toOthers : detail.type === 'redeem' ? toMine : 0n;
    cp = sent && extOut ? `to ${truncAddr(extOut.address)}` : (extIn ? `from ${truncAddr(extIn.address)}` : '');
  } else if (sent) {
    title = toOthers > 0n ? 'Sent' : 'Sent to self';
    iconCls = 'out'; icon = '↑'; amt = -toOthers;
    cp = extOut ? `to ${truncAddr(extOut.address)}` : '';
  } else {
    title = coinbase ? 'Mined' : 'Received';
    iconCls = 'in'; icon = '↓'; amt = toMine;
    cp = !coinbase && extIn ? `from ${truncAddr(extIn.address)}` : '';
  }

  const amtCls = amt > 0n ? 'in' : 'out';
  const sign = amt > 0n ? '+' : amt < 0n ? '−' : '';
  const amtStr = amt === 0n ? '' : `${sign}${fmtDgb8(amt < 0n ? -amt : amt)} DGB`; // no misleading "0 DGB"
  const c = Number(detail.confirmations) || 0; // coerce: a number never carries markup
  // The tx's OWN confirmation count wins. It used to be vetoed by
  // `h.height === 0` from the address history — and on an imported Core
  // wallet's extra chains that entry can be a cached snapshot from before the
  // tx confirmed, so a payment with 24 confirmations kept reading "pending"
  // (report 2026-07-27). Height only decides when there is no count at all.
  // 6+ confirmations is settled — say "confirmed", not the jargon "final".
  // Below that, the count itself is the honest answer (still settling).
  const conf = c >= FINAL_CONF
    ? '<span class="tx-conf final">✓ confirmed</span>'
    : c > 0 ? `<span class="tx-conf partial">${c} of ${FINAL_CONF} conf</span>`
      : h.height === 0 ? '<span class="tx-conf pending">pending</span>'
        : '<span class="tx-conf partial">confirmed</span>';
  const feeStr = sent && detail.feeSats != null ? `fee ${fmtDgb8(sat(detail.feeSats))} DGB` : '';
  const time = Number(detail.time) || 0;
  const sub = [cp, relTime(time), feeStr].filter(Boolean).join(' · ');

  return `<div class="tx">` +
    `<div class="tx-icon ${iconCls}">${icon}</div>` +
    `<div class="tx-main"><div class="tx-title">${esc(title)}</div>` +
    `<div class="tx-sub">${esc(sub)}${sub ? ' · ' : ''}${link}${txCopyBtn(h.txid)}</div></div>` +
    `<div class="tx-right"><div class="tx-amt ${amtCls}">${amtStr}</div>${conf}</div></div>`;
}

function renderHistory() {
  const shown = allHistory.slice(0, historyLimit);
  const rows = shown.map(historyRow).join('');
  const more = allHistory.length > historyLimit
    ? '<button id="w-history-more" class="secondary">Show more</button>' : '';
  $('w-history').innerHTML = rows + more || 'No transactions yet.';
  for (const el of $('w-history').querySelectorAll('.icon-btn')) el.innerHTML = COPY_ICON;
  const mb = $('w-history-more');
  if (mb) mb.addEventListener('click', () => { historyLimit += 8; renderHistory(); enrichVisible(); });
}

/** Fetch enrichment for the visible page; re-render as details arrive. A tx is
 *  re-fetched every poll until it reaches finality (FINAL_CONF confirmations) —
 *  before then its confirmation count (and the pending→mined flip) still change,
 *  so a cached entry would otherwise freeze at "pending"/its first count. */
async function enrichVisible() {
  const targets = allHistory.slice(0, historyLimit).filter((h) => {
    if (!/^[0-9a-f]{64}$/.test(h.txid)) return false;
    const d = txDetailCache.get(h.txid);
    return !d || (Number(d.confirmations) || 0) < FINAL_CONF;
  });
  if (!targets.length) return;
  await Promise.all(targets.map(async (h) => {
    try { txDetailCache.set(h.txid, await fetchIndexer(`/tx/${h.txid}`)); } catch { /* keep the thin row */ }
  }));
  renderHistory();
}

// fiat equivalents (hero + asset row) from the latest oracle price
let lastConfirmedDgb = null;
let lastDdUsd = 0; // spendable DD of the active wallet — remove-ceremony warning
let lastIndexerTip = null; // indexer's chain tip at the last money poll (audit H5)
function renderFiat() {
  const has = lastPriceUsd != null && lastConfirmedDgb != null;
  $('w-balance-usd').textContent = has ? '≈ ' + fmtUSD(lastConfirmedDgb * lastPriceUsd) : '';
  $('as-dgb-usd').textContent = has ? fmtUSD(lastConfirmedDgb * lastPriceUsd) : '';
}

// live collateral estimate in the mint modal (exact Core arithmetic, same
// requiredCollateralSats the review step uses — just non-binding and instant)
function updateMintEstimate() {
  const el = $('mint-estimate');
  try {
    const cents = ddToCents($('w-mint-amount').value || '0');
    if (cents <= 0n || lastPriceMicroUsd == null) { el.textContent = ''; return; }
    const tier = LOCK_TIERS.find((t) => t.id === $('w-mint-tier').value) || LOCK_TIERS[0];
    const bps = lastDcaBps ?? 10_000n;
    const sats = requiredCollateralSats({ ddCents: cents, tierId: tier.id, oraclePriceMicroUsd: lastPriceMicroUsd, dcaMultiplierBps: bps });
    const ratio = effectiveRatioPercent(tier.ratioPercent, bps);
    el.textContent = `≈ ${fmtSats(sats)} DGB collateral (${ratio}% · ${tier.label} lock)` + (dcaNote() ? ` · ${dcaNote()}` : '');
  } catch {
    el.textContent = ''; // partial input while typing
  }
}
$('w-mint-amount').addEventListener('input', updateMintEstimate);
$('w-mint-tier').addEventListener('change', updateMintEstimate);

// ---- DGB price sparkline (24h, /api/price-history) ----
let lastPriceSeries = null; // cached so re-docking/resizing can re-render
async function loadPriceChart() {
  try {
    const { series } = await fetchJson('/api/price-history', {}, 15_000, 'the price service');
    lastPriceSeries = series;
    renderSparkline(series);
  } catch { /* chart is decorative — never block the wallet on it */ }
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderSparkline(lastPriceSeries), 200);
});

function renderSparkline(series) {
  const svg = $('price-chart');
  const tip = $('chart-tip');
  if (!Array.isArray(series) || series.length < 2) {
    svg.replaceChildren();
    $('price-delta').textContent = '';
    $('price-hint').textContent = 'Collecting price history — the chart appears after a few samples.';
    return;
  }
  $('price-hint').textContent = '';
  const W = $('chart-wrap').clientWidth || 430;
  const isDocked = Boolean($('price-block').closest('.hero'));
  const H = isDocked ? 72 : 96;
  const PAD = 6;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  // Downsample to a calm neobank-style curve: ~fifty averaged buckets instead
  // of every raw sample, then a Catmull-Rom smooth through them.
  const TARGET = 48;
  let pts = series;
  if (series.length > TARGET) {
    const step = series.length / TARGET;
    pts = Array.from({ length: TARGET }, (_, i) => {
      const chunk = series.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1));
      return {
        t: chunk[chunk.length - 1].t,
        price_micro_usd: chunk.reduce((s, p) => s + p.price_micro_usd, 0) / chunk.length,
      };
    });
    pts[pts.length - 1] = series[series.length - 1]; // end on the live price
  }
  const ts = pts.map((p) => p.t);
  const vs = pts.map((p) => p.price_micro_usd);
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  let vMin = Math.min(...vs);
  let vMax = Math.max(...vs);
  if (vMin === vMax) { vMin -= 1; vMax += 1; } // flat series still draws a line
  const pad = (vMax - vMin) * 0.08;
  vMin -= pad; vMax += pad;
  const x = (t) => PAD + ((t - t0) / (t1 - t0)) * (W - 2 * PAD);
  const y = (v) => PAD + (1 - (v - vMin) / (vMax - vMin)) * (H - 2 * PAD);
  const P = pts.map((p) => [x(p.t), y(p.price_micro_usd)]);
  // Catmull-Rom → cubic beziers: one flowing line, no jagged segments
  let line = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[Math.min(P.length - 1, i + 2)];
    line += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ` +
      `${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ` +
      `${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  // 2px accent curve over a soft vertical gradient; end-dot with surface ring
  svg.innerHTML =
    `<defs><linearGradient id="price-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="var(--accent)" stop-opacity=".20"></stop>` +
    `<stop offset="1" stop-color="var(--accent)" stop-opacity="0"></stop>` +
    `</linearGradient></defs>` +
    `<path d="${line}L${x(t1).toFixed(1)},${H}L${x(t0).toFixed(1)},${H}Z" fill="url(#price-grad)"></path>` +
    `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>` +
    `<line class="hair" y1="0" y2="${H}" stroke="var(--gray-300)" stroke-width="1" style="display:none"></line>` +
    `<circle class="hover-dot" r="4" fill="var(--accent)" stroke="#fff" stroke-width="2" style="display:none"></circle>` +
    `<circle cx="${x(last.t).toFixed(1)}" cy="${y(last.price_micro_usd).toFixed(1)}" r="4" fill="var(--accent)" stroke="#fff" stroke-width="2"></circle>`;
  const raw = series.map((p) => p.price_micro_usd);
  const delta = ((raw[raw.length - 1] - raw[0]) / raw[0]) * 100;
  $('price-delta').textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}% · 24h`;
  $('price-delta').className = 'price-delta ' + (delta >= 0 ? 'up' : 'down');
  // crosshair snaps to the nearest sample; tooltip shows its value + time
  const fmtP = (micro) => '$' + (micro / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
  svg.onpointermove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const tAt = t0 + ((ev.clientX - rect.left) / rect.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i] - tAt) < Math.abs(ts[best] - tAt)) best = i;
    const p = pts[best];
    const hair = svg.querySelector('.hair');
    const dot = svg.querySelector('.hover-dot');
    hair.setAttribute('x1', x(p.t)); hair.setAttribute('x2', x(p.t)); hair.style.display = '';
    dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.price_micro_usd)); dot.style.display = '';
    tip.querySelector('.tv').textContent = fmtP(p.price_micro_usd);
    tip.querySelector('.tk').textContent = new Date(p.t * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    tip.style.left = `${(x(p.t) / W) * 100}%`;
    tip.style.top = '0';
    tip.style.display = 'block';
  };
  svg.onpointerleave = () => {
    tip.style.display = 'none';
    svg.querySelector('.hair').style.display = 'none';
    svg.querySelector('.hover-dot').style.display = 'none';
  };
}

// ---- Send DGB (#6): plan → confirmation screen → sign → broadcast ----
// Nothing is signed until the user presses "Confirm & send"; the plan step only
// selects UTXOs and prices the fee so the confirmation can display them.

// Indexer freshness at signing time (audit H5): the index can lag the node,
// and a UTXO set even one block behind can double-count a just-spent coin.
// Every confirm screen shows this warning when the lag is real. Never BLOCKS —
// the user may know the answer is fine — but it must not be invisible.
async function showStaleNote(id, nodeBlocks = null) {
  let note = '';
  if (appConfig.indexer && lastIndexerTip != null) {
    try {
      const blocks = nodeBlocks ?? (await rpc('getblockchaininfo')).blocks;
      const lag = Number(blocks) - lastIndexerTip;
      if (lag > 2) {
        note = `The balance index is ${lag} blocks behind the node — recently received or spent coins may not be reflected here. Double-check before confirming.`;
      }
    } catch { /* the flow's own error path reports an unreachable node */ }
  }
  $(id).textContent = note;
  $(id).style.display = note ? 'block' : 'none';
}

/** "1.5" → 150000000n without float rounding (8 decimal places max). */
function dgbToSats(text) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error('enter the amount as a plain number, e.g. 1.5');
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? '').padEnd(8, '0') || '0');
}
const satsToDgb = (sats) => (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });

/** Every watched derivation (address + its key), spendable UTXOs attached.
 * Includes each key's P2WPKH twin — mint change (#38) — tagged type:'p2wpkh'
 * so planSpend prices it and buildSignedSpendTx signs it per BIP-143. */
async function spendableUtxos() {
  const wanted = [...watchedDerivations(), ...extraDerivations()].flatMap((d) => [
    { address: d.address, type: undefined, privKeyHex: d.privKeyHex },
    { address: d.p2wpkhAddress, type: 'p2wpkh', privKeyHex: d.privKeyHex },
  ]);
  // One bulk POST for the whole watch set: this scan runs on every Send/Max/
  // Redeem/Transfer click, and the per-address GETs were most of the "the app
  // looks stuck after you click" seconds. Same STRICT validator as the GET
  // path — these are signing inputs. Falls back per-address when the indexer
  // pre-dates the bulk endpoint.
  const bulk = bulkIndexer ? await fetchBulk(wanted.map((w) => w.address), ['utxos']) : null;
  const perAddr = bulk
    ? wanted.map(({ address, type, privKeyHex }) => {
      const entry = bulk.results?.[address];
      if (!entry || entry.error) throw new Error(`the balance index could not answer for an address (${entry?.error ?? 'no entry'})`);
      // F3: an incomplete scan is UNKNOWN — signing against a partial utxo set
      // must be impossible. Fail closed; the user retries in seconds.
      if (asIncomplete(entry)) {
        const e = new Error('the balance index is busy — still scanning; retry in a few seconds');
        e.retryable = true;
        throw e;
      }
      return validateUtxos({ utxos: entry.utxos }).utxos.map((u) => ({
        txidHex: u.txid, vout: u.vout, valueSats: BigInt(u.valueSats), height: Number(u.height), privKeyHex, ...(type && { type }),
      }));
    })
    : await mapLimited(wanted, (async ({ address, type, privKeyHex }) => {
      const { utxos } = await fetchIndexer(`/address/${address}/utxos`);
      return utxos.map((u) => ({
        txidHex: u.txid, vout: u.vout, valueSats: BigInt(u.valueSats), height: Number(u.height), privKeyHex, ...(type && { type }),
      }));
    }));
  // The same first-wins outpoint dedupe as the balance display: two descriptor
  // sources that resolve to the same chain (or a twin counted twice) make the
  // same coin appear under two addresses, and without this planSpend /
  // planMaxSpend could select it twice — a duplicate-input transaction the
  // node rejects at broadcast. First wins, so the surviving copy keeps the
  // first derivation's signing key (both copies sign with the same key anyway
  // when the addresses are identical).
  return dedupeUtxos(perAddr.flat());
}

/** Tiered fee-coin pick, shared by redeem planning and the post-gather
 * re-pick: a P2TR coin on the preferred key (the legacy single-key anatomy),
 * then any P2TR coin, then any segwit coin — smallest sufficient first, and
 * never a coin a sibling gather leg has already reserved. */
function pickFeeUtxo(spendable, minSats, preferKey, reserved) {
  const smallestFirst = (a, b) => (a.valueSats < b.valueSats ? -1 : 1);
  const free = spendable.filter((u) => u.valueSats >= minSats && !reserved?.has(`${u.txidHex}:${u.vout}`));
  const pick =
    (preferKey && free.filter((u) => u.type !== 'p2wpkh' && u.privKeyHex === preferKey).sort(smallestFirst)[0]) ??
    free.filter((u) => u.type !== 'p2wpkh').sort(smallestFirst)[0] ??
    free.filter((u) => u.type === 'p2wpkh').sort(smallestFirst)[0];
  if (pick) reserved?.add(`${pick.txidHex}:${pick.vout}`);
  return pick;
}

let pendingSend = null; // { plan, recipientScriptHex, amountSats, address } while confirming

function resetSend() {
  pendingSend = null;
  $('w-send-confirm').style.display = 'none';
  $('w-send-c-stale').style.display = 'none';
  $('w-send-review').disabled = false;
  // "Max" is armed out-of-band from the field it filled, so it has to be
  // disarmed by every path that abandons a draft — cancel, modal close, lock,
  // and WALLET SWITCH (resetWalletState calls this). Left armed, the next
  // Review re-plans a full drain against whatever wallet is open by then,
  // silently turning "send 10" into "send everything I now hold".
  sendMaxArmed = false;
  $('w-send-amount').value = '';
  updateSendEq();
}

// A pasted/scanned BIP21 `digibyte:` URI in the recipient field is unpacked into
// its parts (#71): the bare address replaces the field value, an embedded amount
// prefills the amount field (unless the user already typed one), and label/message
// show as read-only context. Bare addresses are untouched. Called from the input
// listener (live paste) and defensively from review (drivers set .value directly,
// which fires no input event). Idempotent: re-running on a bare address is a no-op.
function absorbSendUri() {
  const parsed = parseBip21($('w-send-to').value);
  if (!parsed) return;
  if (parsed.address !== $('w-send-to').value.trim()) $('w-send-to').value = parsed.address;
  if (parsed.amountSats != null && parsed.amountSats > 0n && !$('w-send-amount').value.trim()) {
    // BIP21 amounts are DGB by definition, and sendCcy is STICKY — it survives
    // from an earlier USD send in the same session. Writing a DGB figure while
    // the field is read as USD (sendAmountSats) meant a `?amount=200` request
    // was reviewed as $200: at $0.01/DGB that is 75x what the payee asked for.
    // Switch the field to the currency the number is actually in.
    if (sendCcy === 'USD') setSendCcy('DGB');
    // satsToDgbString (not the locale-formatted satsToDgb): no thousands commas,
    // so the value stays parseable by dgbToSats at review for amounts ≥ 1000 DGB.
    $('w-send-amount').value = satsToDgbString(parsed.amountSats);
    sendMaxArmed = false; // a requested amount is not a drain
    updateSendEq();       // the ≈-line is the only on-screen cue; it must not lag
  }
  const ctx = [parsed.label && `Label: ${parsed.label}`, parsed.message && `Message: ${parsed.message}`]
    .filter(Boolean).join(' · ');
  $('w-send-uri-ctx').textContent = ctx;
  $('w-send-uri-ctx').style.display = ctx ? 'block' : 'none';
}
$('w-send-to').addEventListener('input', absorbSendUri);

// ---- Fiat entry + send-max on the DGB send (#70) ----
// The amount can be typed in DGB or USD; USD is converted through the SAME
// oracle price the header shows (lastPriceMicroUsd), integer-only so the signed
// tx matches the review-time quote exactly. Send-max drains the confirmed,
// non-DD balance via planMaxSpend (one output, zero change).
let sendCcy = 'DGB';      // 'DGB' | 'USD' — active entry currency
let sendMaxArmed = false; // true once "Max" is clicked, until the amount is edited

// USD is only offered when the oracle price is present AND fresh (not stale) —
// same gate the mint flow uses. Stale/missing price → DGB-only entry.
// The node's own is_stale flag is the primary gate, but it only arrives with a
// poll. A tab that was throttled or a laptop that was asleep can hold a fresh
// -looking quote that is hours old, so the local age of the last answer is a
// second, independent conjunct. Kept at several times the poll cadence so one
// dropped tick does not disable USD entry.
const PRICE_MAX_AGE_MS = 180_000;
const priceUsable = () => lastPriceMicroUsd != null && lastPriceMicroUsd > 0n
  && netHealth.oracle === true
  && lastPriceAt != null && Date.now() - lastPriceAt < PRICE_MAX_AGE_MS;

/** "12.50" USD → sats, floored, via the live micro-USD/DGB oracle price. */
function usdToSats(text) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error('enter the USD amount as a plain number, e.g. 12.50');
  if (!priceUsable()) throw new Error('no fresh oracle price for USD conversion');
  const microUsd = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  return (microUsd * 100_000_000n) / lastPriceMicroUsd; // 1 DGB = 1e8 sats
}

/** The amount the user asked for, in sats, honouring the active currency. */
function sendAmountSats() {
  return sendCcy === 'USD' ? usdToSats($('w-send-amount').value) : dgbToSats($('w-send-amount').value);
}

const satsToUsd = (sats) => lastPriceUsd != null ? Number(sats) * lastPriceUsd / 1e8 : null;

// USD value of a sats amount for the $500 beta cap (#54), from a price fetched
// FRESH at review time — never the cached lastPriceUsd. Returns null (→ the
// warn-allow path, decision #6) off-mainnet, or when the node has no quote or
// reports it stale, so the cap never enforces at a wrong/boot-time rate.
async function freshCapUsd(amountSats) {
  if (chainState.netName !== 'mainnet') return null; // cap is mainnet-only
  try {
    const price = await rpc('getoracleprice');
    if (!price?.price_micro_usd || price.is_stale) return null;
    // price_micro_usd is µUSD per DGB; amountSats is 1e-8 DGB
    return Number(amountSats) * Number(price.price_micro_usd) / 1e14;
  } catch {
    return null; // node unreachable / no quote → couldn't verify
  }
}

/** Live "≈ …" line under the input, showing the amount in the other currency. */
function updateSendEq() {
  const el = $('w-send-amount-eq');
  const raw = $('w-send-amount').value.trim();
  let out = '';
  if (raw) {
    try {
      if (sendCcy === 'USD') out = '≈ ' + satsToDgbString(usdToSats(raw)) + ' DGB';
      else { const usd = satsToUsd(dgbToSats(raw)); if (usd != null) out = '≈ ' + fmtUSD(usd); }
    } catch { out = ''; }
  }
  el.textContent = out;
  el.style.display = out ? 'block' : 'none';
}

function setSendCcy(ccy) {
  sendCcy = ccy;
  $('w-send-amount-label').textContent = `Amount (${ccy})`;
  $('w-send-ccy').textContent = '⇄ ' + (ccy === 'DGB' ? 'USD' : 'DGB');
  $('w-send-ccy').title = ccy === 'DGB' ? 'Enter the amount in USD instead' : 'Enter the amount in DGB instead';
  $('w-send-amount').placeholder = ccy === 'USD' ? '0.00' : '';
  updateSendEq();
}

// Keep the currency control in sync with oracle freshness. Called on every
// status poll: if the price goes stale while USD is active, fall back to DGB.
function syncSendPriceGate() {
  const ok = priceUsable();
  $('w-send-ccy').disabled = !ok;
  if (!ok) {
    $('w-send-ccy').title = 'USD entry needs a fresh oracle price';
    if (sendCcy === 'USD') {
      // Demoting USD→DGB re-reads the SAME digits in a different currency —
      // the #116 bug class, now fired by a timer instead of a paste. So the
      // number goes, and Max goes with it: the Max handler arms sendMaxArmed
      // and then leaves the field on USD, and review checks sendMaxArmed
      // FIRST. Left armed behind a blanked field, the next Review would plan a
      // drain of the whole spendable balance that the user never asked for —
      // triggered by nothing more than one stale or failed getoracleprice.
      $('w-send-amount').value = '';
      sendMaxArmed = false;
      setSendCcy('DGB'); // refreshes the ≈-line last, so it describes the cleared field
    }
  } else if (sendCcy === 'DGB') {
    $('w-send-ccy').title = 'Enter the amount in USD instead';
  }
}

$('w-send-ccy').addEventListener('click', () => {
  if ($('w-send-ccy').disabled) return;
  setSendCcy(sendCcy === 'DGB' ? 'USD' : 'DGB');
});

// Manual edits override an armed max.
$('w-send-amount').addEventListener('input', () => { sendMaxArmed = false; updateSendEq(); });

// Max: fill the field with the entire spendable balance (confirmed, non-DD),
// and arm the max path so review recomputes it exactly against fresh UTXOs.
$('w-send-max').addEventListener('click', (e) =>
  busy(e.target, 'w-send-err', async () => {
    if (!wallet.seed) throw new Error('wallet is locked');
    if (!appConfig.indexer || !chainState.netKnown) throw new Error('balance is unavailable right now');
    absorbSendUri();
    // Price the output against the recipient's script when we have one (legacy
    // outputs are smaller); else assume P2TR — review recomputes exactly anyway.
    let recipientScriptHex;
    const addr = $('w-send-to').value.trim();
    if (addr) { try { recipientScriptHex = decodeAddress(addr).scriptPubKeyHex; } catch { /* refine at review */ } }
    const spendable = (await spendableUtxos()).filter((u) => u.height > 0 && u.valueSats > 0n);
    const plan = planMaxSpend({ utxos: spendable, recipientScriptHex });
    sendMaxArmed = true;
    if (sendCcy === 'USD' && priceUsable()) $('w-send-amount').value = satsToUsd(plan.amountSats).toFixed(2);
    else { if (sendCcy === 'USD') setSendCcy('DGB'); $('w-send-amount').value = satsToDgbString(plan.amountSats); }
    updateSendEq();
  }));

$('w-send-review').addEventListener('click', (e) =>
  busy(e.target, 'w-send-err', async () => {
    $('w-send-out').textContent = '';
    absorbSendUri(); // handle a URI set programmatically (no input event fired)
    const address = $('w-send-to').value.trim();
    // DGB sends accept every address type: segwit bech32/bech32m AND legacy
    // base58check P2PKH (D…)/P2SH (S…/3…). decodeAddress normalizes all of them.
    let decoded;
    try {
      decoded = decodeAddress(address);
    } catch (err) {
      throw new Error(`invalid address: ${err.message}`);
    }
    if (!decoded.networks.includes(chainState.netName)) {
      throw new Error(`address is not for this network (need a ${chainState.netName} address)`);
    }
    // Allow-list the script type instead of paying whatever decodeAddress
    // produced. The decoder rejects out-of-range witness versions now, but this
    // side must not depend on that: `type` was previously computed and never
    // read, so a decoder that ever admits a new form would silently become a
    // scriptPubKey the user pays. Anything not on this list is a bug, not a
    // recipient.
    if (!PAYABLE_ADDRESS_TYPES.has(decoded.type)) {
      throw new Error(`unsupported address type (${decoded.type}) — refusing to pay it`);
    }
    const recipientScriptHex = decoded.scriptPubKeyHex;
    let amountSats, plan;
    if (sendMaxArmed) {
      // Max: recompute against fresh confirmed, non-DD coins with the real
      // recipient script — one output, zero change (planMaxSpend). This is the
      // quote the tx is built from, so no re-quote happens between here and sign.
      const spendable = (await spendableUtxos()).filter((u) => u.height > 0 && u.valueSats > 0n);
      const m = planMaxSpend({ utxos: spendable, recipientScriptHex });
      ({ amountSats } = m);
      plan = { inputs: m.inputs, feeSats: m.feeSats };
    } else {
      amountSats = sendAmountSats(); // DGB or USD, converted at review time
      if (amountSats <= 0n) throw new Error('amount must be positive');
      plan = planSpend({ utxos: await spendableUtxos(), amountSats, recipientScriptHex });
    }
    // $500/tx beta cap (#54). Price it from a FRESH quote fetched at review
    // time — not the boot-time lastPriceUsd, which never refreshes and would
    // fail open after a transient oracle hiccup or under-count as DGB drifts
    // (the mint flow already re-fetches here). A stale or unavailable quote is
    // treated as "couldn't verify" → warn on the confirm screen, ALLOW the
    // send (decision #6). capUsd is null off-mainnet (the cap is mainnet-only).
    const capUsd = await freshCapUsd(amountSats);
    const capErr = betaCapError(chainState.netName, capUsd, currentTxCapUsd());
    if (capErr) throw new Error(`${capErr} (this send is ≈ ${fmtUSD(capUsd)})`);
    const capUnverified = chainState.netName === 'mainnet' && capUsd == null;
    $('w-send-c-capnote').style.display = capUnverified ? 'block' : 'none';
    // prefer the fresh cap price for the confirm estimate; fall back to the
    // cached oracle price off-mainnet or when the cap price was unavailable
    const usd = capUsd ?? satsToUsd(amountSats);
    pendingSend = { plan, recipientScriptHex, amountSats, address };
    await showStaleNote('w-send-c-stale'); // index freshness where it affects signing (audit H5)
    $('w-send-c-to').textContent = address;
    $('w-send-c-amount').textContent = satsToDgb(amountSats);
    $('w-send-c-amount-usd').textContent = usd != null ? `  ≈ ${fmtUSD(usd)}` : '';
    $('w-send-c-fee').textContent = satsToDgb(plan.feeSats);
    $('w-send-confirm').style.display = 'block';
    $('w-send-review').disabled = true;
  }));

$('w-send-cancel').addEventListener('click', resetSend);

$('w-send-go').addEventListener('click', (e) =>
  busy(e.target, 'w-send-err', async () => {
    const { plan, recipientScriptHex, amountSats } = pendingSend;
    if (!wallet.seed) throw new Error('wallet is locked');
    // change returns to the wallet's current receive address
    const changeAddress = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index }).address;
    // Sign ONCE: a retry after an ambiguous broadcast outcome must re-send the
    // IDENTICAL transaction (audit C1) — never a silent rebuild over the same
    // UTXOs, which would race the first attempt as a conflicting spend.
    if (!pendingSend.hex) {
      pendingSend.hex = buildSignedSpendTx({
        utxos: plan.inputs,
        recipientScriptHex,
        amountSats,
        changeScriptHex: scriptPubKeyFromAddress(changeAddress),
        feeSats: plan.feeSats,
      }).hex;
    }
    const txid = await broadcastLogged(pendingSend.hex, 'send');
    resetSend(); // clears the amount, disarms Max, refreshes the ≈-line
    $('w-send-to').value = '';
    $('w-send-amount-eq').style.display = 'none';
    $('w-send-uri-ctx').style.display = 'none';
    $('w-send-out').textContent = `Sent — tx ${txid.slice(0, 16)}…`;
    showTxSuccess('send-modal', txid, 'Transaction sent', 'It appears in Activity as pending until the next block confirms it.');
    refreshMoney();
  }));

// ---- Guided consolidation (#103 decision 2) ----
// When a plan fails only because the balance is FRAGMENTED — it covers the
// amount, but no single qualifying coin does — the error area offers
// "Consolidate coins": ONE self-spend of every confirmed DGB coin (P2WPKH
// twins included, #38/decision 3) to the CURRENT taproot receive address, so
// the retry finds one big P2TR coin. NEVER automatic: the user reviews the
// coin count and fee in this modal and confirms, like any other spend.

/** An error the Consolidate offer can actually fix. busy() reads the flag. */
function fragmentationError(msg) {
  const e = new Error(msg);
  e.consolidatable = true;
  return e;
}

let pendingConsolidate = null; // { plan, toAddress } — plan.inputs hold per-UTXO keys

function resetConsolidate() {
  pendingConsolidate = null;
  $('consolidate-modal').classList.remove('open');
}

async function openConsolidateModal() {
  // normal gating (#103): a locked wallet has no keys to plan with, and an
  // open connect/backup ceremony keeps its modal in front — never plan under it
  if (!wallet.seed || $('w-connect-modal').classList.contains('open')) return;
  pendingConsolidate = null;
  $('consolidate-modal').classList.remove('success');
  $('w-cons-err').textContent = '';
  $('w-cons-confirm').style.display = 'none';
  $('w-cons-c-stale').style.display = 'none';
  openModal('consolidate-modal');
  try {
    if (!appConfig.indexer || !chainState.netKnown) throw new Error('balance is unavailable right now');
    const current = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index });
    const toAddress = current.address;
    // confirmed, non-DD coins only — the same set Send-max drains. planMaxSpend
    // prices the one-output tx: amount = Σ(inputs) − fee, zero change. No $500
    // beta cap here: a self-spend moves nothing out of the wallet — capping it
    // would strand any balance above the cap fragmented forever.
    const spendable = (await spendableUtxos()).filter((u) => u.height > 0 && u.valueSats > 0n);
    if (spendable.length === 0) throw new Error('no confirmed coins to consolidate');
    // ONE coin is not always pointless: a sole P2WPKH twin (the common
    // post-mint case — mint change lands as v0) still needs consolidating,
    // because the self-spend converts it to key-path P2TR on the current
    // address, which the mint/transfer/redeem builders require. Same for a
    // sole P2TR coin on an OLD address: the fee gates want it on the current
    // one. Only a single P2TR coin ALREADY on the current address gains
    // nothing — a self-spend there would change nothing but pay a fee.
    if (spendable.length === 1 && spendable[0].type !== 'p2wpkh' && spendable[0].privKeyHex === current.privKeyHex) {
      throw new Error('your DGB is already a single coin on your current address — consolidating would only pay a fee');
    }
    const plan = planMaxSpend({ utxos: spendable, recipientScriptHex: scriptPubKeyFromAddress(toAddress) });
    pendingConsolidate = { plan, toAddress };
    await showStaleNote('w-cons-c-stale'); // index freshness (audit H5)
    $('w-cons-c-count').textContent = String(plan.inputs.length);
    $('w-cons-c-amount').textContent = satsToDgb(plan.amountSats);
    $('w-cons-c-to').textContent = toAddress;
    $('w-cons-c-fee').textContent = satsToDgb(plan.feeSats);
    $('w-cons-confirm').style.display = 'block';
  } catch (e) {
    $('w-cons-err').textContent = surfaceError(e);
  }
}
for (const id of ['w-send-err-consolidate', 'w-mint-err-consolidate', 'w-tr-err-consolidate', 'w-rd-err-consolidate']) {
  $(id).addEventListener('click', openConsolidateModal);
}

$('w-cons-go').addEventListener('click', (e) =>
  busy(e.target, 'w-cons-err', async () => {
    if (!wallet.seed) throw new Error('wallet is locked');
    if (!pendingConsolidate) throw new Error('nothing planned — close and reopen this dialog');
    const { plan, toAddress } = pendingConsolidate;
    const script = scriptPubKeyFromAddress(toAddress);
    // sign once, rebroadcast identically on retry (audit C1) — see send flow
    if (!pendingConsolidate.hex) {
      pendingConsolidate.hex = buildSignedSpendTx({
        utxos: plan.inputs,
        recipientScriptHex: script,
        amountSats: plan.amountSats,
        changeScriptHex: script, // zero change by construction (max plan) — same address either way
        feeSats: plan.feeSats,
      }).hex;
    }
    const txid = await broadcastLogged(pendingConsolidate.hex, 'consolidate');
    pendingConsolidate = null;
    showTxSuccess('consolidate-modal', txid, 'Consolidation sent',
      'Once the next block confirms it, retry the action that failed — your DGB will be one coin.');
    refreshMoney();
  }));

// ---- Mint DigiDollar (#14): plan → confirmation screen → sign → broadcast ----
// Feature-flagged (ADR-0002). Distinct, actionable errors for the three ways
// this can be impossible: softfork inactive, stale oracle quote, and not
// enough (or too fragmented) DGB for the collateral.
const MINT_FEE_SATS = 12_000_000n; // 0.12 DGB, above Core's 0.1 DGB DD fee floor

/** "100.5" → 10050n DD cents (2 decimal places max). */
function ddToCents(text) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error('enter the DigiDollar amount as a plain number, e.g. 100 or 99.50');
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

function initMintTiers() {
  $('w-mint-tier').innerHTML = LOCK_TIERS
    .map((t) => `<option value="${t.id}">${t.label} — ${t.ratioPercent}% collateral</option>`)
    .join('');
  // Tier slider UI over the hidden native select (still the source of truth —
  // drivers keep setting .value on it directly).
  const slider = $('tier-slider');
  slider.max = String(LOCK_TIERS.length - 1);
  const syncFromSelect = () => {
    const i = Math.max(0, LOCK_TIERS.findIndex((t) => t.id === $('w-mint-tier').value));
    const tier = LOCK_TIERS[i];
    slider.value = String(i);
    $('tier-name').textContent = tier.label;
    // the pill quotes the EFFECTIVE ratio — the estimate line explains the DCA
    $('tier-ratio').textContent = effectiveRatioPercent(tier.ratioPercent, lastDcaBps ?? 10_000n) + '% collateral';
    const p = (i / (LOCK_TIERS.length - 1)) * 100;
    slider.style.background = `linear-gradient(90deg, var(--accent) ${p}%, var(--gray-200) ${p}%)`;
  };
  slider.addEventListener('input', () => {
    $('w-mint-tier').value = LOCK_TIERS[Number(slider.value)].id;
    $('w-mint-tier').dispatchEvent(new Event('change', { bubbles: true }));
  });
  $('w-mint-tier').addEventListener('change', syncFromSelect);
  refreshTierReadout = syncFromSelect;
  syncFromSelect();
}

let pendingMint = null; // { utxo (with privKeyHex!), ddCents, tierId, priceMicroUsd } while confirming

function resetMint() {
  pendingMint = null;
  $('w-mint-confirm').style.display = 'none';
  $('w-mint-c-stale').style.display = 'none';
  $('w-mint-review').disabled = false;
}

const blocksToDate = (blocks) =>
  new Date(Date.now() + blocks * SECONDS_PER_BLOCK * 1000).toLocaleDateString('en-CA');

$('w-mint-review').addEventListener('click', (e) =>
  busy(e.target, 'w-mint-err', async () => {
    $('w-mint-out').textContent = '';
    // 1. softfork gate — minting is consensus-impossible while inactive
    if (chainState.ddActive === false) {
      throw new Error('DigiDollar is not active on this network yet — minting is impossible until the softfork activates. Watch the Status card.');
    }
    const ddCents = ddToCents($('w-mint-amount').value);
    if (ddCents <= 0n) throw new Error('amount must be positive');
    // consensus limits — the node would reject with bad-dd-mint-amount AFTER signing
    const limits = DD_TX_LIMITS[chainState.netName];
    const fmtC = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    if (ddCents < limits.minMintCents) {
      throw new Error(`this network's consensus minimum is ${fmtC(limits.minMintCents)} per mint — enter at least that`);
    }
    if (ddCents > limits.maxMintCents) {
      throw new Error(`this network's consensus maximum is ${fmtC(limits.maxMintCents)} per mint`);
    }
    // $500/tx beta cap (#54) — USD-native, so it applies regardless of the price feed
    const mintCapErr = betaCapError(chainState.netName, Number(ddCents) / 100, currentTxCapUsd());
    if (mintCapErr) throw new Error(mintCapErr);
    const tierId = $('w-mint-tier').value;
    const tier = LOCK_TIERS.find((t) => t.id === tierId);
    // 2. oracle gate — a stale quote would be rejected by mempool policy anyway
    const price = await rpc('getoracleprice');
    if (!price?.price_micro_usd) throw new Error('oracle price unavailable — the node returned no quote');
    if (price.is_stale) {
      throw new Error('the oracle price is stale — the network has not published a fresh quote; try again in a few minutes');
    }
    const priceMicroUsd = BigInt(price.price_micro_usd);
    // consensus sanity bounds — say so BEFORE signing. Sub-cent DGB
    // prices are valid: the micro-USD path has no $0.01 floor.
    if (priceMicroUsd < ORACLE_MIN_PRICE_MICRO_USD || priceMicroUsd > ORACLE_MAX_PRICE_MICRO_USD) {
      throw new Error(`the oracle price ($${(Number(priceMicroUsd) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })}/DGB) is outside the consensus bounds $0.0001–$100 — the network would reject this mint`);
    }
    // 3. volatility gate (#62): consensus freezes mints on sharp price moves.
    // Best-effort — if the status RPC is unavailable the broadcast error
    // mapping still catches the reject, but warning BEFORE signing is kinder.
    const prot = await rpc('getprotectionstatus').catch(() => null);
    if (prot?.volatility?.minting_restricted) {
      // covers the ≥50%/7d all-operations freeze too: Core sets mintingFrozen
      // whenever allOperationsFrozen is set (consensus/volatility.cpp)
      throw new Error(MINT_FREEZE_EXPLANATION + ' Your funds are untouched — try again once the market calms.');
    }
    if (prot?.oracle?.minting_restricted) {
      throw new Error('minting is restricted: the node reports no usable oracle price' + (prot.oracle.minting_restricted_reason ? ` (${prot.oracle.minting_restricted_reason})` : '') + ' — try again in a few minutes');
    }
    // 4. honest quote (#62): the node's DCA multiplier scales the required
    // collateral with network health — without it a degraded-system quote
    // would be too low and the mint rejected after signing.
    const dca = await rpc('getdcamultiplier');
    const dcaMultiplierBps = dcaBpsFromMultiplier(dca.multiplier);
    lastDcaBps = dcaMultiplierBps; // keep the live preview in step with the review
    lastDcaInfo = dca;
    const collateralSats = requiredCollateralSats({ ddCents, tierId, oraclePriceMicroUsd: priceMicroUsd, dcaMultiplierBps });
    const needSats = collateralSats + MINT_FEE_SATS;
    // 5. funding gate — the mint spends ONE UTXO, so it must cover everything.
    // Only P2TR coins qualify: buildSignedMintTx signs key-path taproot (a
    // p2wpkh coin — earlier mint change — is consolidated via Send first).
    const utxos = await spendableUtxos();
    const totalSats = utxos.reduce((s, u) => s + u.valueSats, 0n);
    const utxo = utxos.filter((u) => u.type !== 'p2wpkh' && u.valueSats >= needSats)
      .sort((a, b) => (a.valueSats < b.valueSats ? -1 : 1))[0];
    if (!utxo) {
      // fragmented (not insufficient) funds are fixable by the guided
      // consolidation — the flag reveals the "Consolidate coins" offer (#103)
      throw totalSats >= needSats
        ? fragmentationError(`your balance covers it, but no single coin is large enough (a mint spends one coin). Send ${fmtSats(needSats)} DGB to your own address to consolidate, then retry.`)
        : new Error(`insufficient funds: this mint needs ${fmtSats(needSats)} DGB (collateral + fee), you have ${fmtSats(totalSats)} DGB`);
    }
    const { blocks: tipHeight } = await rpc('getblockchaininfo');
    const unlockHeight = tipHeight + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks;
    pendingMint = { utxo, ddCents, tierId, priceMicroUsd, dcaMultiplierBps };
    await showStaleNote('w-mint-c-stale', tipHeight); // reuse the fresh height (audit H5)
    $('w-mint-c-dd').textContent = (Number(ddCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    $('w-mint-c-coll').textContent = fmtSats(collateralSats);
    // the ratio row makes a degraded-health quote visibly different (#62)
    const effRatio = effectiveRatioPercent(tier.ratioPercent, dcaMultiplierBps);
    $('w-mint-c-ratio').textContent = dcaNote()
      ? `${effRatio}% (${tier.ratioPercent}% base, ${dcaNote()})`
      : `${effRatio}%`;
    // 6 digits = exact for micro-USD; 5 would round sub-cent prices ($0.002546 → $0.00255)
    $('w-mint-c-price').textContent = '$' + (Number(priceMicroUsd) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' / DGB';
    $('w-mint-c-fee').textContent = fmtSats(MINT_FEE_SATS);
    $('w-mint-c-unlock').textContent = `≈ ${blocksToDate(unlockHeight - tipHeight)} (block ${unlockHeight.toLocaleString('en-US')})`;
    $('w-mint-confirm').style.display = 'block';
    $('w-mint-review').disabled = true;
  }));

$('w-mint-cancel').addEventListener('click', resetMint);

$('w-mint-go').addEventListener('click', (e) =>
  busy(e.target, 'w-mint-err', async () => {
    const { utxo, ddCents, tierId, priceMicroUsd, dcaMultiplierBps } = pendingMint;
    if (!wallet.seed) throw new Error('wallet is locked');
    // sign once, rebroadcast identically on retry (audit C1) — see send flow.
    // The CLTV height comes from the FIRST attempt's tip — still valid on retry.
    if (!pendingMint.hex) {
      const { blocks: tipHeight } = await rpc('getblockchaininfo'); // fresh height at sign time
      pendingMint.hex = buildSignedMintTx({
        utxo,
        privKeyHex: utxo.privKeyHex,
        ddCents,
        tierId,
        oraclePriceMicroUsd: priceMicroUsd,
        dcaMultiplierBps, // sign exactly what was reviewed — the builder recomputes collateral
        tipHeight,
        feeSats: MINT_FEE_SATS,
      }).hex;
    }
    const txid = await broadcastLogged(pendingMint.hex, 'mint');
    resetMint();
    $('w-mint-amount').value = '';
    $('w-mint-out').textContent = `Minted — tx ${txid.slice(0, 16)}… The position appears below once confirmed.`;
    showTxSuccess('mint-modal', txid, 'Mint submitted', 'Your position appears under DigiDollar positions once the transaction confirms.');
    refreshMoney();
  }));

// ---- Transfer DigiDollar (#15): plan → confirmation → sign → broadcast ----
// Same stablecoin feature flag as Mint. A transfer spends ONE DD token UTXO
// plus ONE DGB fee UTXO owned by the SAME key (Core's transfer anatomy), so
// both coin picks are per-derivation-address.
const TRANSFER_FEE_SATS = 12_000_000n; // 0.12 DGB, above Core's DD fee floor

/** Every watched derivation's DD token UTXOs, with the owning key attached.
 * Primary chain AND imported extra chains: positions and the DD balance scan
 * extras (refreshMoney), so a burn/remedy search that skips them reports DD
 * missing that the wallet is visibly holding — the imported-Core-vault redeem
 * failure of 2026-07-28. DD lives on P2TR only; the p2wpkh twins carry none. */
async function ddUtxosWithKeys() {
  const derivs = [...watchedDerivations(), ...extraDerivations()];
  // Bulk twin of the scan below, same reason as spendableUtxos: this runs on
  // every Redeem/Transfer click and the per-address GETs were the wait. The
  // STRICT dd-utxo validator still guards every entry — burn inputs sign.
  const bulk = bulkIndexer ? await fetchBulk(derivs.map((d) => d.address), ['dd-utxos']) : null;
  const perAddr = bulk
    ? derivs.map((d) => {
      const entry = bulk.results?.[d.address];
      if (!entry || entry.error) throw new Error(`the balance index could not answer for an address (${entry?.error ?? 'no entry'})`);
      // F3: burn inputs sign — an incomplete DD scan must fail CLOSED, never
      // build a transaction from a partial coin set.
      if (asIncomplete(entry)) {
        const e = new Error('the balance index is busy — still scanning; retry in a few seconds');
        e.retryable = true;
        throw e;
      }
      return validateDdUtxos({ utxos: entry.ddUtxos, totalCents: entry.ddTotalCents }).utxos.map((u) => ({
        txidHex: u.txid, vout: u.vout, ddCents: BigInt(u.cents), height: u.height,
        privKeyHex: d.privKeyHex, address: d.address,
      }));
    })
    : await mapLimited(derivs, async (d) => {
      const { utxos } = await fetchIndexer(`/address/${d.address}/dd-utxos`);
      return utxos.map((u) => ({
        txidHex: u.txid, vout: u.vout, ddCents: BigInt(u.cents), height: u.height,
        privKeyHex: d.privKeyHex, address: d.address,
      }));
    });
  // Same first-wins dedupe as spendableUtxos: two descriptor sources resolving
  // to the same chain must never put the same DD coin into one tx twice.
  return dedupeUtxos(perAddr.flat());
}

let pendingTransfer = null; // { ddUtxo, feeUtxo (both hold keys!), cents, outputKeyHex } while confirming

function resetTransfer() {
  pendingTransfer = null;
  $('w-tr-confirm').style.display = 'none';
  $('w-tr-c-stale').style.display = 'none';
  $('w-tr-review').disabled = false;
}

$('w-tr-review').addEventListener('click', (e) =>
  busy(e.target, 'w-tr-err', async () => {
    $('w-tr-out').textContent = '';
    // FR-4: spending DD out of a TREASURY wallet gets the hard warning first —
    // Cancel aborts the review; the override is logged in the treasury metadata
    if (!(await treasuryHooks.beforeDdTransfer(wallet.id))) return;
    // Recipient may be given in EITHER encoding: the DigiDollar base58check form
    // (DD…/TD…/RD…, the ONLY form Core/Android senddigidollar accepts) or the
    // equivalent witness-v1 bech32m form (…1p…). Both encode the same 32-byte
    // taproot output key → the same scriptPubKey. decodeDDAddress accepts both.
    const address = $('w-tr-to').value.trim();
    let decoded;
    try {
      decoded = decodeDDAddress(address);
    } catch (err) {
      throw new Error(`invalid DigiDollar address: ${err.message}`);
    }
    if (decoded.network !== chainState.netName) {
      throw new Error(`address is not for this network (expected a ${chainState.netName} DigiDollar address)`);
    }
    const cents = ddToCents($('w-tr-amount').value);
    if (cents <= 0n) throw new Error('amount must be positive');
    const trLimits = DD_TX_LIMITS[chainState.netName];
    if (cents < trLimits.minOutputCents) {
      throw new Error(`consensus forbids DigiDollar outputs below $${(Number(trLimits.minOutputCents) / 100).toFixed(2)} — send at least that`);
    }
    // $500/tx beta cap (#54) — USD-native, so it applies regardless of the price feed
    const trCapErr = betaCapError(chainState.netName, Number(cents) / 100, currentTxCapUsd());
    if (trCapErr) throw new Error(trCapErr);
    const ddUtxos = await ddUtxosWithKeys();
    const totalCents = ddUtxos.reduce((s, u) => s + u.ddCents, 0n);
    // Smallest coin that covers the amount AND leaves legal change. Consensus
    // checks every DD output of a transfer against the $1 minimum, change
    // included, so a coin that would leave 1..99c of change cannot be spent for
    // this amount at all — picking it anyway builds a transaction the network
    // refuses. Spending the coin whole leaves no change output, so that is fine
    // at any size. Without this clause the old smallest-first pick would take
    // the $10.50 coin to send $10.00 and fail, while an untouched $20.00 coin
    // sitting right beside it would have worked.
    const leavesLegalChange = (u) => u.ddCents === cents || u.ddCents - cents >= trLimits.minOutputCents;
    const covering = ddUtxos.filter((u) => u.ddCents >= cents);
    const ddUtxo = covering.filter(leavesLegalChange).sort((a, b) => (a.ddCents < b.ddCents ? -1 : 1))[0];
    if (!ddUtxo) {
      const fmtDD = (c) => (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
      const minDD = `$${(Number(trLimits.minOutputCents) / 100).toFixed(2)}`;
      throw new Error(covering.length
        // every coin big enough would leave illegal change — name the way out,
        // which is an amount, not a different coin
        ? `no single DigiDollar coin can send $${fmtDD(cents)} and leave legal change: the coins that cover it would each leave under ${minDD}, which consensus rejects. Send the whole coin ($${fmtDD(covering.sort((a, b) => (a.ddCents < b.ddCents ? -1 : 1))[0].ddCents)}) or at least ${minDD} less.`
        : totalCents >= cents
          ? `your DigiDollar covers it, but it is split across smaller coins (a transfer spends one DD coin, largest is $${fmtDD(ddUtxos.reduce((m, u) => (u.ddCents > m ? u.ddCents : m), 0n))}). Transfer that amount or less, or consolidate by transferring to your own address.`
          : `insufficient DigiDollar: you are sending $${fmtDD(cents)} but hold $${fmtDD(totalCents)}`);
    }
    // Same fee rule as redeem: the fee coin only has to belong to THIS
    // wallet — prefer a P2TR coin on the DD coin's own key (legacy anatomy),
    // then any P2TR coin, then any segwit coin (mint change is p2wpkh, #38).
    const spendable = await spendableUtxos();
    const bigEnough = (u) => u.valueSats >= TRANSFER_FEE_SATS;
    const smallestFirst = (a, b) => (a.valueSats < b.valueSats ? -1 : 1);
    const feeUtxo =
      spendable.filter((u) => u.type !== 'p2wpkh' && u.privKeyHex === ddUtxo.privKeyHex && bigEnough(u)).sort(smallestFirst)[0] ??
      spendable.filter((u) => u.type !== 'p2wpkh' && bigEnough(u)).sort(smallestFirst)[0] ??
      spendable.filter((u) => u.type === 'p2wpkh' && bigEnough(u)).sort(smallestFirst)[0];
    if (!feeUtxo) {
      const msg = `no DGB coin of at least ${fmtSats(TRANSFER_FEE_SATS)} DGB for the fee — top up any of your receive addresses, then retry`;
      // consolidation lands every DGB coin on the CURRENT receive address as
      // P2TR — offer it when that is where the fee is missing (a fee-only
      // p2wpkh twin balance there is the common post-mint case, #103)
      const cur = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index }).address;
      throw ddUtxo.address === cur ? fragmentationError(msg) : new Error(msg);
    }
    pendingTransfer = { ddUtxo, feeUtxo, cents, outputKeyHex: decoded.outputKeyHex, address };
    await showStaleNote('w-tr-c-stale'); // index freshness (audit H5)
    $('w-tr-c-to').textContent = address;
    $('w-tr-c-dd').textContent = (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    $('w-tr-c-change').textContent = (Number(ddUtxo.ddCents - cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    $('w-tr-c-fee').textContent = fmtSats(TRANSFER_FEE_SATS);
    $('w-tr-confirm').style.display = 'block';
    $('w-tr-review').disabled = true;
  }));

$('w-tr-cancel').addEventListener('click', resetTransfer);

$('w-tr-go').addEventListener('click', (e) =>
  busy(e.target, 'w-tr-err', async () => {
    const { ddUtxo, feeUtxo, cents, outputKeyHex } = pendingTransfer;
    if (!wallet.seed) throw new Error('wallet is locked');
    // sign once, rebroadcast identically on retry (audit C1) — see send flow
    if (!pendingTransfer.hex) {
      pendingTransfer.hex = buildSignedTransferTx({
        ddUtxo: { txidHex: ddUtxo.txidHex, vout: ddUtxo.vout, ddCents: ddUtxo.ddCents },
        feeUtxo: { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats, type: feeUtxo.type },
        privKeyHex: ddUtxo.privKeyHex,
        feePrivKeyHex: feeUtxo.privKeyHex, // the fee coin's own key — may differ from the sender's
        recipients: [{ outputKeyHex, cents }],
        feeSats: TRANSFER_FEE_SATS,
        // fee change back to the WATCHED address (default P2WPKH would vanish from view)
        dgbChangeScriptHex: scriptPubKeyFromAddress(ddUtxo.address),
      }).hex;
    }
    const txid = await broadcastLogged(pendingTransfer.hex, 'transfer');
    resetTransfer();
    $('w-tr-to').value = '';
    $('w-tr-amount').value = '';
    $('w-tr-out').textContent = `Transferred — tx ${txid.slice(0, 16)}…`;
    showTxSuccess('send-modal', txid, 'DigiDollar sent', 'The transfer appears in Activity as pending until the next block confirms it.');
    refreshMoney();
  }));

// ---- Redeem DigiDollar (#16): pick a position → confirmation → sign → broadcast ----
// Full redemption via the Normal tapscript path (expired CLTV + owner sig):
// burns DD covering the minted amount, returns the whole collateral to the
// owner's P2TR — which IS a wallet address, so the DGB balance grows by it.
const REDEEM_FEE_SATS = 12_000_000n; // 0.12 DGB, above Core's DD fee floor
const GATHER_WAIT_MS = 4 * 60_000; // one confirmation is ~15s; patience ceiling for the gather

/** Plan the gather: which DD coins self-transfer to the position's address so
 * the burn can happen at all (a redemption's burn inputs must sit on the
 * vault's own address — the user should never have to learn that). One leg per
 * coin: the transfer builder spends ONE DD input. Move exactly the remaining
 * shortfall when the change would be legal (≥ $1 or zero); otherwise move the
 * WHOLE coin — over-gathering is harmless, the redeem hands the surplus back
 * as DD change to the same owner. Sub-$1 splinters cannot move (a transfer
 * recipient output is checked against the $1 minimum) and whole-coin moves
 * past the per-tx beta cap are refused; either can make the shortfall
 * uncoverable → null, and the caller points at Core's redeemdigidollar. */
function planGather({ coins, shortfallCents, minOutputCents, capCents, targetAddress }) {
  const legs = [];
  let remaining = shortfallCents;
  for (const u of [...coins].sort((a, b) => (a.ddCents > b.ddCents ? -1 : 1))) {
    if (remaining <= 0n) break;
    if (u.ddCents < minOutputCents) continue;
    let cents = remaining < u.ddCents ? remaining : u.ddCents; // never move more than the coin holds
    if (cents < minOutputCents || (u.ddCents - cents > 0n && u.ddCents - cents < minOutputCents)) cents = u.ddCents; // whole coin: change would be illegal dust
    if (capCents && cents > capCents) continue;
    legs.push({ ddUtxo: u, cents, feeUtxo: null, hex: null });
    remaining -= cents;
  }
  if (remaining > 0n || !legs.length) return null;
  return {
    legs,
    moveCents: legs.reduce((s, l) => s + l.cents, 0n),
    outputKeyHex: decodeDDAddress(targetAddress).outputKeyHex,
    done: false,
  };
}

/** Poll until `needCents` of CONFIRMED DD sits on `address` — i.e. the gather
 * legs have landed — or patience runs out. The redeem must not spend an
 * unconfirmed gather coin: a chained zero-value DD input is not a shape this
 * flow is verified against. */
async function waitForDdOnAddress(address, needCents, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { utxos } = await fetchIndexer(`/address/${address}/dd-utxos`);
    const confirmed = (utxos ?? []).filter((u) => Number(u.height) > 0).reduce((s, u) => s + BigInt(u.cents), 0n);
    if (confirmed >= needCents) return;
    if (Date.now() > deadline) {
      throw new Error('the move is still waiting for its first confirmation — click Confirm & redeem again in a minute; it picks up exactly where it stopped');
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

let pendingRedeem = null; // { position, ddUtxos, feeUtxo (keys inside!), needCents, gather? } while confirming

function resetRedeem() {
  pendingRedeem = null;
  $('w-redeem-confirm').style.display = 'none';
  $('w-rd-c-stale').style.display = 'none';
  $('w-rd-c-gather-row').style.display = 'none';
  $('w-rd-c-gather-note').style.display = 'none';
}

$('w-positions').addEventListener('click', (e) => {
  const txid = e.target?.dataset?.redeem;
  if (!txid || !openPositions.has(txid)) return;
  busy(e.target, 'w-rd-err', async () => {
    $('w-rd-out').textContent = '';
    const p = openPositions.get(txid);
    const needCents = BigInt(p.ddCents);
    const fmtDD = (c) => (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    // $500/tx beta cap (#54). Redemption is all-or-nothing, so an over-cap
    // position (minted outside this wallet) can't shrink to fit — point at
    // Core rather than stranding the funds without an explanation.
    const rdCapErr = betaCapError(chainState.netName, Number(needCents) / 100, currentTxCapUsd());
    if (rdCapErr) {
      throw new Error(`${rdCapErr} — this position redeems $${fmtDD(needCents)} at once; use DigiByte Core to redeem it during the beta`);
    }
    // burnable DD must sit on the position's own address (one signing key) —
    // but the user should never have to know that. When the address is short
    // and the wallet covers it elsewhere, plan a GATHER: self-transfers move
    // the missing DD into place as part of the redeem (see planGather).
    const all = await ddUtxosWithKeys();
    const onAddr = all.filter((u) => u.address === p.address).sort((a, b) => (a.ddCents < b.ddCents ? 1 : -1));
    const burn = [];
    let got = 0n;
    for (const u of onAddr) { if (got >= needCents) break; burn.push(u); got += u.ddCents; }
    let gather = null;
    if (got < needCents) {
      const totalCents = all.reduce((s, u) => s + u.ddCents, 0n);
      if (totalCents < needCents) {
        throw new Error(`you no longer hold enough DigiDollar: redeeming burns $${fmtDD(needCents)}, you hold $${fmtDD(totalCents)} (some was transferred away)`);
      }
      gather = planGather({
        coins: all.filter((u) => u.address !== p.address),
        shortfallCents: needCents - got,
        minOutputCents: DD_TX_LIMITS[chainState.netName].minOutputCents,
        capCents: chainState.netName === 'mainnet' || chainState.netName === 'main' ? 50_000n : null, // the same $500 beta cap every tx lives under
        targetAddress: p.address,
      });
      if (!gather) {
        throw new Error(`your DigiDollar covers the $${fmtDD(needCents)} burn, but it is split into coins too small to move into place automatically — redeem this position with DigiByte Core (redeemdigidollar), which can gather across keys itself`);
      }
    }
    // The fee leg is the flexible one — the builder signs it with its own key,
    // P2TR or P2WPKH. Prefer a P2TR coin on the position's own key (the legacy
    // single-key anatomy), then any P2TR coin, then any segwit coin: mint
    // change lands p2wpkh (#38), and that coin MUST be fee-eligible or every
    // mint-then-redeem strands itself (2026-07-28 incident). Gather legs each
    // need their OWN fee coin — one coin, one spend, so every pick is reserved.
    const spendable = await spendableUtxos();
    const reserved = new Set();
    const pickFee = (minSats, preferKey) => pickFeeUtxo(spendable, minSats, preferKey, reserved);
    if (gather) for (const leg of gather.legs) {
      leg.feeUtxo = pickFee(TRANSFER_FEE_SATS, leg.ddUtxo.privKeyHex);
      if (!leg.feeUtxo) {
        throw new Error(`moving your DigiDollar into place needs ${fmtSats(TRANSFER_FEE_SATS)} DGB per move (${gather.legs.length} ${gather.legs.length === 1 ? 'move' : 'moves'} plus the redeem itself) — top up any of your receive addresses, then retry`);
      }
    }
    const feeUtxo = pickFee(REDEEM_FEE_SATS, burn[0]?.privKeyHex);
    // One coin, two jobs: when every fee-sized coin is reserved by a gather
    // leg, the redeem's own fee can still come out of a leg's CHANGE — that
    // change is confirmed (and indexed) before the redeem broadcasts, so the
    // pick is deferred to the confirm step. Without this a wallet holding its
    // DGB in a single coin was told it had "no DGB coin for the fee" while the
    // money sat right there (2026-07-28: 26k DGB, one coin, one gather leg).
    const feeFromGatherChange = !feeUtxo && !!gather && gather.legs.some((leg) =>
      leg.feeUtxo && leg.feeUtxo.valueSats - TRANSFER_FEE_SATS >= REDEEM_FEE_SATS);
    if (!feeUtxo && !feeFromGatherChange) {
      const msg = `no DGB coin of at least ${fmtSats(REDEEM_FEE_SATS)} DGB for the fee — top up any of your receive addresses, then retry`;
      // consolidation lands every DGB coin on the CURRENT receive address as
      // P2TR — offer it when that is where the fee is missing
      const cur = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index }).address;
      throw p.address === cur ? fragmentationError(msg) : new Error(msg);
    }
    pendingRedeem = { position: p, ddUtxos: burn, feeUtxo, feeFromGatherChange, needCents, gather };
    await showStaleNote('w-rd-c-stale'); // index freshness (audit H5)
    $('w-rd-c-txid').textContent = p.txid.slice(0, 12) + '…';
    $('w-rd-c-dd').textContent = fmtDD(needCents);
    $('w-rd-c-coll').textContent = fmtSats(BigInt(p.collateralSats));
    $('w-rd-c-fee').textContent = fmtSats(REDEEM_FEE_SATS + (gather ? TRANSFER_FEE_SATS * BigInt(gather.legs.length) : 0n));
    if (gather) {
      $('w-rd-c-gather').textContent = fmtDD(gather.moveCents);
      $('w-rd-c-gather-note').textContent =
        'Your DigiDollar sits in a few separate pockets inside this wallet, and redeeming needs it in one place — after you confirm, the wallet moves it over by itself, waits for one confirmation (usually under a minute), then finishes the redeem. You can close the app and come back; Confirm & redeem picks up where it left off. ' +
        "(For the curious: DigiDollar coins live on several addresses of your wallet — imported Core chains included — and a redemption can only burn coins sitting on the vault's own address, so the wallet first moves them there with a self-transfer. That move costs one small extra network fee, already included in the total above.)" +
        (feeFromGatherChange
          ? ' And since your DGB sits in a single coin, the redeem’s own fee simply comes out of the change from that move — one coin covers everything.'
          : '');
    }
    $('w-rd-c-gather-row').style.display = gather ? '' : 'none';
    $('w-rd-c-gather-note').style.display = gather ? '' : 'none';
    $('w-redeem-confirm').style.display = 'block';
  });
});

$('w-rd-cancel').addEventListener('click', resetRedeem);

$('w-rd-go').addEventListener('click', (e) =>
  busy(e.target, 'w-rd-err', async () => {
    const { position: p, needCents, gather } = pendingRedeem;
    if (!wallet.seed) throw new Error('wallet is locked');

    // Gather phase: broadcast the self-transfers, wait for one confirmation,
    // then re-scan the burn from the position's address. Every leg's hex is
    // cached at first sign and broadcastLogged treats already-in-mempool as
    // success, so a retry after a timeout never double-moves — and the
    // pending-broadcast recovery card covers a dropped answer mid-phase.
    if (gather && !gather.done) {
      const note = $('w-rd-c-gather-note');
      const fmtDD = (c) => (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
      for (const [i, leg] of gather.legs.entries()) {
        if (!leg.hex) {
          leg.hex = buildSignedTransferTx({
            ddUtxo: { txidHex: leg.ddUtxo.txidHex, vout: leg.ddUtxo.vout, ddCents: leg.ddUtxo.ddCents },
            feeUtxo: { txidHex: leg.feeUtxo.txidHex, vout: leg.feeUtxo.vout, valueSats: leg.feeUtxo.valueSats, type: leg.feeUtxo.type },
            privKeyHex: leg.ddUtxo.privKeyHex,
            feePrivKeyHex: leg.feeUtxo.privKeyHex, // the fee coin's own key — may differ from the coin's
            recipients: [{ outputKeyHex: gather.outputKeyHex, cents: leg.cents }],
            feeSats: TRANSFER_FEE_SATS,
            dgbChangeScriptHex: scriptPubKeyFromAddress(leg.ddUtxo.address), // fee change stays watched
          }).hex;
        }
        note.textContent = gather.legs.length === 1
          ? `Moving $${fmtDD(leg.cents)} into place…`
          : `Moving $${fmtDD(leg.cents)} into place (${i + 1} of ${gather.legs.length})…`;
        await broadcastLogged(leg.hex, 'transfer');
      }
      note.textContent = 'Waiting for one confirmation — usually under a minute…';
      await waitForDdOnAddress(p.address, needCents, GATHER_WAIT_MS);
      if (!pendingRedeem) return; // cancelled mid-wait — the confirmed move stands, a fresh Redeem click finishes it
      gather.done = true;
      const fresh = await ddUtxosWithKeys();
      const burn = [];
      let got = 0n;
      // CONFIRMED coins only: the wait above guarantees confirmed coverage,
      // but an unrelated unconfirmed arrival could otherwise be picked into
      // the burn — a chained zero-value DD input is not a verified shape.
      for (const u of fresh.filter((u) => u.address === p.address && Number(u.height) > 0).sort((a, b) => (a.ddCents < b.ddCents ? 1 : -1))) {
        if (got >= needCents) break;
        burn.push(u); got += u.ddCents;
      }
      if (got < needCents) throw new Error('the move confirmed but the balance index has not caught up — click Confirm & redeem once more');
      pendingRedeem.ddUtxos = burn;
      note.textContent = 'In place — finishing the redeem…';
    }

    let { ddUtxos, feeUtxo } = pendingRedeem;
    // Deferred fee: every fee-sized coin was reserved by a gather leg at plan
    // time, but the legs are confirmed now — a leg's change coin exists and a
    // fresh scan can pick it (confirmed coins only: a chained unconfirmed fee
    // input is not a verified shape).
    if (!feeUtxo && pendingRedeem.feeFromGatherChange) {
      const confirmed = (await spendableUtxos()).filter((u) => Number(u.height) > 0);
      feeUtxo = pickFeeUtxo(confirmed, REDEEM_FEE_SATS, ddUtxos[0]?.privKeyHex, null);
      if (!feeUtxo) throw new Error('the move confirmed but its change has not indexed yet — click Confirm & redeem once more');
      pendingRedeem.feeUtxo = feeUtxo;
    }
    // sign once, rebroadcast identically on retry (audit C1) — see send flow
    if (!pendingRedeem.hex) {
      pendingRedeem.hex = buildSignedRedeemTx({
        collateralUtxo: {
          txidHex: p.txid, vout: 0, valueSats: BigInt(p.collateralSats),
          lockHeight: p.unlockHeight, ddCents: BigInt(p.ddCents),
        },
        ddUtxos: ddUtxos.map((u) => ({ txidHex: u.txidHex, vout: u.vout, ddCents: u.ddCents })),
        feeUtxo: { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats, type: feeUtxo.type },
        privKeyHex: ddUtxos[0].privKeyHex,
        feePrivKeyHex: feeUtxo.privKeyHex, // the fee coin's own key — may differ from the owner's
        feeSats: REDEEM_FEE_SATS,
        dgbChangeScriptHex: scriptPubKeyFromAddress(p.address), // keep change visible
      }).hex;
    }
    const txid = await broadcastLogged(pendingRedeem.hex, 'redeem');
    resetRedeem();
    const short = txid.slice(0, 16) + '…';
    const label = appConfig.explorerTxUrl && /^[0-9a-f]{64}$/.test(txid)
      ? `<a href="${appConfig.explorerTxUrl}${txid}" target="_blank" rel="noopener" class="mono">${short}</a>`
      : `<span class="mono">${esc(short)}</span>`;
    $('w-rd-out').innerHTML = `Redeemed — tx ${label} The collateral returns to your DGB balance once confirmed.`;
    refreshMoney();
  }));

let moneyTimer = null;
function startMoneyPolling() {
  if (!appConfig.indexer) return;
  refreshMoney();
  clearInterval(moneyTimer);
  moneyTimer = setInterval(refreshMoney, 8000);
}

// The boot card doubles as the fatal-boot surface. A dead boot is not a wait,
// so the clip goes and only the reason stays — a looping animation over a
// wallet that will never open is a lie. (The reason stays inside #w-loading:
// verify-crosswire.mjs reads it off the card.)
function bootStuck(msg) {
  $('w-loading-msg').textContent = msg;
  $('w-loading').querySelector('.loading-clip')?.remove();
}

async function bootWallet() {
  try {
    // 'locked' covers both a v2 vault and a not-yet-migrated v1 record — the
    // unlock path migrates transparently on the first successful password.
    const st = await vault.load();
    // Vault gone but the tombstone survived (audit C2): this browser HAD a
    // wallet. Honest recovery guidance, not a fresh-install hero.
    renderTombstoneNote(st === 'none' && safeStorage.getItem(VAULT_TOMBSTONE_KEY) === '1');
    show(st === 'none' ? 'none' : 'locked');
  } catch (e) {
    bootStuck('wallet storage unavailable: ' + e.message);
  }
}

// Cross-wired backend (#64): blocking state — danger banner, CROSS-WIRED
// badge, wallet chrome hidden. Returns true when the deployment is
// cross-wired (the server refuses all RPC/indexer/faucet until fixed).
function renderCrossWire(cfg) {
  if (!cfg?.chainMismatch) return false;
  const bannerEl = $('net-banner');
  bannerEl.textContent = `SERVER MISCONFIGURED — this deployment expects ${cfg.expectedChain?.toUpperCase()} but its node is on ${cfg.chain?.toUpperCase()}. All operations are disabled; contact the operator.`;
  bannerEl.hidden = false;
  bannerEl.classList.add('danger');
  const badge = $('modeBadge');
  badge.className = 'badge mock';
  badge.textContent = 'CROSS-WIRED';
  bootStuck('wallet disabled: the server refuses to serve a mismatched network');
  show('loading');
  return true;
}

// ---- Boot ----
async function boot() {
  initCalculator();
  addPasswordToggles(); // every password field gets its eye toggle once, at boot
  addAddressTools(); // every address/gift-key field gets paste + QR-scan buttons
  // Server push (/api/events): the server watches the chain next to the node
  // and streams a `block` event the moment one lands — balances and batch
  // steps react instantly instead of waiting out a poll interval. EventSource
  // reconnects on its own; the poll loops stay as the safety net.
  try {
    const events = new EventSource('/api/events');
    events.addEventListener('block', () => {
      document.dispatchEvent(new CustomEvent('dgb:block'));
      refreshMoney();
    });
  } catch { /* no EventSource — polling covers it */ }
  // "Make a Gift key" for Core-wallet gift recipients — guest-accessible by
  // design: the recipient has no Diginaut wallet, only Core's getaddressinfo
  initGiftKeyHelper({ $, netName: () => chainState.netName, deps: { encodeGiftKey, ddTokenOutputKey, encodeDDAddress } });
  refreshStoragePersistence(false); // read-only probe; persist() is requested once a vault exists
  // Stablecoin flows (mint/transfer/redeem) are always on, as one unit — the
  // release gate (#17) removed the feature flag per ADR-0002.
  initMintTiers();
  enhanceSelect('send-asset');
  // Reflect the auto-lock choice, and reflect it from the SAME source the timer
  // reads: showing the markup's selected option while autolockDelayMs() had
  // resolved something else is how "5 minutes" stayed on screen for users whose
  // lock never armed. A garbage/stale entry falls back to the real default.
  try {
    const v = localStorage.getItem(AUTOLOCK_KEY);
    const ladder = [...$('w-autolock').options].map((o) => o.value);
    const choice = ladder.includes(v) ? v : String(autolockMinutes(v) ?? AUTOLOCK_DEFAULT_MIN);
    if (ladder.includes(choice)) $('w-autolock').value = choice;
  } catch { /* private mode → default */ }
  enhanceSelect('w-autolock');
  // Same discipline for the spend ceiling: show what the GATE will read, not
  // what the markup happens to mark selected. A select displaying "No limit"
  // while betaCapError enforces $500 would be a lie in the safer direction,
  // which is still a lie.
  renderCapSelect();
  enhanceSelect('w-txcap');
  loadPriceChart();
  setInterval(loadPriceChart, 60_000);
  try {
    const cfg = await fetchJson('/api/config', {}, 10_000, 'the wallet server');
    appConfig = { ...cfg, loaded: true };
    const badge = $('modeBadge');
    if (cfg.mock) {
      badge.className = 'badge mock';
      badge.textContent = 'MOCK MODE';
    } else {
      badge.className = 'badge real';
      badge.textContent = 'LIVE NODE';
    }
    if (cfg.faucet) $('w-faucet').style.display = 'block';
    if (cfg.version) $('app-version').textContent = cfg.version; // which build this domain runs
    // Cross-wired backend (#64): the server refuses everything, so no flow
    // can work — say exactly why in the loudest chrome we have and stop.
    if (renderCrossWire(cfg)) return; // no wallet boot, no status/oracle loops
  } catch { /* ignore */ }
  bootWallet();
  // a signed transaction whose broadcast answer was lost in a previous
  // session (page killed mid-flow) resurfaces here — never silently (audit C1)
  renderPendingTx();
  // retry until the node names its chain: a transient boot failure must not
  // strand the UI network-unknown (no addresses, no testnet banner) forever.
  // The retry also re-checks the cross-wire flag — a page loaded before the
  // server's first chain probe must still lock up once the mismatch is known.
  (async function statusLoop() {
    await loadStatus();
    if (chainState.netKnown) {
      // The chain is known, but height, softfork state and node reachability
      // all keep moving, and the header presents them as live. Keep polling —
      // slower, since this is no longer the boot retry.
      setTimeout(statusLoop, STATUS_POLL_MS);
      return;
    }
    const cfg = await fetchJson('/api/config', {}, 10_000, 'the wallet server').catch(() => null);
    if (cfg?.chainMismatch) { appConfig = { ...appConfig, ...cfg }; renderCrossWire(cfg); return; }
    setTimeout(statusLoop, 5000);
  })();
  // The oracle price was fetched once here and then presented as live for the
  // rest of the session. Everything downstream trusted it: the header figure,
  // the fiat equivalents, the mint estimate, and — worst — usdToSats, the
  // divisor a USD-denominated send is actually built from. The staleness gate
  // that should demote USD entry ran once too, so a quote could go stale and
  // nothing on screen would say so.
  //
  // A self-rescheduling timeout, not setInterval: rpc() uses bare fetch with no
  // timeout, so an interval against a stalled node stacks concurrent calls, and
  // whichever lands last wins — which can install an OLDER price than the one
  // already held. A chain cannot overlap with itself.
  (async function oracleLoop() {
    await loadOracle();
    // after a miss, recheck FAST — a blip should self-heal in seconds, not
    // sit on a red dot for a whole poll interval
    setTimeout(oracleLoop, lastOracleOk ? ORACLE_POLL_MS : 5_000);
  })();
  // network health moves with the market — keep the non-binding previews
  // honest mid-session (the review step always re-fetches anyway)
  (async function dcaLoop() {
    await loadDca();
    setTimeout(dcaLoop, DCA_POLL_MS);
  })();
}

// ---- Treasury wallets (docs/treasury-wallets-spec.md) ----
// Split wizard, dashboard, DD-intact guard, handover and GitHub backup live in
// treasury-ui.js; this is the wiring bag into app.js internals. Hooks called
// from existing flows: beforeDdTransfer (FR-4, in the transfer review),
// onWalletRemoved (marks transferredOut), onWalletRenamed (cards follow names).
const treasuryHooks = initTreasuryUi({
  $, esc, safeStorage, vault, wallet, chainState,
  appConfig: () => appConfig,
  rpc, fetchIndexer, broadcastLogged, requireReauth, busy, surfaceError,
  spendableUtxos, switchToWallet, beginBackupCeremony, createWalletEntry,
  openWalletModalRemove, refreshMoney,
  lastConfirmedDgb: () => lastConfirmedDgb,
  lastPrice: () => ({ usd: lastPriceUsd, micro: lastPriceMicroUsd }),
  MINT_FEE_SATS, ORACLE_MIN_PRICE_MICRO_USD, ORACLE_MAX_PRICE_MICRO_USD,
});

// ---- Spend DD merchant directory ----
// Read-only listing + voting in directory.js; needs only the DOM helpers and
// the shared fetch (fetchJson is module-local here, so it goes in via ctx).
initDirectory({ $, esc, fetchJson });

boot();
