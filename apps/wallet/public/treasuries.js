// Treasury registry — local metadata bookkeeper for treasury wallets
// (docs/treasury-wallets-spec.md FR-1/FR-2/FR-4/FR-6/FR-7). A treasury is an
// ordinary vault wallet that locked DGB and minted ≥ $100 of DigiDollar; this
// module only tracks METADATA about it (name, mint facts, batch state) plus
// resumable split-batch records. It never holds keys — walletId points into
// the vault, and nothing secret may ever be written here, so that the store
// can later be mirrored into unencrypted listings (GitHub manifest) safely.
// Storage is injected (localStorage in the browser, a Map stand-in in tests)
// and every read goes through a forgiving parser: a corrupted store must
// never crash boot — worst case the dashboard starts empty, the wallets
// themselves live in the vault and on-chain.
//
// CANONICAL AMOUNT STORAGE: DigiDollar amounts are stored as CENTS
// (mint.ddCents, number — the unit the chain speaks). FR-6's prose example
// showed dollars (ddAmount); helpers here accept that legacy shape too, but
// writers must store cents.

export const TREASURY_STORE_KEY = 'diginaut.treasuries.v1';

// Execution state of one treasury inside a split batch (FR-1 resume).
export const ITEM_STATES = ['pending', 'created', 'funded', 'minted', 'done'];

// Dashboard card statuses (FR-2), in the priority cardStatus() applies them.
export const CARD_STATUSES = ['funded', 'locked', 'unlocking-soon', 'mature', 'redeemed', 'transferred-out'];

// 90 days at 15s blocks — the "unlocking soon" horizon (spec FR-2, §10 Q5).
export const UNLOCKING_SOON_BLOCKS = 518_400;

// The FR-6 self-describing name: DD{amount}-{maturity}-{seq} [– alias].
// The structured prefix is what keeps dashboards, backup folders and repo
// listings searchable; the alias is display-only sugar after it.
const CANONICAL_PREFIX = /^DD(\d+)-(\d{4}-\d{2}-\d{2})-([A-Z]+)\b/;

/** Spreadsheet-style sequence letters: 0→'A', 25→'Z', 26→'AA', 27→'AB'. */
export function seqLetters(i) {
  if (!Number.isInteger(i) || i < 0) {
    throw new Error(`sequence index must be a non-negative integer, got: ${i}`);
  }
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Build the canonical treasury name: 'DD100-2036-07-21-A'. */
export function treasuryName({ ddAmount, unlockDate, seq }) {
  if (!Number.isInteger(ddAmount) || ddAmount < 1) {
    throw new Error(`ddAmount must be a positive integer (whole DD dollars), got: ${ddAmount}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(unlockDate ?? ''))) {
    throw new Error(`unlockDate must be YYYY-MM-DD, got: ${unlockDate}`);
  }
  return `DD${ddAmount}-${unlockDate}-${seqLetters(seq)}`;
}

/** Lowercased canonical prefix, usable as backup filename / manifest key.
 * An alias-only display name ("Mum's gift") has no slug of its own — the
 * caller must fall back to the slug stored in the treasury's metadata. */
export function treasurySlug(name) {
  const m = CANONICAL_PREFIX.exec(String(name ?? '').trim());
  if (!m) throw new Error(`no canonical treasury prefix in name: ${name}`);
  return m[0].toLowerCase();
}

/** Inverse of treasuryName (alias suffix tolerated). null when non-conforming. */
export function parseTreasuryName(name) {
  const m = CANONICAL_PREFIX.exec(String(name ?? '').trim());
  if (!m) return null;
  return { ddAmount: Number(m[1]), unlockDate: m[2], seq: m[3] };
}

/** 'split-2026-07-26-001', incrementing the day's counter past existing ids. */
export function newBatchId(existingIds, date = new Date()) {
  const prefix = `split-${date.toISOString().slice(0, 10)}-`;
  let max = 0;
  for (const id of existingIds ?? []) {
    if (typeof id !== 'string' || !id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

// Minted DD in whole dollars, from either the canonical cents storage or the
// legacy FR-6 dollars field. null when the record predates both.
function ddDollarsOf(mint) {
  if (!mint) return null;
  if (mint.ddCents != null) return mint.ddCents / 100;
  if (mint.ddAmount != null) return mint.ddAmount;
  return null;
}

/** Dashboard search (FR-6): case-insensitive substring over every searchable
 * facet — name, slug, alias, maturity estimate, the amount as 'dd100' and as
 * '100', and the batch id. Blank query matches everything. */
export function matchesTreasury(query, meta) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const dd = ddDollarsOf(meta?.mint);
  const haystacks = [
    meta?.name, meta?.slug, meta?.alias, meta?.batchId,
    meta?.mint?.unlockDateEstimate,
    dd != null ? `dd${dd}` : null,
    dd != null ? `${dd}` : null,
  ];
  return haystacks.some((h) => h != null && String(h).toLowerCase().includes(q));
}

/** FR-2 card status. Priority matters: a transferred-out record stays
 * transferred-out forever; a position the indexer no longer returns is
 * redeemed (its collateral was spent) even if the lock hasn't expired. */
export function cardStatus(meta, { tipHeight, positionOpen } = {}) {
  if (meta?.transferredOut) return 'transferred-out';
  const mint = meta?.mint;
  if (!mint?.positionTxid) return 'funded';
  if (positionOpen === false) return 'redeemed';
  if (Number.isFinite(tipHeight) && Number.isFinite(mint.unlockHeight)) {
    if (tipHeight >= mint.unlockHeight) return 'mature';
    if (mint.unlockHeight - tipHeight <= UNLOCKING_SOON_BLOCKS) return 'unlocking-soon';
  }
  return 'locked';
}

/** FR-4 integrity check: does the wallet still hold at least the minted DD?
 * BigInt-safe (chain amounts arrive as strings). Accepts the canonical
 * mint.ddCents (cents) and the legacy mint.ddAmount (dollars). */
export function ddIntact(meta, ddCentsHeld) {
  const mint = meta?.mint;
  if (!mint) return false;
  let required;
  if (mint.ddCents != null) required = BigInt(Math.round(Number(mint.ddCents)));
  else if (mint.ddAmount != null) required = BigInt(Math.round(Number(mint.ddAmount) * 100));
  else return false;
  let held;
  try {
    held = BigInt(ddCentsHeld);
  } catch {
    return false;
  }
  return held >= required;
}

/** FR-2/§7.3 health indicator: collateral USD value ÷ DD liability, percent.
 * priceMicroUsd is µUSD per DGB (oracle price × 1e6). An unavailable price
 * yields 'unknown', not 'bad' — missing data is not a fire alarm. */
export function collateralHealth({ collateralSats, ddCents, priceMicroUsd }) {
  const unknown = { ratioPercent: null, level: 'unknown' };
  try {
    if (priceMicroUsd == null) return unknown;
    const sats = BigInt(collateralSats);
    const cents = BigInt(ddCents);
    const price = BigInt(priceMicroUsd);
    if (price <= 0n || cents <= 0n || sats < 0n) return unknown;
    // collateralUsd = sats·price/1e14; liabilityUsd = cents/100
    // ratio% = sats·price / (cents·1e10); keep one decimal via ×10 rounding.
    const num = sats * price;
    const den = cents * 10_000_000_000n;
    const scaled = (num * 20n + den) / (den * 2n); // round(ratio% × 10)
    return {
      ratioPercent: Number(scaled) / 10,
      level: scaled >= 2000n ? 'good' : scaled >= 1300n ? 'warn' : 'bad',
    };
  } catch {
    return unknown;
  }
}

// 1 DGB = 1e8 sats; grouped thousands, trailing fraction zeros trimmed.
function formatDgb(sats) {
  try {
    const s = BigInt(sats);
    const whole = s / 100_000_000n;
    const frac = (s % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
    const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${grouped}.${frac}` : grouped;
  } catch {
    return String(sats);
  }
}

/** FR-7 RECEIPT.txt for the handover package. Plain text, public facts only —
 * meta carries no key/seed/password material and this must keep it that way.
 * The honesty paragraph (seller may retain a copy of the backup words) is
 * mandatory: a wallet transfer is key handover, not a trustless sale. */
export function buildReceipt(meta, { explorerTxUrl = '', network = '' } = {}) {
  const mint = meta?.mint ?? {};
  const dd = ddDollarsOf(mint);
  const txid = mint.positionTxid ?? '(position not minted yet)';
  const verify = explorerTxUrl && mint.positionTxid
    ? `  ${explorerTxUrl}${mint.positionTxid}`
    : '  Open any DigiByte explorer and search the position txid above.';
  const lines = [
    'DigiDollar Treasury — Handover Receipt',
    '======================================',
    '',
    `Treasury:    ${meta?.name ?? '(unnamed)'}`,
    `Minted:      $${dd ?? '?'} DigiDollar (DD)`,
    `Locked:      ${formatDgb(mint.collateralSats ?? 0)} DGB collateral (time-locked)`,
    `Unlock date: ≈ ${mint.unlockDateEstimate ?? 'unknown'} (estimate; block height ${mint.unlockHeight ?? 'unknown'})`,
    `Position:    ${txid}`,
  ];
  if (network) lines.push(`Network:     ${network}`);
  lines.push(
    '',
    'Verify the position',
    '-------------------',
    'Anyone can verify this position on a block explorer — no password or login needed:',
    verify,
    '',
    'How to restore this wallet',
    '--------------------------',
    '1. Open https://wallet.dgbclick.com in a browser.',
    '2. Choose "Get started".',
    '3. Choose "Restore from backup file".',
    '4. Pick the .keystore.json file from this handover package.',
    '5. Enter the transfer passphrase the seller shared with you.',
    '',
    'A wallet transfer is not trustless',
    '----------------------------------',
    'WARNING: the seller may have kept a copy of the backup words.',
    'Deleting their copy does not prove they forgot the keys. Only buy from',
    'someone you trust, or use escrow.',
    '',
    'This receipt holds no keys, passwords, or backup words — public facts only.',
    '',
  );
  return lines.join('\n');
}

/** Local treasury + batch bookkeeping over injected storage
 * ({ getItem, setItem, removeItem }). One JSON document; every write persists
 * immediately. Corrupt or absent JSON reads as an empty document — boot must
 * never die on bookkeeping data. */
export function createTreasuryRegistry(storage) {
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const emptyDoc = () => ({ v: 1, treasuries: {}, batches: {} });

  function load() {
    try {
      const raw = storage.getItem(TREASURY_STORE_KEY);
      if (!raw) return emptyDoc();
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object') return emptyDoc();
      return {
        v: 1,
        treasuries: doc.treasuries && typeof doc.treasuries === 'object' ? doc.treasuries : {},
        batches: doc.batches && typeof doc.batches === 'object' ? doc.batches : {},
      };
    } catch {
      return emptyDoc();
    }
  }

  function save(doc) {
    storage.setItem(TREASURY_STORE_KEY, JSON.stringify(doc));
  }

  function patchTreasury(walletId, patch) {
    const doc = load();
    const cur = doc.treasuries[walletId];
    if (!cur) throw new Error(`unknown treasury: ${walletId}`);
    doc.treasuries[walletId] = { ...cur, ...clone(patch) };
    save(doc);
    return clone(doc.treasuries[walletId]);
  }

  return {
    /** All treasury metas, insertion order. */
    listTreasuries() {
      return Object.values(load().treasuries).map(clone);
    },

    getTreasury(walletId) {
      return clone(load().treasuries[walletId] ?? null);
    },

    /** Store a treasury record (FR-6 shape). Requires walletId + name; the
     * slug is derived from the canonical name prefix when not supplied (an
     * alias-only name must come with an explicit slug). */
    putTreasury(meta) {
      if (!meta || typeof meta.walletId !== 'string' || !meta.walletId) {
        throw new Error('treasury meta requires a walletId');
      }
      if (typeof meta.name !== 'string' || !meta.name.trim()) {
        throw new Error('treasury meta requires a name');
      }
      const doc = load();
      doc.treasuries[meta.walletId] = {
        alias: '',
        batchId: null,
        createdAt: new Date().toISOString(),
        ddMovedWarning: null,
        transferredOut: false,
        ...clone(meta),
        slug: meta.slug ?? treasurySlug(meta.name),
      };
      save(doc);
      return clone(doc.treasuries[meta.walletId]);
    },

    /** Shallow-merge a top-level patch; throws on unknown id. */
    updateTreasury(walletId, patch) {
      return patchTreasury(walletId, patch);
    },

    /** Delete the registry record WITHOUT touching the vault — used after a
     * handover, where the wallet itself is removed through the vault flow. */
    removeTreasuryRecord(walletId) {
      const doc = load();
      delete doc.treasuries[walletId];
      save(doc);
    },

    /** FR-7 step 4: the treasury left this device. */
    markTransferredOut(walletId) {
      return patchTreasury(walletId, { transferredOut: { at: new Date().toISOString() } });
    },

    saveBatch(batch) {
      if (!batch || typeof batch.batchId !== 'string' || !batch.batchId) {
        throw new Error('batch requires a batchId');
      }
      const doc = load();
      doc.batches[batch.batchId] = clone(batch);
      save(doc);
      return clone(batch);
    },

    getBatch(batchId) {
      return clone(load().batches[batchId] ?? null);
    },

    listBatches() {
      return Object.values(load().batches).map(clone);
    },

    updateBatch(batchId, patch) {
      const doc = load();
      const cur = doc.batches[batchId];
      if (!cur) throw new Error(`unknown batch: ${batchId}`);
      doc.batches[batchId] = { ...cur, ...clone(patch) };
      save(doc);
      return clone(doc.batches[batchId]);
    },
  };
}
