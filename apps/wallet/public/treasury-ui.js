// Treasury wallets UI (docs/treasury-wallets-spec.md): split wizard (FR-1),
// dashboard (FR-2/FR-3), DD-intact guard (FR-4), handover (FR-7) and the
// GitHub backup screens (FR-8). This module ORCHESTRATES the app's existing
// internals — vault, mint flow, keystore export, broadcast log — rather than
// rebuilding them. app.js wires it with initTreasuryUi(ctx); the heavy logic
// lives in the pure sibling modules (treasuries.js, treasury-engine.js,
// ghbackup.js), which are node-tested.
import {
  LOCK_TIERS, requiredCollateralSats, generateMnemonic, validateMnemonic,
  mnemonicToSeed, deriveTaprootAddress, planSpend, planMaxSpend, buildSignedSpendTx,
  scriptPubKeyFromAddress, buildSignedMintTx, MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS,
  decodeGiftKey, ddTokenOutputKey, encodeDDAddress,
} from '/lib/index.js';
import * as keystore from '/keystore.js';
import {
  createTreasuryRegistry, treasuryName, matchesTreasury, cardStatus,
  ddIntact, collateralHealth, buildReceipt, newBatchId, CARD_STATUSES,
} from '/treasuries.js';
import { createBatchEngine, BatchAbort } from '/treasury-engine.js';
import { createGitHubBackup, pickManifestEntry } from '/ghbackup.js';
import { betaCapError } from '/netchrome.js';
import { readTxCapUsd } from '/txcap.js';
import { dcaBpsFromMultiplier } from '/dca.js';
import { MINT_FREEZE_EXPLANATION } from '/dderrors.js';

const fmtDGB = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtUSD = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const satsToDgb = (sats) => (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });
const datePlusBlocks = (blocks) => new Date(Date.now() + blocks * 15_000).toISOString().slice(0, 10);

const MAX_TREASURIES_PER_BATCH = 20; // sanity ceiling — bigger splits run as batches

/** ctx is app.js's wiring bag: vault, wallet, chainState, appConfig, rpc,
 * fetchIndexer, broadcastLogged, requireReauth, spendableUtxos, switchToWallet,
 * beginBackupCeremony, createWalletEntry, openWalletModalRemove, surfaceError,
 * lastPrice(), MINT_FEE_SATS, ORACLE_MIN/MAX_PRICE_MICRO_USD, refreshMoney. */
export function initTreasuryUi(ctx) {
  const $ = ctx.$;
  const esc = ctx.esc;
  const registry = createTreasuryRegistry(ctx.safeStorage);
  const gh = createGitHubBackup({ storage: ctx.safeStorage });
  const engine = createBatchEngine({
    registry,
    deps: {
      now: () => Date.now(),
      createWallet: async (name) => {
        const mnemonic = generateMnemonic();
        const { id } = await ctx.vault.addWallet({ name, mnemonic, backedUp: false });
        return { id, mnemonic };
      },
      receiveAddress: async (walletId) => derivationFor(walletId).address,
      confirmedSats: async (address) => {
        const { utxos } = await withRetries(() => ctx.fetchIndexer(`/address/${address}/utxos`));
        return utxos.filter((u) => u.height > 0).reduce((s, u) => s + BigInt(u.valueSats), 0n);
      },
      fund: fundTreasury,
      waitFunded,
      position: async (address) => {
        const { positions } = await withRetries(() => ctx.fetchIndexer(`/address/${address}/positions`));
        const p = positions[0];
        return p ? { txid: p.txid, ddCents: p.ddCents, collateralSats: p.collateralSats, unlockHeight: p.unlockHeight } : null;
      },
      quotePrice,
      mint: mintTreasury,
      onProgress: (batch) => { if (currentBatch?.batchId === batch.batchId) renderProgress(batch); },
    },
  });

  // ---- shared derivations ----
  function derivationFor(walletId) {
    const mnemonic = ctx.vault.getMnemonic(walletId); // throws if the wallet is gone
    return deriveTaprootAddress(mnemonicToSeed(mnemonic), { ...ctx.wallet.network, index: 0 });
  }

  function downloadText(filename, text, type = 'text/plain') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- engine deps with real I/O ----

  /** Send needSats from the OPEN wallet to the treasury's address. The signed
   * hex goes through broadcastLogged (audit C1): an ambiguous outcome is
   * recoverable, never silently rebuilt. */
  async function fundTreasury({ toAddress, amountSats }) {
    const recipientScriptHex = scriptPubKeyFromAddress(toAddress);
    const plan = planSpend({ utxos: await ctx.spendableUtxos(), amountSats, recipientScriptHex });
    const changeAddress = deriveTaprootAddress(ctx.wallet.seed, { ...ctx.wallet.network, index: ctx.wallet.index }).address;
    const { hex } = buildSignedSpendTx({
      utxos: plan.inputs,
      recipientScriptHex,
      amountSats,
      changeScriptHex: scriptPubKeyFromAddress(changeAddress),
      feeSats: plan.feeSats,
    });
    return ctx.broadcastLogged(hex, 'treasury-fund');
  }

  /** A batch step must survive a transient indexer blip — a single timed-out
   * answer pausing a mainnet batch mid-flight (live incidents 2026-07-27) is
   * worse than a few seconds of retrying. 3 attempts, growing pauses. */
  async function withRetries(fn, attempts = 3) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (e) { last = e; if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2_000 * (i + 1))); }
    }
    throw last;
  }

  async function waitFunded(address, minSats, signal) {
    for (;;) {
      if (signal?.aborted) throw new BatchAbort();
      // a failed poll is just a poll that found nothing yet — DigiByte blocks
      // are ~15s, so ask every 5s (the gift flow's cadence, not the old 10s)
      const sats = await ctx.fetchIndexer(`/address/${address}/utxos`)
        .then(({ utxos }) => utxos.filter((u) => u.height > 0).reduce((s, u) => s + BigInt(u.valueSats), 0n))
        .catch(() => null);
      if (sats != null && sats >= minSats) return;
      // sleep until the next pushed block (dgb:block via /api/events) or the
      // 10s fallback tick — whichever comes first. With push, confirmation is
      // usually detected within a second of the block instead of a poll late.
      await new Promise((resolve) => {
        const timer = setTimeout(done, 10_000);
        function done() { clearTimeout(timer); document.removeEventListener('dgb:block', done); resolve(); }
        document.addEventListener('dgb:block', done, { once: true });
      });
    }
  }

  /** Fresh oracle quote, same gates as the mint flow's review step. */
  async function quotePrice() {
    const price = await withRetries(() => ctx.rpc('getoracleprice'));
    if (!price?.price_micro_usd) throw new Error('oracle price unavailable — the node returned no quote');
    if (price.is_stale) throw new Error('the oracle price is stale — the network has not published a fresh quote; try again in a few minutes');
    const priceMicroUsd = BigInt(price.price_micro_usd);
    if (priceMicroUsd < ctx.ORACLE_MIN_PRICE_MICRO_USD || priceMicroUsd > ctx.ORACLE_MAX_PRICE_MICRO_USD) {
      throw new Error('the oracle price is outside the consensus bounds — the network would reject this mint');
    }
    return priceMicroUsd;
  }

  /** Mint ddCents from a treasury wallet, signing with ITS seed (no wallet
   * switch). Mirrors the mint flow's review gates: volatility freeze, oracle
   * restriction, DCA multiplier, single confirmed coin, fresh tip height. */
  async function mintTreasury({ walletId, ddCents, tierId, priceMicroUsd }) {
    // The engine persists batches as JSON, so ddCents arrives as a NUMBER —
    // and the lib's consensus math (requiredCollateralSats, buildSignedMintTx)
    // takes BigInt only ("Cannot mix BigInt", live incident 2026-07-27; the
    // driver's fake indexer adopts positions instead of minting, so only a
    // REAL split reaches this line). Coerce at the boundary, exactly once.
    ddCents = BigInt(ddCents);
    const d = derivationFor(walletId);
    const prot = await ctx.rpc('getprotectionstatus').catch(() => null);
    if (prot?.volatility?.minting_restricted) {
      throw new Error(MINT_FREEZE_EXPLANATION + ' Your funds are untouched — try again once the market calms.');
    }
    if (prot?.oracle?.minting_restricted) {
      throw new Error('minting is restricted: the node reports no usable oracle price — try again in a few minutes');
    }
    const dca = await withRetries(() => ctx.rpc('getdcamultiplier'));
    const dcaMultiplierBps = dcaBpsFromMultiplier(dca.multiplier);
    const collateralSats = requiredCollateralSats({ ddCents, tierId, oraclePriceMicroUsd: priceMicroUsd, dcaMultiplierBps });
    const needSats = collateralSats + ctx.MINT_FEE_SATS;
    const { utxos } = await withRetries(() => ctx.fetchIndexer(`/address/${d.address}/utxos`));
    const utxo = utxos.filter((u) => u.height > 0 && BigInt(u.valueSats) >= needSats)
      .sort((a, b) => (BigInt(a.valueSats) < BigInt(b.valueSats) ? -1 : 1))[0];
    if (!utxo) {
      // tell the truth about WHICH wait this is: an unconfirmed funding fixes
      // itself next block; a price-stranded coin fixes itself on a price
      // uptick (each retry re-quotes) or with a top-up + consolidate
      const best = utxos.filter((u) => u.height > 0).sort((a, b) => (BigInt(a.valueSats) > BigInt(b.valueSats) ? -1 : 1))[0];
      if (best) {
        const shortDgb = fmtDGB(Number(needSats - BigInt(best.valueSats)) / 1e8);
        throw new Error(`the DGB price moved against this treasury: its coin is ${shortDgb} DGB short of today's collateral. `
          + 'It mints automatically if the price ticks up — or send it that much more DGB and consolidate to finish now.');
      }
      throw new Error('the funding for this treasury has not confirmed yet — resume in a moment');
    }
    const { blocks: tipHeight } = await withRetries(() => ctx.rpc('getblockchaininfo'));
    const tier = LOCK_TIERS.find((t) => t.id === tierId) ?? LOCK_TIERS[LOCK_TIERS.length - 1];
    const unlockHeight = tipHeight + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks;
    const { hex } = buildSignedMintTx({
      utxo: { txidHex: utxo.txid, vout: utxo.vout, valueSats: BigInt(utxo.valueSats), privKeyHex: d.privKeyHex },
      privKeyHex: d.privKeyHex,
      ddCents,
      tierId,
      oraclePriceMicroUsd: priceMicroUsd,
      dcaMultiplierBps,
      tipHeight,
      feeSats: ctx.MINT_FEE_SATS,
    });
    const txid = await ctx.broadcastLogged(hex, 'treasury-mint');
    return { txid, collateralSats, unlockHeight };
  }

  // ---- FR-1: the split wizard ----
  // One decision per screen; the plan (amount, size, tier, names) lives here
  // until step 4 turns it into an engine batch.
  const wizard = {
    budgetUsd: 0, // USD of the wallet's DGB value to deploy (budget semantics, 2026-07-27)
    ddAmountEach: 100,
    tierId: LOCK_TIERS[LOCK_TIERS.length - 1].id, // 10 years: best ratio, the "matures" story
    feeReserveSats: 50_000_000n, // 0.5 DGB (FR-5 default; Advanced-editable)
    needSats: 0n,
    count: 0,
    unlockDate: '',
    names: [],
  };
  let currentBatch = null; // the batch on the progress screen
  let currentAbort = null; // AbortController for the running batch

  function setWizardStep(step) {
    for (const id of ['sp-resume', 'sp-step-1', 'sp-step-2', 'sp-step-3', 'sp-step-4', 'sp-progress']) {
      $(id).style.display = id === step ? 'block' : 'none';
    }
    for (const id of ['sp-err-1', 'sp-err-2', 'sp-err-3', 'sp-err-4', 'sp-err-5']) $(id).textContent = '';
  }

  function openSplitWizard() {
    if (!ctx.wallet.seed) return; // a locked wallet funds nothing
    $('split-modal').classList.add('open');
    // splitting needs the node (price/mint gates), the indexer (funding
    // confirmation), and an ACTIVE DigiDollar deployment
    if (!ctx.appConfig().indexer || !ctx.chainState.netKnown || ctx.chainState.ddActive === false) {
      setWizardStep('sp-step-1');
      wizardError(1, new Error('treasuries need the node, the balance index, and an active DigiDollar deployment — check the Network screen and try again.'));
      return;
    }
    const running = registry.listBatches().find((b) => b.state === 'running');
    if (running) {
      const done = running.items.filter((i) => i.state === 'done').length;
      $('sp-resume-text').textContent = `${done} of ${running.items.length} treasuries finished (${running.batchId}).`;
      setWizardStep('sp-resume');
      return;
    }
    const availDgb = ctx.lastConfirmedDgb();
    const priceUsd = ctx.lastPrice()?.usd; // {usd, micro} — the object itself is always truthy
    // what they HAVE, stated first and in both units — the question below asks
    // how much of this value to deploy
    $('sp-total').textContent = availDgb != null
      ? `Total: ${fmtDGB(availDgb)} DGB${Number.isFinite(priceUsd) ? ` = ${fmtUSD(availDgb * priceUsd)}` : ''}`
      : 'Balance unknown — the indexer has not answered yet.';
    $('sp-avail').textContent = '';
    // pre-empt the "my balance is in many small coins" worry: funding combines
    // inputs automatically (proven by the fragmented-funder driver) — the
    // mint's single coin is created by each funding tx, not needed up front
    $('sp-amount-eq').textContent = 'No need to consolidate first — funding combines your coins automatically.';
    setWizardStep('sp-step-1');
  }

  function wizardError(step, e) {
    $(`sp-err-${step}`).textContent = ctx.surfaceError(e);
  }

  function dgbToSatsLocal(text) {
    const m = String(text).trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
    if (!m) throw new Error('enter the amount as a plain number, e.g. 1500');
    return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? '').padEnd(8, '0') || '0');
  }

  /** Step 2's live numbers: how many treasuries the USD total makes, what each
   * costs in DGB, and whether the wallet's balance can actually fund them. */
  async function computePlan() {
    const priceMicroUsd = await quotePrice(); // fresh quote every entry (§8: idle > 5 min re-quotes)
    const dca = await ctx.rpc('getdcamultiplier').catch(() => null);
    const bps = dca ? dcaBpsFromMultiplier(dca.multiplier) : 10_000n;
    const ddCents = BigInt(wizard.ddAmountEach) * 100n;
    const collateralSats = requiredCollateralSats({ ddCents, tierId: wizard.tierId, oraclePriceMicroUsd: priceMicroUsd, dcaMultiplierBps: bps });
    // +2% price headroom: the mint re-quotes the LIVE oracle price, so an
    // exact-fit funding is a race against the market — a 0.3% dip between
    // funding and minting stranded a real treasury at 'funded' until the
    // price recovered (live incident 2026-07-27). The buffer is not lost:
    // the mint's change returns to the treasury's own key as fee pocket.
    wizard.needSats = collateralSats + collateralSats / 50n + ctx.MINT_FEE_SATS + wizard.feeReserveSats;
    // budget semantics: the USD budget converts to DGB at the live oracle
    // price, the balance caps it, and the count is how many treasuries fit
    wizard.budgetSats = BigInt(Math.round(wizard.budgetUsd / (Number(priceMicroUsd) / 1e6) * 1e8));
    const availDgb = ctx.lastConfirmedDgb();
    const availSats = availDgb != null ? BigInt(Math.round(availDgb * 1e8)) : null;
    const usableSats = availSats != null && availSats < wizard.budgetSats ? availSats : wizard.budgetSats;
    wizard.balanceLimited = usableSats !== wizard.budgetSats;
    wizard.requestedCount = Number(wizard.budgetSats / wizard.needSats);
    wizard.count = Number(usableSats / wizard.needSats);
    if (wizard.count > MAX_TREASURIES_PER_BATCH) wizard.count = MAX_TREASURIES_PER_BATCH;
    if (wizard.count < 1) {
      const needUsd = Number(wizard.needSats) / 1e8 * (Number(priceMicroUsd) / 1e6);
      throw new Error(`a minimum of $100 of DigiDollar per treasury is required, and its double collateral makes each `
        + `$${wizard.ddAmountEach} treasury use ≈ ${fmtUSD(needUsd)} of DGB (≈ ${fmtDGB(Number(wizard.needSats) / 1e8)} DGB)`
        + (wizard.balanceLimited ? ` — your balance covers ${fmtUSD((availDgb ?? 0) * (Number(priceMicroUsd) / 1e6))}` : ' — raise the amount'));
    }
    const { blocks: tipHeight } = await ctx.rpc('getblockchaininfo');
    const tier = LOCK_TIERS.find((t) => t.id === wizard.tierId);
    wizard.unlockDate = datePlusBlocks(1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks);
    return { priceMicroUsd, collateralSats, tier };
  }

  function renderPreview(collateralSats, tier) {
    const lines = [];
    lines.push(`<div class="row" style="border:0;padding:2px 0"><span class="k">Treasuries</span><span class="v">${wizard.count} × $${wizard.ddAmountEach} DigiDollar</span></div>`);
    lines.push(`<div class="row" style="border:0;padding:2px 0"><span class="k">Collateral per treasury</span><span class="v">≈ ${fmtDGB(Number(collateralSats) / 1e8)} DGB (${tier.ratioPercent}% of $${wizard.ddAmountEach})</span></div>`);
    lines.push(`<div class="row" style="border:0;padding:2px 0"><span class="k">Fee pocket per treasury</span><span class="v">${satsToDgb(wizard.feeReserveSats)} DGB</span></div>`);
    lines.push(`<div class="row" style="border:0;padding:2px 0"><span class="k">Total DGB needed</span><span class="v">≈ ${fmtDGB(Number(wizard.needSats) / 1e8 * wizard.count)} DGB + network fees</span></div>`);
    if (wizard.requestedCount > wizard.count) {
      const why = wizard.requestedCount > MAX_TREASURIES_PER_BATCH && wizard.count === MAX_TREASURIES_PER_BATCH
        ? `batches run ${MAX_TREASURIES_PER_BATCH} at a time — split again for the rest`
        : 'your DGB balance covers less than the budget you entered';
      lines.push(`<div class="row warn-text" style="border:0;padding:2px 0"><span class="k">Only ${wizard.count} possible</span><span class="v">you asked for ≈ ${wizard.requestedCount} — ${why}</span></div>`);
    }
    const unusedSats = wizard.budgetSats - wizard.needSats * BigInt(wizard.count);
    if (unusedSats > 100_000_000n) lines.push(`<div class="row" style="border:0;padding:2px 0"><span class="k">Unused budget</span><span class="v">≈ ${fmtDGB(Number(unusedSats) / 1e8)} DGB stays in this wallet (not enough for another whole treasury)</span></div>`);
    $('sp-preview').innerHTML = lines.join('');
  }

  $('sp-next-1').addEventListener('click', async () => {
    try {
      const usd = Number(String($('sp-amount').value).trim().replace(/^\$/, ''));
      if (!Number.isFinite(usd) || usd <= 0) throw new Error('enter the amount in US dollars, e.g. 450');
      // $100 DD is the protocol's per-treasury minimum, and its ~2× collateral
      // means no budget under ~$200 can fund one — catch the obvious case here
      // with the reminder; step 2 re-checks precisely at the live oracle price
      if (usd < 200) throw new Error('a minimum of $100 of DigiDollar is required per treasury, and each $100 treasury uses about double that in DGB — enter at least ≈ $205');
      wizard.budgetUsd = usd;
      wizard.feeReserveSats = dgbToSatsLocal($('sp-fee-reserve').value || '0.5');
      if (wizard.feeReserveSats < 10_000_000n) throw new Error('the fee pocket needs at least 0.1 DGB — a treasury without fee money can never redeem');
      setWizardStep('sp-step-2');
      $('sp-next-2').disabled = true;
      $('sp-preview').innerHTML = '<div class="hint">Getting the current oracle price…</div>';
      try {
        const { collateralSats, tier } = await computePlan();
        renderPreview(collateralSats, tier);
        $('sp-next-2').disabled = false;
      } catch (e) {
        $('sp-preview').innerHTML = '';
        wizardError(2, e);
      }
    } catch (e) {
      wizardError(1, e);
    }
  });

  $('sp-tier').innerHTML = LOCK_TIERS
    .map((t) => `<option value="${t.id}"${t.id === wizard.tierId ? ' selected' : ''}>${t.label} — ${t.ratioPercent}% collateral</option>`)
    .join('');

  for (const id of ['sp-dd', 'sp-tier']) {
    $(id).addEventListener('change', async () => {
      wizard.ddAmountEach = Number($('sp-dd').value);
      wizard.tierId = $('sp-tier').value;
      $('sp-next-2').disabled = true;
      try {
        const { collateralSats, tier } = await computePlan();
        if (wizard.count < 1) throw new Error(`your $${wizard.totalUsd} total is below the $${wizard.ddAmountEach}-per-treasury size — lower the size or go back and raise the total`);
        renderPreview(collateralSats, tier);
        $('sp-next-2').disabled = false;
        $('sp-err-2').textContent = '';
      } catch (e) {
        wizardError(2, e);
      }
    });
  }

  $('sp-next-2').addEventListener('click', () => {
    // the beta cap is per mint tx: the per-treasury DD amount is what matters
    const capErr = betaCapError(ctx.chainState.netName, wizard.ddAmountEach, readTxCapUsd());
    if (capErr) { wizardError(2, new Error(`${capErr} — lower the per-treasury amount`)); return; }
    wizard.names = Array.from({ length: wizard.count }, (_, seq) =>
      treasuryName({ ddAmount: wizard.ddAmountEach, unlockDate: wizard.unlockDate, seq }));
    $('sp-names').innerHTML = wizard.names.map((n, i) =>
      `<div class="sp-name-row"><span class="sp-seq">${String.fromCharCode(65 + (i % 26))}</span>` +
      `<input data-name-i="${i}" value="${esc(n)}" autocomplete="off" spellcheck="false" /></div>`).join('');
    setWizardStep('sp-step-3');
  });
  $('sp-back-2').addEventListener('click', () => setWizardStep('sp-step-1'));

  $('sp-next-3').addEventListener('click', () => {
    const inputs = [...document.querySelectorAll('#sp-names [data-name-i]')];
    const names = inputs.map((el) => el.value.trim());
    try {
      if (names.some((n) => !n)) throw new Error('every treasury needs a name');
      const seen = new Set();
      const existing = new Set((ctx.vault.meta()?.wallets ?? []).map((w) => w.name.trim().toLowerCase()));
      for (const n of names) {
        const k = n.toLowerCase();
        if (seen.has(k)) throw new Error(`two treasuries are named "${n}" — names must be unique`);
        if (existing.has(k)) throw new Error(`a wallet named "${n}" already exists on this device`);
        seen.add(k);
      }
      wizard.names = names;
      // the one-sentence review (spec FR-1 step 4)
      const tier = LOCK_TIERS.find((t) => t.id === wizard.tierId);
      $('sp-review').textContent =
        `This will create ${wizard.count} new wallet${wizard.count === 1 ? '' : 's'}. Each will lock ≈ ${fmtDGB(Number(wizard.needSats - ctx.MINT_FEE_SATS - wizard.feeReserveSats) / 1e8)} DGB ` +
        `for ${tier.label.toLowerCase()} and mint $${wizard.ddAmountEach} DigiDollar. Until ≈ ${wizard.unlockDate} the DGB in them cannot be spent. ` +
        'Each wallet gets its own secret backup words. Created and stored only in this browser.';
      setWizardStep('sp-step-4');
    } catch (e) {
      wizardError(3, e);
    }
  });
  $('sp-back-3').addEventListener('click', () => setWizardStep('sp-step-2'));
  $('sp-back-4').addEventListener('click', () => setWizardStep('sp-step-3'));

  // ---- progress / execution ----
  function renderProgress(batch) {
    const done = batch.items.filter((i) => i.state === 'done').length;
    $('sp-progress-title').textContent = batch.state === 'done'
      ? `All ${batch.items.length} treasuries are created. Back up their seed words from the Treasuries screen.`
      : `Creating your treasuries… ${done}/${batch.items.length}`;
    const LABEL = { pending: 'waiting', created: 'wallet made', funded: 'funded ⏳', minted: 'minted ⏳', done: 'done ✅' };
    $('sp-progress-list').innerHTML = batch.items.map((i) =>
      `<div class="sp-item"><span>${esc(i.name)}</span><span class="sp-state">${LABEL[i.state]}</span></div>`).join('');
    if (batch.state === 'done') {
      $('sp-abort').style.display = 'none';
      maybeOfferGitHubSync(batch);
    }
  }

  // ---- The unkillable runner (user demand, live incidents 2026-07-27) ----
  // A batch, once moving, keeps ITSELF alive: every engine failure that is not
  // the user's own Pause becomes a visible "retrying in Ns" line, never a
  // stop. Safe because every engine step is idempotent — it re-checks the
  // chain before sending or minting, so blind re-running cannot double-spend.
  // A screen wake-lock keeps phones from smothering the network mid-batch
  // (the actual root cause of the timeout errors), re-armed when the tab
  // returns; and a running batch auto-continues when Treasuries opens, so a
  // closed browser resumes silently instead of looking "stopped".
  let wakeLock = null;
  let loopActive = false;
  async function holdWakeLock() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported/denied — best effort */ }
  }
  function releaseWakeLock() {
    try { wakeLock?.release(); } catch { /* already gone */ }
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    // the platform silently drops the lock when the tab hides; re-arm on return
    if (document.visibilityState === 'visible' && loopActive) holdWakeLock();
  });

  async function runBatchLoop(batchId, signal) {
    if (loopActive) return; // one loop at a time — auto-continue + manual resume must not stack
    loopActive = true;
    await holdWakeLock();
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await engine.run(batchId, signal);
          $('sp-err-5').textContent = '';
          return;
        } catch (e) {
          if (e instanceof BatchAbort || e.name === 'BatchAbort' || signal.aborted) throw e;
          const wait = Math.min(5 + 5 * (attempt - 1), 30); // 5s, 10s, … capped at 30s
          $('sp-err-5').textContent = `hiccup (${ctx.surfaceError(e)}) — retrying automatically in ${wait}s, attempt ${attempt}. `
            + 'Your funds are safe; keep this screen on and it finishes by itself.';
          await new Promise((r) => setTimeout(r, wait * 1000));
          if (signal.aborted) throw new BatchAbort();
        }
      }
    } finally {
      loopActive = false;
      releaseWakeLock();
      currentBatch = registry.getBatch(batchId) ?? currentBatch;
      if (currentBatch) renderProgress(currentBatch);
      ctx.refreshMoney();
    }
  }

  async function startBatch() {
    const batch = await engine.plan({
      funderWalletId: ctx.wallet.id,
      ddCentsEach: wizard.ddAmountEach * 100,
      tierId: wizard.tierId,
      lockTierYears: Number((LOCK_TIERS.find((t) => t.id === wizard.tierId)?.label.match(/\d+/) ?? [0])[0]),
      feeReserveSats: wizard.feeReserveSats.toString(),
      needSats: wizard.needSats.toString(),
      unlockDate: wizard.unlockDate,
      names: wizard.names,
      batchId: newBatchId(registry.listBatches().map((b) => b.batchId)),
    });
    currentBatch = batch;
    setWizardStep('sp-progress');
    renderProgress(batch);
    currentAbort = new AbortController();
    $('sp-abort').style.display = 'block';
    try {
      await runBatchLoop(batch.batchId, currentAbort.signal);
    } catch (e) {
      wizardError(5, new Error('Paused. Reopen “Split into treasury wallets” anytime to resume — nothing is lost.'));
    }
  }

  $('sp-create').addEventListener('click', async () => {
    // password confirmation before the batch starts moving money (FR-1 step 4)
    if (!(await ctx.requireReauth('Confirm your password to create the treasury wallets.'))) return;
    startBatch().catch((e) => wizardError(5, e));
  });

  $('sp-abort').addEventListener('click', () => currentAbort?.abort());
  $('sp-resume-go').addEventListener('click', () => {
    const running = registry.listBatches().find((b) => b.state === 'running');
    if (!running) { openSplitWizard(); return; }
    currentBatch = running;
    setWizardStep('sp-progress');
    renderProgress(running);
    currentAbort = new AbortController();
    $('sp-abort').style.display = 'block';
    runBatchLoop(running.batchId, currentAbort.signal)
      .catch(() => wizardError(5, new Error('Paused. Reopen “Split into treasury wallets” anytime to resume — nothing is lost.')));
  });
  $('sp-resume-discard').addEventListener('click', () => {
    // "Start over" does NOT delete anything on chain or in the vault — it only
    // stops offering this batch for resume. Wallets already created stay wallets.
    const running = registry.listBatches().find((b) => b.state === 'running');
    if (running) registry.updateBatch(running.batchId, { state: 'aborted' });
    openSplitWizard();
  });

  // ---- FR-2/FR-3: the treasury dashboard ----
  let tRefreshGen = 0;

  /** Per-card live data from the indexer. A treasury holds ONE position; its
   * other UTXOs are the fee pocket (FR-5). Errors are per-card honest, never
   * a blank dashboard. */
  async function loadCardData(meta) {
    let d = null;
    try { d = derivationFor(meta.walletId); } catch { /* wallet not on this device */ }
    if (!d) return { gone: true };
    const [positionsR, ddUtxosR, utxosR] = await Promise.all([
      ctx.fetchIndexer(`/address/${d.address}/positions`),
      ctx.fetchIndexer(`/address/${d.address}/dd-utxos`),
      ctx.fetchIndexer(`/address/${d.address}/utxos`),
    ]);
    const pos = positionsR.positions.find((p) => p.txid === meta.mint?.positionTxid) ?? positionsR.positions[0] ?? null;
    const feePocketSats = utxosR.utxos.filter((u) => u.height > 0).reduce((s, u) => s + BigInt(u.valueSats), 0n);
    return {
      gone: false,
      pos,
      positionOpen: Boolean(pos),
      tipHeight: positionsR.tipHeight,
      ddCentsHeld: ddUtxosR.totalCents,
      feePocketSats,
    };
  }

  const STATUS_LABEL = {
    funded: 'Funded', locked: '🔒 Locked', 'unlocking-soon': 'Unlocking soon',
    mature: 'Mature — ready to redeem', redeemed: 'Redeemed', 'transferred-out': 'Transferred out',
  };
  const STATUS_CLASS = { funded: '', locked: 'locked', 'unlocking-soon': 'soon', mature: 'mature', redeemed: '', 'transferred-out': '' };

  function countdown(unlockDate) {
    const days = Math.ceil((new Date(unlockDate + 'T00:00:00Z') - Date.now()) / 86_400_000);
    if (days <= 0) return 'now';
    const y = Math.floor(days / 365);
    const m = Math.floor((days % 365) / 30);
    const d = days % 30;
    return [y && `${y}y`, m && `${m}m`, !y && d && `${d}d`].filter(Boolean).join(' ') || `${days}d`;
  }

  async function renderTreasuryList() {
    const gen = ++tRefreshGen;
    const query = $('t-search').value;
    const sort = $('t-sort').value;
    const all = registry.listTreasuries().filter((t) => matchesTreasury(query, t));
    const datas = new Map();
    await Promise.all(all.map(async (t) => {
      try { datas.set(t.walletId, await loadCardData(t)); } catch { datas.set(t.walletId, { error: true }); }
    }));
    if (gen !== tRefreshGen) return; // a newer render superseded this one
    const withData = all.map((t) => {
      const d = datas.get(t.walletId);
      const status = d?.error || d?.gone
        ? (t.transferredOut ? 'transferred-out' : null)
        : cardStatus(t, { tipHeight: d.tipHeight, positionOpen: d.positionOpen });
      return { t, d, status };
    });
    const STATUS_ORDER = Object.fromEntries(CARD_STATUSES.map((s, i) => [s, i]));
    withData.sort((a, b) => {
      if (sort === 'maturity') return String(a.t.mint?.unlockDateEstimate ?? '').localeCompare(String(b.t.mint?.unlockDateEstimate ?? ''));
      if (sort === 'status') return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
      return a.t.name.localeCompare(b.name);
    });

    // aggregate header (FR-2): open positions only
    const open = withData.filter((x) => x.d && !x.d.error && !x.d.gone && x.d.positionOpen);
    const totalLocked = open.reduce((s, x) => s + BigInt(x.d.pos.collateralSats), 0n);
    const totalDd = open.reduce((s, x) => s + BigInt(x.d.pos.ddCents), 0n);
    const nextMat = open.map((x) => x.t.mint?.unlockDateEstimate).filter(Boolean).sort()[0];
    $('t-agg').style.display = open.length ? 'block' : 'none';
    $('t-agg-dgb').textContent = fmtDGB(Number(totalLocked) / 1e8);
    $('t-agg-dd').textContent = (Number(totalDd) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    $('t-agg-next').textContent = nextMat ? `≈ ${nextMat} (${countdown(nextMat)})` : '—';

    $('t-empty').style.display = all.length ? 'none' : 'block';
    const price = ctx.lastPrice();
    $('t-list').innerHTML = withData.map(({ t, d, status }) => {
      const dd = t.mint ? `$${(t.mint.ddCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—';
      const rows = [];
      if (t.mint?.positionTxid) rows.push(`<div>${dd} DigiDollar minted · ${satsToDgb(BigInt(t.mint.collateralSats))} DGB locked</div>`);
      else rows.push('<div>Funded — mint not done yet</div>');
      if (t.mint?.unlockDateEstimate) {
        rows.push(`<div>Unlocks: ≈ ${esc(t.mint.unlockDateEstimate)} (${countdown(t.mint.unlockDateEstimate)})</div>`);
      }
      if (d && !d.error && !d.gone) {
        // FR-4 flag + FR-5 fee pocket + §7.3 health, all from live indexer data
        const intact = t.mint?.positionTxid ? ddIntact(t, d.ddCentsHeld) : null;
        if (intact !== null) rows.push(`<div>${intact ? '✅ DD intact' : '⚠️ DD moved — the lock needs DD bought back'}</div>`);
        rows.push(`<div>Fee pocket: ${satsToDgb(d.feePocketSats)} DGB</div>`);
        if (t.mint?.positionTxid && price.micro != null) {
          const h = collateralHealth({ collateralSats: t.mint.collateralSats, ddCents: t.mint.ddCents, priceMicroUsd: price.micro });
          if (h.level !== 'unknown') rows.push(`<div>Collateral health: ${h.ratioPercent}% ${h.level === 'good' ? '🟢' : h.level === 'warn' ? '🟡' : '🔴'}</div>`);
        }
      } else if (d?.error) {
        rows.push('<div class="warn-text">couldn’t load this treasury — reopen to retry</div>');
      } else if (d?.gone && !t.transferredOut) {
        rows.push('<div class="warn-text">this wallet is not on this device</div>');
      }
      const actions = d && !d.gone && !t.transferredOut
        ? `<div class="t-actions"><button type="button" class="secondary" data-t-open="${esc(t.walletId)}">Open</button>` +
          `<button type="button" class="secondary" data-t-backup="${esc(t.walletId)}">Back up</button>` +
          `<button type="button" class="secondary" data-t-transfer="${esc(t.walletId)}">Transfer…</button></div>`
        : '';
      return `<div class="t-card"><div class="t-head"><span class="t-name">${esc(t.name)}</span>` +
        (status ? `<span class="t-status ${STATUS_CLASS[status] ?? ''}">${STATUS_LABEL[status] ?? esc(status)}</span>` : '') +
        `</div><div class="t-rows">${rows.join('')}</div>${actions}</div>`;
    }).join('');
  }

  function openTreasuryModal() {
    $('treasury-modal').classList.add('open');
    renderTreasuryList().catch(() => {});
    // a batch interrupted by a closed tab / dead phone continues BY ITSELF the
    // moment the user is back — no resume click, nothing ever looks "stopped"
    const running = registry.listBatches().find((b) => b.state === 'running');
    if (running && !loopActive) {
      currentBatch = running;
      currentAbort = new AbortController();
      runBatchLoop(running.batchId, currentAbort.signal).catch(() => { /* paused by the user */ });
    }
  }
  $('t-search').addEventListener('input', () => renderTreasuryList().catch(() => {}));
  $('t-sort').addEventListener('change', () => renderTreasuryList().catch(() => {}));
  $('t-split-open').addEventListener('click', () => {
    $('treasury-modal').classList.remove('open');
    openSplitWizard();
  });
  $('t-gh-open').addEventListener('click', () => {
    $('treasury-modal').classList.remove('open');
    openGhModal('sync');
  });
  $('t-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-t-open],[data-t-backup],[data-t-transfer]');
    if (!btn) return;
    const id = btn.dataset.tOpen ?? btn.dataset.tBackup ?? btn.dataset.tTransfer;
    if (btn.dataset.tOpen) {
      ctx.switchToWallet(id); // FR-3: the full state reset closes this modal too
    } else if (btn.dataset.tBackup) {
      if (!(await ctx.requireReauth('Confirm your password to back up this treasury.'))) return;
      $('treasury-modal').classList.remove('open');
      ctx.beginBackupCeremony(id, ctx.vault.getMnemonic(id));
    } else if (btn.dataset.tTransfer) {
      openHandover(id);
    }
  });

  // ---- FR-4: the DD-intact guard ----
  // app.js's DD-transfer review calls this first; Cancel aborts the review.
  let guardResolve = null;
  function beforeDdTransfer(walletId) {
    const meta = registry.getTreasury(walletId);
    if (!meta) return Promise.resolve(true); // not a treasury — ordinary wallet
    if (meta.ddMovedWarning?.acknowledged) return Promise.resolve(true); // already warned this wallet
    return new Promise((resolve) => {
      guardResolve = resolve;
      $('t-guard-name').textContent = meta.name;
      $('t-guard-modal').classList.add('open');
    });
  }
  $('t-guard-go').addEventListener('click', () => {
    // the override is part of the treasury's story — a buyer must see it (FR-4)
    const id = ctx.wallet.id;
    try { registry.updateTreasury(id, { ddMovedWarning: { at: new Date().toISOString(), acknowledged: true } }); } catch { /* not a treasury after all */ }
    $('t-guard-modal').classList.remove('open');
    guardResolve?.(true);
    guardResolve = null;
  });
  $('t-guard-cancel').addEventListener('click', () => {
    $('t-guard-modal').classList.remove('open');
    guardResolve?.(false);
    guardResolve = null;
  });

  // ---- FR-7: the handover flow ----
  let handoverId = null;
  function openHandover(walletId) {
    handoverId = walletId;
    const meta = registry.getTreasury(walletId);
    $('ho-name').textContent = meta?.name ?? 'this treasury';
    $('ho-pass').value = '';
    $('ho-pass2').value = '';
    $('ho-err').textContent = '';
    $('ho-step-1').style.display = 'block';
    $('ho-step-2').style.display = 'none';
    $('handover-modal').classList.add('open');
  }

  async function exportHandover(useTransferPass) {
    const meta = registry.getTreasury(handoverId);
    if (!meta) throw new Error('this wallet is not a treasury');
    let password;
    if (useTransferPass) {
      password = $('ho-pass').value;
      if (password.length < 8) throw new Error('the transfer passphrase needs at least 8 characters');
      if (password !== $('ho-pass2').value) throw new Error('the passphrases do not match');
    } else {
      password = await ctx.requireReauth('Confirm your master password to encrypt the export with it.');
      if (!password) return;
    }
    const envelope = await keystore.buildKeystoreFile({
      name: meta.name,
      network: ctx.chainState.netKnown ? ctx.chainState.netName : null,
      mnemonic: ctx.vault.getMnemonic(handoverId),
      password,
    });
    // the handover package (FR-7.3): the encrypted wallet + a human receipt.
    // Two files, not one zip — zero-dependency rule; both downloads fire here.
    downloadText(`${meta.slug}.keystore.json`, JSON.stringify(envelope, null, 2), 'application/json');
    downloadText(`${meta.slug}-RECEIPT.txt`, buildReceipt(meta, {
      explorerTxUrl: ctx.appConfig().explorerTxUrl || '',
      network: ctx.chainState.netKnown ? ctx.chainState.netName : '',
    }));
    $('ho-step-1').style.display = 'none';
    $('ho-step-2').style.display = 'block';
    $('ho-done-text').textContent =
      `Saved ${meta.slug}.keystore.json and ${meta.slug}-RECEIPT.txt. Send both to the buyer` +
      (useTransferPass ? ' and give them the transfer passphrase over a separate channel.' : ' — they will need your master password.');
  }
  $('ho-export').addEventListener('click', (e) =>
    ctx.busy(e.target, 'ho-err', () => exportHandover(true)));
  $('ho-export-raw').addEventListener('click', (e) =>
    ctx.busy(e.target, 'ho-err', () => exportHandover(false)));
  $('ho-remove').addEventListener('click', () => {
    // removal is the existing type-the-name ceremony; onWalletRemoved (called
    // by app.js after it completes) marks transferredOut in the registry
    $('handover-modal').classList.remove('open');
    $('treasury-modal').classList.remove('open');
    ctx.openWalletModalRemove(handoverId);
  });

  function onWalletRemoved(walletId) {
    if (registry.getTreasury(walletId)) registry.markTransferredOut(walletId);
  }
  function onWalletRenamed(walletId, name) {
    // the slug stays canonical for backup filenames (FR-6); the display name follows
    if (registry.getTreasury(walletId)) registry.updateTreasury(walletId, { name });
  }

  // ---- FR-8: GitHub backup screens ----
  let ghMode = 'sync';

  function openGhModal(mode) {
    ghMode = mode;
    const connected = gh.hasToken();
    $('gh-setup').style.display = connected ? 'none' : 'block';
    $('gh-connected').style.display = connected ? 'block' : 'none';
    $('gh-restore').style.display = 'none';
    $('gh-err').textContent = '';
    $('gh-sync-err').textContent = '';
    if (connected) {
      const target = gh.savedTarget();
      $('gh-target').textContent = target ? `${target.owner}/${target.repo}` : '—';
      $('gh-status').textContent = '';
      if (mode === 'restore') showGhRestore();
    }
    $('gh-modal').classList.add('open');
  }

  $('gh-connect').addEventListener('click', (e) =>
    ctx.busy(e.target, 'gh-err', async () => {
      await gh.connect({ token: $('gh-token').value.trim(), owner: $('gh-owner').value.trim(), repo: $('gh-repo').value.trim() });
      $('gh-token').value = '';
      openGhModal(ghMode); // re-render in connected state
    }));
  $('gh-forget').addEventListener('click', () => { gh.forget(); openGhModal(ghMode); });

  /** Push every treasury's keystore (encrypted HERE, with the master password)
   * plus the manifest. One re-auth covers the whole sync. */
  async function syncGitHub(statusEl, errEl) {
    const treasuries = registry.listTreasuries().filter((t) => !t.transferredOut);
    if (!treasuries.length) { statusEl.textContent = 'No treasuries to back up yet.'; return 0; }
    const pass = await ctx.requireReauth('Confirm your password to encrypt the backup files for upload.');
    if (!pass) return 0;
    statusEl.textContent = 'Encrypting and uploading…';
    await gh.ensureReadme();
    // Only treasuries whose keystore ACTUALLY uploaded may appear in the
    // manifest with a fresh backedUpAt. A wallet not on this device is skipped
    // by the push loop, and stamping it anyway wrote an inventory entry
    // claiming an upload that never happened — the README tells users this
    // manifest IS their backup inventory, so a false entry is exactly the lie
    // that makes someone retire a device believing their keys are safe.
    const uploaded = [];
    let pushed = 0;
    for (const t of treasuries) {
      let mnemonic;
      try { mnemonic = ctx.vault.getMnemonic(t.walletId); } catch { continue; } // not on this device
      const envelope = await keystore.buildKeystoreFile({
        name: t.name,
        network: ctx.chainState.netKnown ? ctx.chainState.netName : null,
        mnemonic,
        password: pass,
      });
      await gh.pushKeystore({ walletId: t.walletId, slug: t.slug, keystoreJson: JSON.stringify(envelope, null, 2) });
      uploaded.push(t);
      pushed++;
      statusEl.textContent = `Encrypting and uploading… ${pushed}/${treasuries.length}`;
    }
    // One manifest per wallet, built ONLY from what this run uploaded. A
    // wallet with nothing uploaded gets no manifest write at all, so the file
    // the owning device last wrote stays authoritative — this also keeps two
    // devices from ever writing the same wallet's manifest. Per-wallet skips
    // are all-or-nothing (getMnemonic fails at the wallet level), so a written
    // manifest is always that wallet's complete list.
    const byWallet = new Map();
    for (const t of uploaded) {
      if (!byWallet.has(t.walletId)) byWallet.set(t.walletId, []);
      byWallet.get(t.walletId).push({
        slug: t.slug,
        walletId: t.walletId,
        name: t.name,
        ddAmount: t.mint ? t.mint.ddCents / 100 : null,
        maturity: t.mint?.unlockDateEstimate ?? null,
        backedUpAt: new Date().toISOString(),
      });
    }
    for (const [walletId, entries] of byWallet) {
      await gh.pushManifest({ walletId, treasuries: entries });
    }
    statusEl.textContent = `Backed up ${pushed} treasur${pushed === 1 ? 'y' : 'ies'} — encrypted before upload; GitHub only stores scrambled data.`;
    return pushed;
  }
  $('gh-sync').addEventListener('click', (e) =>
    ctx.busy(e.target, 'gh-sync-err', () => syncGitHub($('gh-status'), $('gh-sync-err'))));

  /** Post-batch offer (FR-8.5): only when a repo is already connected. */
  function maybeOfferGitHubSync(batch) {
    if (!gh.hasToken()) return;
    const fresh = batch.items.filter((i) => i.state === 'done').length;
    $('sp-err-5').textContent = '';
    const note = document.createElement('p');
    note.className = 'hint';
    note.innerHTML = `Back up ${fresh} new treasur${fresh === 1 ? 'y' : 'ies'} to GitHub now? `;
    const go = document.createElement('button');
    go.className = 'secondary';
    go.style.cssText = 'width:auto;margin:0 8px 0 0;padding:6px 12px;font-size:12px';
    go.textContent = 'Sync now';
    go.addEventListener('click', () => openGhModal('sync'));
    const later = document.createElement('button');
    later.className = 'secondary';
    later.style.cssText = 'width:auto;margin:0;padding:6px 12px;font-size:12px';
    later.textContent = 'Later';
    later.addEventListener('click', () => note.remove());
    note.append(go, later);
    $('sp-progress-list').after(note);
  }

  // ---- FR-8.6: restore from GitHub (device migration / fresh browser) ----
  async function showGhRestore() {
    $('gh-connected').style.display = 'none';
    $('gh-restore').style.display = 'block';
    // Fresh browser (no unlocked vault): the restore must also CREATE the
    // vault, so collect the new device master password here — the connect
    // form's own master-password fields sit unreachable behind this modal
    // (live incident: restore died on a misleading "at least 8 characters"
    // error read from the hidden, empty w-create-pass input).
    const needsVault = ctx.vault.status !== 'unlocked';
    $('gh-restore-mpass-fields').style.display = needsVault ? 'block' : 'none';
    if (needsVault) { $('gh-restore-mpass').value = ''; $('gh-restore-mpass2').value = ''; }
    const list = $('gh-restore-list');
    list.innerHTML = '<div class="hint">Reading the repository…</div>';
    try {
      const files = await gh.listKeystores();
      // Each row names its wallet folder: the namespaced layout legitimately
      // holds same-slug treasuries in different wallets, and without the tag
      // they render as byte-identical rows — ambiguity at device-loss time,
      // the worst possible moment for it. Legacy flat files say so instead.
      list.innerHTML = files.length
        ? files.map((f) =>
          `<div class="sp-item"><span class="mono">${esc(f.slug)}</span>` +
          `<span class="hint" style="margin-left:8px">${f.walletId ? `wallet …${esc(f.walletId.slice(-6))}` : 'older backup'}</span>` +
          `<button type="button" class="secondary" style="width:auto;margin:0;padding:4px 12px;font-size:12px" data-gh-path="${esc(f.path)}" data-gh-wallet="${esc(f.walletId ?? '')}">Restore</button></div>`).join('')
        : '<div class="hint">No wallet backups in this repository yet.</div>';
    } catch (e) {
      list.innerHTML = '';
      $('gh-restore-err').textContent = e.message;
    }
  }
  $('gh-restore-list').addEventListener('click', (e) =>
    (async () => {
      const btn = e.target.closest('[data-gh-path]');
      if (!btn) return;
      const errEl = $('gh-restore-err');
      errEl.textContent = '';
      btn.disabled = true;
      try {
        const pass = $('gh-restore-pass').value;
        if (!pass) throw new Error('enter the password for the backup file first');
        let masterPass;
        if (ctx.vault.status !== 'unlocked') {
          masterPass = $('gh-restore-mpass').value;
          if (masterPass.length < 8) throw new Error('choose a master password of at least 8 characters — it protects every wallet on this device');
          if (masterPass !== $('gh-restore-mpass2').value) throw new Error('the repeated master password does not match');
        }
        const text = await gh.pullKeystore(btn.dataset.ghPath);
        const envelope = keystore.parseKeystoreFile(text);
        let mnemonic;
        try {
          mnemonic = await keystore.decryptKeystoreFile(envelope, pass);
        } catch (err) {
          throw err?.name === 'OperationError' ? new Error('wrong password for this file') : err;
        }
        if (!validateMnemonic(mnemonic)) throw new Error('the file decrypted, but it does not hold a valid seed phrase');
        const { id } = await ctx.createWalletEntry({ name: envelope.name, mnemonic, backedUp: false, masterPass });
        // restore treasury metadata from the manifest — scoped to the wallet
        // folder this FILE came from, so a same-named treasury in another
        // wallet cannot lend it the wrong amounts
        await restoreTreasuryMeta(id, envelope.name, btn.dataset.ghWallet || null);
        ctx.switchToWallet(id);
        $('gh-modal').classList.remove('open');
      } catch (err) {
        errEl.textContent = ctx.surfaceError(err);
      } finally {
        btn.disabled = false;
      }
    })());

  /** After a GitHub restore, recover the treasury card from the manifest. */
  async function restoreTreasuryMeta(walletId, name, sourceWalletId = null) {
    try {
      // every wallet's manifest, plus a legacy manifest.json if one survives.
      // pickManifestEntry scopes the match to the wallet folder the restored
      // FILE came from — matching by display name across all wallets attached
      // another wallet's DD amount and unlock date when names collided.
      const manifest = await gh.readManifest();
      const entry = pickManifestEntry(manifest.treasuries, { name, sourceWalletId });
      if (!entry) return;
      registry.putTreasury({
        walletId,
        name: entry.name,
        slug: entry.slug,
        alias: '',
        batchId: 'restored-from-github',
        createdAt: new Date().toISOString(),
        mint: {
          ddCents: Math.round((entry.ddAmount ?? 0) * 100),
          lockTierYears: 0,
          collateralSats: '0',
          oraclePriceAtMint: null,
          unlockHeight: null,
          unlockDateEstimate: entry.maturity,
          positionTxid: null, // the dashboard re-discovers the live position by address
        },
        ddMovedWarning: null,
        transferredOut: false,
      });
    } catch { /* no manifest / not a treasury backup — a plain wallet restore */ }
  }

  $('w-show-gh-restore').addEventListener('click', () => openGhModal('restore'));
  $('w-gh-backup').addEventListener('click', () => openGhModal('sync'));
  $('act-treasury').addEventListener('click', openTreasuryModal);

  // ---- Mint-to-order: gift a locked treasury (owner ≠ funder) ----
  // Your DGB funds and signs the mint, but the RECIPIENT's key owns the
  // position from the first block — the giver keeps nothing and can never
  // claw it back (proven consensus-valid: docs/discovery/mint-to-order-spike.md).
  let pendingGift = null; // { recipientKeyHex, address, ddCents, tierId, collateralSats, unlockHeight, unlockDate } while confirming

  function resetGift() {
    pendingGift = null;
    $('gf-confirm').style.display = 'none';
    $('gf-review').disabled = false;
  }

  $('gf-tier').innerHTML = LOCK_TIERS
    .map((t) => `<option value="${t.id}"${t === LOCK_TIERS[LOCK_TIERS.length - 1] ? ' selected' : ''}>${t.label} — ${t.ratioPercent}% collateral</option>`)
    .join('');

  function openGiftModal() {
    if (!ctx.wallet.seed) return; // a locked wallet gifts nothing
    resetGift();
    $('gf-out').textContent = '';
    $('gf-err').textContent = '';
    $('gift-modal').classList.remove('success');
    $('gift-modal').classList.add('open');
    updateGiftEstimate();
  }
  $('t-gift-open').addEventListener('click', () => {
    $('treasury-modal').classList.remove('open');
    openGiftModal();
  });

  async function giftQuote() {
    const ddCents = BigInt(Number($('gf-dd').value)) * 100n;
    const tierId = $('gf-tier').value;
    const priceMicroUsd = await quotePrice(); // fresh quote at review, like the mint flow
    const dca = await ctx.rpc('getdcamultiplier');
    const dcaMultiplierBps = dcaBpsFromMultiplier(dca.multiplier);
    const collateralSats = requiredCollateralSats({ ddCents, tierId, oraclePriceMicroUsd: priceMicroUsd, dcaMultiplierBps });
    return { ddCents, tierId, priceMicroUsd, dcaMultiplierBps, collateralSats };
  }

  async function updateGiftEstimate() {
    const el = $('gf-estimate');
    try {
      const { collateralSats } = await giftQuote();
      el.textContent = `≈ ${fmtDGB(Number(collateralSats) / 1e8)} DGB of your wallet will be locked in this gift`;
    } catch {
      el.textContent = ''; // price momentarily unavailable — the review re-fetches
    }
  }
  $('gf-dd').addEventListener('change', updateGiftEstimate);
  $('gf-tier').addEventListener('change', updateGiftEstimate);

  $('gf-review').addEventListener('click', (e) =>
    ctx.busy(e.target, 'gf-err', async () => {
      $('gf-out').textContent = '';
      // Recipient: their GIFT KEY (ddgift1…) — the raw x-only owner key,
      // shown in their wallet under Receive. An ADDRESS cannot work here:
      // every address form carries ddTokenOutputKey(raw) — a one-way tweak —
      // so minting to one strands the DD at tweak(tweak(raw)), a script no
      // wallet watches (the address-key gift incident).
      const giftKeyStr = $('gf-to').value.trim();
      let decoded;
      try {
        decoded = decodeGiftKey(giftKeyStr);
      } catch (err) {
        if (/^(dd|td|rd)[1-9a-km-zA-HJ-NP-Z]|^(dgb|dgbt|dgbrt)1/i.test(giftKeyStr)) {
          throw new Error('that is an ADDRESS — a gifted treasury needs the recipient’s Gift key instead. '
            + 'Ask them to open their wallet → Receive → "Receiving a gifted treasury?" and send you the ddgift1… code.');
        }
        throw new Error(`invalid Gift key: ${err.message}`);
      }
      if (decoded.network !== ctx.chainState.netName) {
        throw new Error(`Gift key is not for this network (expected a ${ctx.chainState.netName} gift key)`);
      }
      // What the recipient's wallet will show this as — their DD address is
      // the tweak of the gift key, so the giver can cross-check with them.
      const recipientDDAddress = encodeDDAddress(ddTokenOutputKey(decoded.rawOwnerKeyHex), decoded.network);
      // the beta cap is per mint tx, USD-native — same guard as treasury mints
      const capErr = betaCapError(ctx.chainState.netName, Number($('gf-dd').value), readTxCapUsd());
      if (capErr) throw new Error(capErr);
      const { ddCents, tierId, priceMicroUsd, dcaMultiplierBps, collateralSats } = await giftQuote();
      // funding: ONE confirmed P2TR coin of the open wallet covering
      // collateral + fee (same single-coin rule as the mint flow). When the
      // balance is fragmented, consolidation is folded INTO the plan as
      // step 1 — reviewed here, executed by the same Confirm button — never
      // punted to a separate errand with extra clicks.
      const needSats = collateralSats + ctx.MINT_FEE_SATS;
      const utxos = await ctx.spendableUtxos();
      const confirmed = utxos.filter((u) => u.height > 0 && u.valueSats > 0n);
      const totalSats = utxos.reduce((s, u) => s + u.valueSats, 0n);
      const utxo = confirmed.filter((u) => u.type !== 'p2wpkh' && u.valueSats >= needSats)
        .sort((a, b) => (a.valueSats < b.valueSats ? -1 : 1))[0];
      let consolidate = null;
      if (!utxo) {
        if (totalSats < needSats) {
          const fmtS = (s) => fmtDGB(Number(s) / 1e8);
          throw new Error(`insufficient funds: this gift needs ${fmtS(needSats)} DGB (collateral + fee), you have ${fmtS(totalSats)} DGB`);
        }
        // fragmented (or only P2WPKH coins qualify): merge every confirmed
        // coin into one P2TR coin at the current receive address — the exact
        // plan the #103 consolidate helper uses, zero change by construction
        const current = deriveTaprootAddress(ctx.wallet.seed, { ...ctx.wallet.network, index: ctx.wallet.index });
        consolidate = {
          plan: planMaxSpend({ utxos: confirmed, recipientScriptHex: scriptPubKeyFromAddress(current.address) }),
          toAddress: current.address,
        };
      }
      const { blocks: tipHeight } = await ctx.rpc('getblockchaininfo');
      const tier = LOCK_TIERS.find((t) => t.id === tierId);
      const unlockHeight = tipHeight + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks;
      const unlockDate = datePlusBlocks(unlockHeight - tipHeight);
      pendingGift = { recipientKeyHex: decoded.rawOwnerKeyHex, recipientDDAddress, giftKeyStr, ddCents, tierId, priceMicroUsd, dcaMultiplierBps, collateralSats, utxo, consolidate, tipHeight, unlockHeight, unlockDate };
      $('gf-c-to').textContent = `${recipientDDAddress} (their wallet's address — from Gift key ${giftKeyStr.slice(0, 14)}…${giftKeyStr.slice(-6)})`;
      $('gf-c-dd').textContent = (Number(ddCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
      $('gf-c-coll').textContent = fmtDGB(Number(collateralSats) / 1e8);
      $('gf-c-unlock').textContent = `≈ ${unlockDate} (block ${unlockHeight.toLocaleString('en-US')})`;
      $('gf-c-fee').textContent = satsToDgb(ctx.MINT_FEE_SATS);
      if (consolidate) {
        $('gf-c-cons').textContent =
          `Step 1: we will consolidate your ${consolidate.plan.inputs.length} coins into one before creating the treasury ` +
          `(fee ≈ ${satsToDgb(consolidate.plan.feeSats)} DGB) — the money stays in your wallet. Step 2: the gift mint.`;
        $('gf-c-cons').style.display = 'block';
      } else {
        $('gf-c-cons').style.display = 'none';
      }
      $('gf-confirm').style.display = 'block';
      $('gf-review').disabled = true;
    }));
  $('gf-cancel').addEventListener('click', resetGift);

  $('gf-go').addEventListener('click', (e) =>
    ctx.busy(e.target, 'gf-err', async () => {
      const g = pendingGift;
      if (!g) throw new Error('nothing planned — review the gift first');
      if (!(await ctx.requireReauth('Confirm your password to mint this gift — it is irreversible.'))) return;
      // Step 1 (only when the review said so): consolidate first, same
      // transaction, then mint — the merge is a plain self-spend, so the only
      // cost is its network fee and one confirmation's wait
      if (g.consolidate) {
        $('gf-out').textContent = `Step 1: merging your ${g.consolidate.plan.inputs.length} coins into one…`;
        const script = scriptPubKeyFromAddress(g.consolidate.toAddress);
        if (!g.consolidate.hex) {
          g.consolidate.hex = buildSignedSpendTx({
            utxos: g.consolidate.plan.inputs,
            recipientScriptHex: script,
            amountSats: g.consolidate.plan.amountSats,
            changeScriptHex: script, // zero change by construction (max plan)
            feeSats: g.consolidate.plan.feeSats,
          }).hex;
        }
        await ctx.broadcastLogged(g.consolidate.hex, 'consolidate');
        $('gf-out').textContent = 'Waiting for the merge to confirm (≈15 seconds)…';
        // poll until the merged coin confirms, then re-pick the funding coin
        const needSats = g.collateralSats + ctx.MINT_FEE_SATS;
        const deadline = Date.now() + 120_000;
        let merged = null;
        while (Date.now() < deadline && !merged) {
          const utxos = await ctx.spendableUtxos();
          merged = utxos.filter((u) => u.type !== 'p2wpkh' && u.height > 0 && u.valueSats >= needSats)
            .sort((a, b) => (a.valueSats < b.valueSats ? -1 : 1))[0] ?? null;
          if (!merged) await new Promise((r) => setTimeout(r, 5_000));
        }
        if (!merged) {
          throw new Error('the merge was broadcast but has not confirmed yet — your coins are safe as one coin; retry the gift in a moment');
        }
        g.utxo = merged;
        g.tipHeight = (await ctx.rpc('getblockchaininfo')).blocks; // CLTV needs the actual tip at sign time
        g.unlockHeight = g.tipHeight + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS +
          (LOCK_TIERS.find((t) => t.id === g.tierId)?.lockBlocks ?? 0);
        $('gf-out').textContent = 'Step 2: minting your gift…';
      }
      // sign once, rebroadcast identically on retry (audit C1) — the gift mint
      // goes through the same pending-broadcast survival as every other flow
      if (!g.hex) {
        g.hex = buildSignedMintTx({
          utxo: g.utxo,
          privKeyHex: g.utxo.privKeyHex,   // the giver funds and signs…
          ownerKeyHex: g.recipientKeyHex,  // …the recipient owns from block one
          ddCents: g.ddCents,
          tierId: g.tierId,
          oraclePriceMicroUsd: g.priceMicroUsd,
          dcaMultiplierBps: g.dcaMultiplierBps,
          tipHeight: g.tipHeight,
          feeSats: ctx.MINT_FEE_SATS,
        }).hex;
      }
      const txid = await ctx.broadcastLogged(g.hex, 'gift-mint');
      lastGiftNote = buildGiftNote(g, txid);
      resetGift();
      $('gf-to').value = '';
      $('gf-out').textContent = `Gifted — tx ${txid.slice(0, 16)}…`;
      const modal = $('gift-modal');
      modal.querySelector('.tx-title').textContent = 'Gift minted';
      modal.querySelector('.tx-note').textContent = 'The recipient owns it from the first block — you cannot undo it, and they cannot unlock it before the date. Download the gift note for them below.';
      const link = modal.querySelector('.tx-link');
      link.textContent = txid.slice(0, 18) + '…' + txid.slice(-10);
      if (ctx.appConfig().explorerTxUrl && /^[0-9a-f]{64}$/.test(txid)) link.href = ctx.appConfig().explorerTxUrl + txid;
      else link.removeAttribute('href');
      modal.classList.add('success');
      ctx.refreshMoney();
    }));

  /** The gift note: a plain-text certificate the giver can hand to the
   * recipient — what they got, when it unlocks, how to verify, what they need. */
  let lastGiftNote = '';
  function buildGiftNote(g, txid) {
    const explorer = ctx.appConfig().explorerTxUrl && /^[0-9a-f]{64}$/.test(txid)
      ? `${ctx.appConfig().explorerTxUrl}${txid}` : 'any DigiByte block explorer (search the txid)';
    return [
      'A LOCKED TREASURY, MINTED FOR YOU',
      '=================================',
      '',
      `Amount:      $${(Number(g.ddCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} DigiDollar (yours to spend now — check your wallet)`,
      `Your address: ${g.recipientDDAddress} (derived from the Gift key you shared)`,
      `Locked:      ${fmtDGB(Number(g.collateralSats) / 1e8)} DGB collateral backing it`,
      `Unlocks:     approximately ${g.unlockDate} (block ${g.unlockHeight.toLocaleString('en-US')})`,
      `Position tx: ${txid}`,
      `Verify:      ${explorer}`,
      '',
      'The minted DigiDollar is at your address already. The locked DGB collateral',
      'is yours too — but only from the unlock date, and only you can release it:',
      'at maturity you burn the $100 of DigiDollar (any DigiDollar will do) and the',
      'collateral comes back to you. Keep about 0.5 DGB aside for the network fee.',
      '',
      'The giver kept no copy of the keys — this position was created with YOUR key',
      'as its owner from the first block. It is irreversible and truly yours.',
      '',
      `Wallet: https://wallet.dgbclick.com — ${new Date().toISOString().slice(0, 10)}`,
    ].join('\n');
  }
  $('gf-note').addEventListener('click', () => {
    const txidShort = lastGiftNote.match(/Position tx: ([0-9a-f]+)/)?.[1]?.slice(0, 8) ?? 'gift';
    downloadText(`dgbclick-gift-${txidShort}.txt`, lastGiftNote);
  });

  return {
    openTreasuryModal,
    openSplitWizard,
    beforeDdTransfer,
    onWalletRemoved,
    onWalletRenamed,
  };
}
