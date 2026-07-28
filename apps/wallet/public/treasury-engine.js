// Treasury batch engine — the resumable executor behind the "Split into
// Treasuries" wizard (docs/treasury-wallets-spec.md FR-1). Real funds move
// here, so the design rule is: the batch record is the source of truth for
// WHERE we are, but the CHAIN is the source of truth for WHAT already
// happened. Every state transition is persisted before the next one starts
// (the browser can die between any two steps), and both money-moving steps
// re-check the chain before acting:
//   - funding: confirmedSats(addr) is checked BEFORE fund() even when the
//     item already carries a fundTxid — a crash after broadcast-but-before-
//     persist must never re-send. (fund() itself persists signed hex before
//     broadcast; this layer's job is the on-chain check.)
//   - minting: position(addr) is checked UNCONDITIONALLY before mint() — an
//     existing position covering ddCentsEach is adopted, never duplicated.
// A non-abort error leaves the batch 'running' with the item mid-state, so a
// later run(batchId) resumes at exactly the failed step.
//
// All side effects go through injected deps (the browser wires real wallet/
// chain/oracle calls, tests wire fakes), so the whole state machine runs
// under node --test. Registry calls are always awaited, so both a sync
// (localStorage-style) and an async registry satisfy the contract.

// ITEM_STATES is owned by the sibling module treasuries.js (the registry).
// The two modules are built concurrently, so this import is dynamic with a
// literal fallback: the engine must stay loadable — and testable — whether
// or not treasuries.js has landed yet. The fallback mirrors the registry
// contract exactly; once the module exists, its values win. Arrays or
// objects with any key casing are normalised to an UPPER-keyed map.
const FALLBACK_ITEM_STATES = Object.freeze({
  PENDING: 'pending', CREATED: 'created', FUNDED: 'funded', MINTED: 'minted', DONE: 'done',
});
function normalizeItemStates(s) {
  if (Array.isArray(s)) {
    return Object.freeze(Object.fromEntries(s.map((v) => [String(v).toUpperCase(), v])));
  }
  if (s && typeof s === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(s).map(([k, v]) => [k.toUpperCase(), v]),
    ));
  }
  return null;
}
let ITEM_STATES = FALLBACK_ITEM_STATES;
try {
  const mod = await import('./treasuries.js');
  ITEM_STATES = normalizeItemStates(mod.ITEM_STATES) ?? FALLBACK_ITEM_STATES;
} catch { /* treasuries.js not on disk yet — the fallback above IS the contract */ }
const ST = ITEM_STATES;

/** Thrown by run() when the batch is aborted (signal or abort()). */
export class BatchAbort extends Error {
  constructor(message = 'treasury batch aborted') {
    super(message);
    this.name = 'BatchAbort';
  }
}

// Satoshi/cent fields cross the storage boundary as strings (BigInt is not
// JSON-safe); accept bigint | integer number | integer string and reject
// everything else loudly, because a quiet NaN here moves real DGB.
function asSats(value, field) {
  let out;
  try {
    out = BigInt(value);
  } catch {
    throw new Error(`${field} must be an integer satoshi amount, got: ${value}`);
  }
  if (out < 0n) throw new Error(`${field} must be ≥ 0, got: ${value}`);
  return out;
}

// Slugs come from the display name (FR-6 keeps them in metadata forever, so
// backups and searches stay stable even after a rename). Lowercase, dashed,
// de-duplicated within the batch by sequence suffix.
function slugify(name, seq, taken) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'treasury';
  let slug = base;
  if (taken.has(slug)) slug = `${base}-${seq}`;
  taken.add(slug);
  return slug;
}

export function createBatchEngine({ registry, deps }) {
  const isoNow = () => new Date(deps.now()).toISOString();
  const progress = (batch) => deps.onProgress?.(structuredClone(batch));

  // Two patch shapes, deliberately narrow: item transitions never touch the
  // batch state field and vice versa — so a cooperative abort() landing
  // mid-batch is never clobbered by an in-flight item persist.
  async function saveItems(batch) {
    await registry.updateBatch(batch.batchId, { items: batch.items });
    progress(batch);
  }
  async function saveState(batch) {
    await registry.updateBatch(batch.batchId, { state: batch.state });
    progress(batch);
  }

  const throwIfAborted = (signal) => {
    if (signal?.aborted) throw new BatchAbort();
  };

  /**
   * Create a batch with every item 'pending' and persist it. Validates
   * before anything is stored: at least one name, unique non-empty names,
   * ddCentsEach at/above the $100 protocol floor (10_000 cents — verified
   * against DD_TX_LIMITS.mainnet.minMintCents, spec §10 Q2), and all
   * satoshi fields BigInt-able and sane.
   */
  async function plan({
    funderWalletId, ddCentsEach, tierId, lockTierYears, feeReserveSats,
    needSats, unlockDate, names, batchId,
  }) {
    if (!Array.isArray(names) || names.length < 1) {
      throw new Error('plan needs at least one treasury name');
    }
    const cleanNames = names.map((n) => String(n ?? '').trim());
    if (cleanNames.some((n) => !n)) throw new Error('treasury names must be non-empty');
    const seen = new Set();
    for (const n of cleanNames) {
      const key = n.toLowerCase();
      if (seen.has(key)) throw new Error(`duplicate treasury name: "${n}"`);
      seen.add(key);
    }
    if (!Number.isInteger(ddCentsEach) || ddCentsEach < 10_000) {
      throw new Error(`ddCentsEach ${ddCentsEach} is below the $100 protocol floor (10000 cents)`);
    }
    if (tierId == null || tierId === '') throw new Error('plan needs a lock tierId');
    if (lockTierYears != null && (!Number.isFinite(lockTierYears) || lockTierYears < 0)) {
      throw new Error(`lockTierYears must be a non-negative number, got: ${lockTierYears}`);
    }
    const fee = asSats(feeReserveSats, 'feeReserveSats');
    const need = asSats(needSats, 'needSats');
    if (need <= 0n) throw new Error('needSats must be > 0');

    const takenSlugs = new Set();
    const batch = {
      batchId: batchId ?? `batch-${deps.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: isoNow(),
      funderWalletId,
      ddCentsEach,
      tierId,
      // Not in the minimal registry contract, but needed to complete
      // treasury meta after a cold resume (post-browser-death). The stub
      // meta written at 'created' also carries it, so a registry that
      // strips unknown batch fields only degrades, never breaks.
      lockTierYears: lockTierYears ?? null,
      feeReserveSats: String(fee),
      needSats: String(need),
      unlockDate: unlockDate ?? null,
      state: 'running',
      items: cleanNames.map((name, i) => ({
        seq: i + 1,
        name,
        slug: slugify(name, i + 1, takenSlugs),
        state: ST.PENDING,
        walletId: null,
        fundTxid: null,
        positionTxid: null,
      })),
    };
    await registry.saveBatch(batch);
    progress(batch);
    return batch;
  }

  /** Truthful snapshot for the resume screen: what's left, if anything. */
  async function status(batchId) {
    const batch = await registry.getBatch(batchId);
    if (!batch) throw new Error(`unknown batch: ${batchId}`);
    const done = batch.items.filter((i) => i.state === ST.DONE).length;
    return {
      batch,
      total: batch.items.length,
      done,
      actionable: batch.items.find((i) => i.state !== ST.DONE) ?? null,
    };
  }

  // Drive one item from wherever it is to 'done', persisting after EVERY
  // transition. `mintInfo` carries this session's mint facts (collateral,
  // unlock height, oracle price) from the funded→minted step into the
  // minted→done meta write; on a cold resume at 'minted' it is null and the
  // facts are re-derived from the chain instead — never invented locally.
  async function driveItem(batch, item, signal) {
    let mintInfo = null;
    while (item.state !== ST.DONE) {
      throwIfAborted(signal);
      switch (item.state) {
        case ST.PENDING: {
          // walletId is persisted BEFORE the state flips, so a resume here
          // may find it already set — never create a second wallet.
          if (item.walletId == null) {
            const w = await deps.createWallet(item.name);
            item.walletId = w.id;
            await saveItems(batch);
          }
          if (!(await registry.getTreasury(item.walletId))) {
            await registry.putTreasury({
              walletId: item.walletId,
              name: item.name,
              slug: item.slug,
              alias: '',
              batchId: batch.batchId,
              createdAt: isoNow(),
              mint: {
                ddCents: batch.ddCentsEach,
                lockTierYears: batch.lockTierYears ?? null,
                collateralSats: '0', // unknown until the mint lands
                oraclePriceAtMint: null,
                unlockHeight: null,
                unlockDateEstimate: batch.unlockDate ?? null,
                positionTxid: null,
              },
              ddMovedWarning: null,
              transferredOut: false,
            });
          }
          item.state = ST.CREATED;
          await saveItems(batch);
          break;
        }
        case ST.CREATED: {
          const addr = await deps.receiveAddress(item.walletId);
          const need = BigInt(batch.needSats);
          // Chain first, ALWAYS — even with a fundTxid on record. Only an
          // address that verifiably lacks the funds is (re-)funded.
          if ((await deps.confirmedSats(addr)) < need) {
            if (item.fundTxid == null) {
              item.fundTxid = await deps.fund({ toAddress: addr, amountSats: need });
              await saveItems(batch); // txid persisted before the state flips
            }
          }
          item.state = ST.FUNDED;
          await saveItems(batch);
          break;
        }
        case ST.FUNDED: {
          const addr = await deps.receiveAddress(item.walletId);
          const need = BigInt(batch.needSats);
          await deps.waitFunded(addr, need, signal);
          throwIfAborted(signal);
          // Chain first, UNCONDITIONALLY: a position already covering
          // ddCentsEach (ours from a crashed run, or anyone's) is adopted.
          const pos = await deps.position(addr);
          if (pos && BigInt(pos.ddCents) >= BigInt(batch.ddCentsEach)) {
            item.positionTxid = pos.txid;
            mintInfo = {
              collateralSats: String(pos.collateralSats),
              unlockHeight: pos.unlockHeight ?? null,
              oraclePriceAtMint: null, // minted outside this session — unknowable
            };
          } else {
            // Fresh quote per mint: a resumed batch may be hours old, and
            // collateral math must use the live oracle price (spec §3.5).
            const priceMicroUsd = await deps.quotePrice();
            const m = await deps.mint({
              walletId: item.walletId,
              ddCents: batch.ddCentsEach,
              tierId: batch.tierId,
              priceMicroUsd,
            });
            item.positionTxid = m.txid;
            mintInfo = {
              collateralSats: String(m.collateralSats),
              unlockHeight: m.unlockHeight ?? null,
              oraclePriceAtMint: Number(priceMicroUsd) / 1e6,
            };
          }
          await saveItems(batch); // positionTxid persisted before the state flips
          item.state = ST.MINTED;
          await saveItems(batch);
          break;
        }
        case ST.MINTED: {
          if (!mintInfo) {
            // Cold resume at 'minted': the mint facts died with the last
            // session, so re-read them from the chain. If the position is
            // not visible yet (indexer lag) we throw — the batch stays
            // 'running' and a later run() retries, rather than writing
            // made-up meta into a record a buyer may rely on.
            const addr = await deps.receiveAddress(item.walletId);
            const pos = await deps.position(addr);
            if (!pos) {
              throw new Error(`position for treasury "${item.name}" not visible on-chain yet`);
            }
            mintInfo = {
              collateralSats: String(pos.collateralSats),
              unlockHeight: pos.unlockHeight ?? null,
              oraclePriceAtMint: null,
            };
          }
          const prev = await registry.getTreasury(item.walletId);
          await registry.updateTreasury(item.walletId, {
            mint: {
              ddCents: batch.ddCentsEach,
              lockTierYears: prev?.mint?.lockTierYears ?? batch.lockTierYears ?? null,
              collateralSats: mintInfo.collateralSats,
              oraclePriceAtMint: mintInfo.oraclePriceAtMint,
              unlockHeight: mintInfo.unlockHeight,
              unlockDateEstimate: batch.unlockDate ?? prev?.mint?.unlockDateEstimate ?? null,
              positionTxid: item.positionTxid,
            },
          });
          item.state = ST.DONE;
          await saveItems(batch);
          break;
        }
        default:
          throw new Error(`unknown item state: ${item.state}`);
      }
    }
  }

  /**
   * The resumable loop. Resolves with the batch once state is 'done';
   * throws BatchAbort on abort (batch left 'aborted'); rethrows any other
   * error with the batch left 'running' and the item mid-state, so a later
   * run() resumes exactly there. run() on a 'done' batch is a no-op;
   * run() on an 'aborted' batch resumes it.
   */
  async function run(batchId, signal) {
    const batch = await registry.getBatch(batchId);
    if (!batch) throw new Error(`unknown batch: ${batchId}`);
    if (batch.state === 'done') return batch;
    try {
      if (batch.state !== 'running') {
        batch.state = 'running';
        await saveState(batch);
      }
      for (const item of batch.items) {
        throwIfAborted(signal);
        // Cooperative abort(): another caller flipped the STORED record to
        // 'aborted' (our item patches never touch state, so it survives).
        // Notice it at the item boundary — never mid-transaction.
        const fresh = await registry.getBatch(batchId);
        if (fresh && fresh.state === 'aborted') throw new BatchAbort();
        if (item.state === ST.DONE) continue;
        await driveItem(batch, item, signal);
      }
      batch.state = 'done';
      await saveState(batch);
      return batch;
    } catch (err) {
      if (err instanceof BatchAbort || signal?.aborted) {
        batch.state = 'aborted';
        await saveState(batch);
        throw err instanceof BatchAbort ? err : new BatchAbort();
      }
      throw err;
    }
  }

  /**
   * Cooperative stop: flips the stored state to 'aborted'. A running loop
   * notices via its signal or at the next item boundary; a done batch is
   * left alone. Safe to call from a progress callback or a Cancel button.
   */
  async function abort(batchId) {
    const batch = await registry.getBatch(batchId);
    if (!batch) throw new Error(`unknown batch: ${batchId}`);
    if (batch.state !== 'done' && batch.state !== 'aborted') {
      await registry.updateBatch(batchId, { state: 'aborted' });
      batch.state = 'aborted';
      progress(batch);
    }
    return batch;
  }

  return { plan, status, run, abort };
}
