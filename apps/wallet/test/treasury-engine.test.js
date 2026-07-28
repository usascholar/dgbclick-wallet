// Treasury batch engine: resumability and idempotency under node --test.
// The chain, wallet factory, oracle and funder are all fakes over in-memory
// maps (address → confirmed sats, address → position), so "browser died"
// scenarios are simulated by deps that do the chain-visible effect and then
// throw — exactly the crash windows the engine must survive without
// double-funding or double-minting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBatchEngine, BatchAbort } from '../public/treasury-engine.js';

// Registry: prefer the real one from the sibling module once it has landed;
// until then an in-memory stub of the documented contract. (If the real
// factory expects a different storage shape than the localStorage-style
// shim below, adjust here — the stub path is what currently runs.)
let realRegistryFactory = null;
try {
  const mod = await import('../public/treasuries.js');
  realRegistryFactory = mod.createTreasuryRegistry ?? null;
} catch { /* treasuries.js has not landed yet — stub below is the contract */ }

function localStorageShim() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// In-memory stand-in for the treasuries.js registry. JSON-clones on the way
// in and out, like structured clone / localStorage do — so the engine can
// never rely on object identity with the stored records.
function memRegistry() {
  const batches = new Map();
  const treasuries = new Map();
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  return {
    saveBatch(b) { batches.set(b.batchId, clone(b)); },
    getBatch(id) { return clone(batches.get(id) ?? null); },
    updateBatch(id, patch) {
      const b = batches.get(id);
      if (!b) throw new Error(`unknown batch: ${id}`);
      batches.set(id, { ...b, ...clone(patch) });
    },
    listBatches() { return [...batches.values()].map(clone); },
    putTreasury(meta) { treasuries.set(meta.walletId, clone(meta)); },
    updateTreasury(id, patch) {
      const t = treasuries.get(id);
      if (!t) throw new Error(`unknown treasury: ${id}`);
      treasuries.set(id, { ...t, ...clone(patch) });
    },
    getTreasury(id) { return clone(treasuries.get(id) ?? null); },
    listTreasuries() { return [...treasuries.values()].map(clone); },
  };
}

function makeRegistry() {
  return realRegistryFactory ? realRegistryFactory(localStorageShim()) : memRegistry();
}

// A whole fake world: wallets, addresses, confirmed balances, DD positions,
// txids — plus invocation counters and crash flags. The flags model the two
// ugliest crash windows: chain effect landed, response (and persist) lost.
function makeHarness({ onProgress } = {}) {
  const state = {
    nextWallet: 0,
    fundTxCounter: 0,
    posTxCounter: 0,
    addrs: new Map(), // walletId → index-0 address
    confirmed: new Map(), // address → confirmed sats (bigint)
    positions: new Map(), // address → position | null
    calls: { createWallet: 0, fund: 0, waitFunded: 0, mint: 0, quotePrice: 0 },
    flags: { fundDiesAfterBroadcast: false, mintDiesAfterBroadcast: false, mintRejects: null },
    progress: [],
  };
  const deps = {
    now: () => 1_752_000_000_000, // fixed clock: deterministic ids/timestamps
    async createWallet() {
      state.calls.createWallet += 1;
      const id = `w${++state.nextWallet}`;
      state.addrs.set(id, `dgb1p-${id}`);
      return { id, mnemonic: `words for ${id}` };
    },
    async receiveAddress(walletId) {
      return state.addrs.get(walletId);
    },
    async confirmedSats(address) {
      return state.confirmed.get(address) ?? 0n;
    },
    async fund({ toAddress, amountSats }) {
      state.calls.fund += 1;
      // broadcast first — the tx is out even if the browser dies right after
      state.confirmed.set(toAddress, (state.confirmed.get(toAddress) ?? 0n) + amountSats);
      if (state.flags.fundDiesAfterBroadcast) throw new Error('browser closed right after broadcast');
      return `fundtx-${++state.fundTxCounter}`;
    },
    async waitFunded(address, minSats, signal) {
      state.calls.waitFunded += 1;
      if (signal?.aborted) throw new Error('wait aborted');
      if ((state.confirmed.get(address) ?? 0n) < minSats) throw new Error('funds never confirmed');
    },
    async position(address) {
      return state.positions.get(address) ?? null;
    },
    async quotePrice() {
      state.calls.quotePrice += 1;
      return 250_000n; // $0.250000 micro-USD per DGB
    },
    async mint({ walletId, ddCents }) {
      state.calls.mint += 1;
      if (state.flags.mintRejects) throw new Error(state.flags.mintRejects);
      // the mint tx landed on-chain even if the browser dies right after
      const pos = {
        txid: `postx-${++state.posTxCounter}`,
        ddCents,
        collateralSats: 40_000_000_000n,
        unlockHeight: 24_500_000,
      };
      state.positions.set(state.addrs.get(walletId), pos);
      if (state.flags.mintDiesAfterBroadcast) throw new Error('browser closed right after mint broadcast');
      return { txid: pos.txid, collateralSats: pos.collateralSats, unlockHeight: pos.unlockHeight };
    },
    onProgress: onProgress ?? ((b) => state.progress.push(b)),
  };
  const registry = makeRegistry();
  const engine = createBatchEngine({ registry, deps });
  return { state, deps, registry, engine };
}

const PLAN = {
  funderWalletId: 'main-wallet',
  ddCentsEach: 10_000, // $100.00 — the protocol floor
  tierId: 'y10',
  lockTierYears: 10,
  feeReserveSats: '50000000', // 0.5 DGB
  needSats: '40050000000', // ≈ 400.5 DGB: collateral + fee reserve
  unlockDate: '2036-07-21',
  names: ['Alpha', 'Bravo', 'Charlie'],
};

test('happy path: 3 treasuries end done with complete meta, batch done', async () => {
  const { state, registry, engine } = makeHarness();
  const batch = await engine.plan({ ...PLAN });
  assert.equal(batch.state, 'running');
  assert.equal(batch.items.length, 3);
  assert.deepEqual(
    batch.items.map((i) => [i.seq, i.slug, i.state, i.walletId]),
    [[1, 'alpha', 'pending', null], [2, 'bravo', 'pending', null], [3, 'charlie', 'pending', null]],
  );

  let st = await engine.status(batch.batchId);
  assert.equal(st.total, 3);
  assert.equal(st.done, 0);
  assert.equal(st.actionable.seq, 1);

  const final = await engine.run(batch.batchId);
  assert.equal(final.state, 'done');

  st = await engine.status(batch.batchId);
  assert.equal(st.done, 3);
  assert.equal(st.actionable, null);

  for (const item of final.items) {
    assert.equal(item.state, 'done');
    assert.ok(item.walletId && item.fundTxid && item.positionTxid);
    const meta = await registry.getTreasury(item.walletId);
    assert.equal(meta.batchId, batch.batchId);
    assert.equal(meta.name, item.name);
    assert.equal(meta.slug, item.slug);
    assert.equal(meta.transferredOut, false);
    assert.equal(meta.mint.ddCents, 10_000);
    assert.equal(meta.mint.lockTierYears, 10);
    assert.equal(meta.mint.collateralSats, '40000000000');
    assert.equal(meta.mint.unlockHeight, 24_500_000);
    assert.equal(meta.mint.oraclePriceAtMint, 0.25);
    assert.equal(meta.mint.unlockDateEstimate, '2036-07-21');
    assert.equal(meta.mint.positionTxid, item.positionTxid);
  }
  assert.equal(state.calls.createWallet, 3);
  assert.equal(state.calls.fund, 3);
  assert.equal(state.calls.mint, 3);
  // onProgress fires after every persisted change, batch-shaped each time
  assert.ok(state.progress.length >= 3 * 4 + 1);
  assert.ok(state.progress.every((b) => b.batchId === batch.batchId));
});

test('crash after fund broadcast, before persist: resume does not re-fund', async () => {
  const { state, registry, engine } = makeHarness();
  state.flags.fundDiesAfterBroadcast = true;
  const batch = await engine.plan({ ...PLAN, names: ['Alpha'] });

  await assert.rejects(() => engine.run(batch.batchId), /browser closed right after broadcast/);
  // the txid never reached the record — the item is still 'created'
  const crashed = await registry.getBatch(batch.batchId);
  assert.equal(crashed.state, 'running');
  assert.equal(crashed.items[0].state, 'created');
  assert.equal(crashed.items[0].fundTxid, null);

  state.flags.fundDiesAfterBroadcast = false;
  const final = await engine.run(batch.batchId);
  assert.equal(final.state, 'done');
  // the confirmedSats check saw the broadcast funds — no second fund()
  assert.equal(state.calls.fund, 1);
  assert.equal(state.calls.mint, 1);
});

test('crash mid-mint (broadcast landed, response lost): resume adopts the position', async () => {
  const { state, registry, engine } = makeHarness();
  state.flags.mintDiesAfterBroadcast = true;
  const batch = await engine.plan({ ...PLAN, names: ['Alpha'] });

  await assert.rejects(() => engine.run(batch.batchId), /browser closed right after mint broadcast/);
  const crashed = await registry.getBatch(batch.batchId);
  assert.equal(crashed.state, 'running');
  assert.equal(crashed.items[0].state, 'funded');
  assert.equal(crashed.items[0].positionTxid, null);

  state.flags.mintDiesAfterBroadcast = false;
  const final = await engine.run(batch.batchId);
  assert.equal(final.state, 'done');
  // position() found the landed mint — mint() was never called twice
  assert.equal(state.calls.mint, 1);
  assert.equal(final.items[0].positionTxid, 'postx-1');
  const meta = await registry.getTreasury(final.items[0].walletId);
  assert.equal(meta.mint.positionTxid, 'postx-1');
  assert.equal(meta.mint.collateralSats, '40000000000');
});

test('idempotent re-entry: a second run() is a no-op', async () => {
  const { state, engine } = makeHarness();
  const batch = await engine.plan({ ...PLAN });
  await engine.run(batch.batchId);
  const counts = { ...state.calls };

  const again = await engine.run(batch.batchId);
  assert.equal(again.state, 'done');
  assert.deepEqual(state.calls, counts); // not one extra wallet/fund/mint/quote
});

test('abort() between items: BatchAbort, state aborted, later run resumes and finishes', async () => {
  let engineRef = null;
  let abortSent = false;
  const { state, registry, engine } = makeHarness({
    onProgress: (b) => {
      // a Cancel button wired to the progress screen: abort the moment the
      // first treasury completes — the loop must notice at the item boundary
      if (!abortSent && b.items.some((i) => i.state === 'done')) {
        abortSent = true;
        engineRef.abort(b.batchId);
      }
    },
  });
  engineRef = engine;
  const batch = await engine.plan({ ...PLAN });

  const err = await engine.run(batch.batchId).catch((e) => e);
  assert.ok(err instanceof BatchAbort);
  assert.equal(err.name, 'BatchAbort');

  const stopped = await registry.getBatch(batch.batchId);
  assert.equal(stopped.state, 'aborted');
  assert.equal(stopped.items[0].state, 'done');
  assert.equal(stopped.items[1].state, 'pending');
  assert.equal(state.calls.fund, 1);

  const final = await engine.run(batch.batchId); // aborted → resumes
  assert.equal(final.state, 'done');
  assert.ok(final.items.every((i) => i.state === 'done'));
  assert.equal(state.calls.fund, 3);
  assert.equal(state.calls.mint, 3);
});

test('run() with a pre-aborted signal throws BatchAbort and marks the batch aborted', async () => {
  const { registry, engine } = makeHarness();
  const batch = await engine.plan({ ...PLAN, names: ['Alpha'] });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => engine.run(batch.batchId, ctrl.signal), BatchAbort);
  assert.equal((await registry.getBatch(batch.batchId)).state, 'aborted');
});

test('plan() validation: names, $100 floor, satoshi sanity', async () => {
  const { engine } = makeHarness();
  await assert.rejects(() => engine.plan({ ...PLAN, names: [] }), /at least one treasury name/);
  await assert.rejects(() => engine.plan({ ...PLAN, names: ['  '] }), /non-empty/);
  await assert.rejects(() => engine.plan({ ...PLAN, names: ['Alpha', 'alpha'] }), /duplicate/);
  await assert.rejects(() => engine.plan({ ...PLAN, ddCentsEach: 9_999 }), /protocol floor/);
  await assert.rejects(() => engine.plan({ ...PLAN, ddCentsEach: 10_000.5 }), /protocol floor/);
  await assert.rejects(() => engine.plan({ ...PLAN, needSats: 'not-a-number' }), /integer satoshi/);
  await assert.rejects(() => engine.plan({ ...PLAN, needSats: '0' }), /needSats must be > 0/);
  await assert.rejects(() => engine.plan({ ...PLAN, feeReserveSats: '-1' }), /≥ 0/);
});

test('mint error (volatility reject) leaves the batch resumable at the same step', async () => {
  const { state, registry, engine } = makeHarness();
  state.flags.mintRejects = 'oracle volatility reject — try again later';
  const batch = await engine.plan({ ...PLAN, names: ['Alpha'] });

  // the ORIGINAL error propagates — not wrapped, not swallowed
  const err = await engine.run(batch.batchId).catch((e) => e);
  assert.equal(err.message, 'oracle volatility reject — try again later');
  const mid = await registry.getBatch(batch.batchId);
  assert.equal(mid.state, 'running'); // not aborted, not done: resumable
  assert.equal(mid.items[0].state, 'funded'); // pre-mint state preserved
  assert.equal(mid.items[0].positionTxid, null);

  state.flags.mintRejects = null; // volatility passed — fixed dep set
  const final = await engine.run(batch.batchId);
  assert.equal(final.state, 'done');
  assert.equal(state.calls.mint, 2); // one reject + one success, no duplicate position
  assert.equal(state.calls.fund, 1);
});

test('crash at minted→meta-write: cold resume re-derives mint facts from the chain', async () => {
  const { state, registry, engine } = makeHarness();
  const batch = await engine.plan({ ...PLAN, names: ['Alpha'] });

  // kill the browser exactly when the completed meta is being written
  const realUpdate = registry.updateTreasury.bind(registry);
  let die = true;
  registry.updateTreasury = (id, patch) => {
    if (die) {
      die = false;
      throw new Error('browser died writing treasury meta');
    }
    return realUpdate(id, patch);
  };

  await assert.rejects(() => engine.run(batch.batchId), /browser died writing treasury meta/);
  const mid = await registry.getBatch(batch.batchId);
  assert.equal(mid.items[0].state, 'minted');
  assert.equal(mid.items[0].positionTxid, 'postx-1');

  const final = await engine.run(batch.batchId);
  assert.equal(final.state, 'done');
  assert.equal(state.calls.mint, 1); // no re-mint on the cold resume
  const meta = await registry.getTreasury(final.items[0].walletId);
  assert.equal(meta.mint.positionTxid, 'postx-1');
  assert.equal(meta.mint.collateralSats, '40000000000'); // from position(), not session memory
  assert.equal(meta.mint.unlockHeight, 24_500_000);
  assert.equal(meta.mint.oraclePriceAtMint, null); // unknowable after the crash — stated, not invented
});
