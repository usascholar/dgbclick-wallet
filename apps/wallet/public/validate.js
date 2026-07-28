// Shape/range validation at the trust boundary for indexer-supplied JSON (#55
// hardened). The indexer URL may be a third-party service; a malicious or
// buggy upstream must not corrupt what the user is asked to sign. Two postures:
//
//   STRICT (utxos, dd-utxos, positions) — anything feeding transaction
//   building: ONE malformed entry throws. A wrong/zero balance shown honestly
//   as an error beats silently signing against poisoned inputs.
//
//   TOLERANT (history, tx detail) — display-only data: drop the malformed
//   entries, keep the rest. A broken row must not blank the Activity list.
//
// Everything returned is a NEW object/array built field-by-field — never the
// input — so a hostile payload (extra keys, __proto__ tricks) cannot ride
// through into the signing path.

const TXID_RE = /^[0-9a-f]{64}$/;
const DECIMAL_RE = /^\d+$/;
const MERCHANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const MAX_HEIGHT = 100_000_000;
const MAX_VOUT = 9_999;
// DigiByte supply cap in sats: 21 billion DGB. Compared as BigInt — the value
// (2.1e17) exceeds Number.MAX_SAFE_INTEGER, so numeric comparison would lie.
const MAX_MONEY_SATS = 21_000_000_000n * 100_000_000n;
// DigiDollar amounts are cents of USD; 10^15 cents is $10 quadrillion — beyond
// any conceivable legitimate balance.
const MAX_CENTS = 10n ** 15n;
const MAX_TIER_LABEL = 80;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isHeight = (x) => Number.isInteger(x) && x >= 0 && x <= MAX_HEIGHT;
const isVout = (x) => Number.isInteger(x) && x >= 0 && x <= MAX_VOUT;
const isSats = (x) => typeof x === 'string' && DECIMAL_RE.test(x) && BigInt(x) <= MAX_MONEY_SATS;
const isCents = (x) => typeof x === 'string' && DECIMAL_RE.test(x) && BigInt(x) <= MAX_CENTS;

function malformed(what) {
  throw new Error(`indexer returned malformed ${what} data — refusing to use it`);
}

/** Incomplete-scan marker (F3). A budget-exhausted indexer scan answers
 * `{ complete: false, reason }` and OMITS the money arrays — "unknown",
 * which is DIFFERENT from an empty result and must stay different all the
 * way to the render (an empty positions array renders "No open positions"
 * and would make a real vault vanish). Returns the marker `{ complete:
 * false, reason }`, or null when the payload is not one. A marker that still
 * carries a money array is a server defect or a hostile upstream — refuse it
 * like any other malformed payload. */
export function asIncomplete(json) {
  if (!isObj(json) || json.complete !== false) return null;
  if (typeof json.reason !== 'string' || json.reason === '') malformed('scan-status');
  for (const k of ['utxos', 'ddUtxos', 'positions', 'history']) {
    if (k in json) malformed('scan-status');
  }
  return { complete: false, reason: json.reason };
}

/** Utxo set for transaction building → STRICT. One poisoned coin = no spend.
 * Returns { utxos: [{ txid, vout, valueSats, height }] } (sanitized copies),
 * or the incomplete-scan marker unchanged (F3 — callers must branch on it). */
export function validateUtxos(json) {
  const inc = asIncomplete(json);
  if (inc) return inc;
  if (!isObj(json) || !Array.isArray(json.utxos)) malformed('utxo');
  return {
    utxos: json.utxos.map((u) => {
      if (!isObj(u) || !TXID_RE.test(u.txid) || !isVout(u.vout) || !isSats(u.valueSats) || !isHeight(u.height)) {
        malformed('utxo');
      }
      return { txid: u.txid, vout: u.vout, valueSats: u.valueSats, height: u.height };
    }),
  };
}

/** DigiDollar coin set (dd-utxos endpoint) → STRICT, same reason. Returns
 * { utxos: [{ txid, vout, cents, height }], totalCents } (sanitized copies),
 * or the incomplete-scan marker unchanged (F3). */
export function validateDdUtxos(json) {
  const inc = asIncomplete(json);
  if (inc) return inc;
  if (!isObj(json) || !Array.isArray(json.utxos) || !isCents(json.totalCents)) malformed('dd-utxo');
  return {
    utxos: json.utxos.map((u) => {
      if (!isObj(u) || !TXID_RE.test(u.txid) || !isVout(u.vout) || !isCents(u.cents) || !isHeight(u.height)) {
        malformed('dd-utxo');
      }
      return { txid: u.txid, vout: u.vout, cents: u.cents, height: u.height };
    }),
    totalCents: json.totalCents,
  };
}

/** DigiDollar positions (mint/redeem inputs) → STRICT. Returns
 * { address, positions: [{ txid, ddCents, collateralSats, unlockHeight, tierLabel }], tipHeight },
 * or the incomplete-scan marker unchanged (F3). */
export function validatePositions(json) {
  const inc = asIncomplete(json);
  if (inc) return inc;
  if (!isObj(json) || typeof json.address !== 'string' || json.address === ''
      || !Array.isArray(json.positions) || !isHeight(json.tipHeight)) {
    malformed('position');
  }
  return {
    address: json.address,
    positions: json.positions.map((p) => {
      if (!isObj(p) || !TXID_RE.test(p.txid) || !isCents(p.ddCents) || !isSats(p.collateralSats)
          || !isHeight(p.unlockHeight)
          || typeof p.tierLabel !== 'string' || p.tierLabel.length > MAX_TIER_LABEL) {
        malformed('position');
      }
      return {
        txid: p.txid,
        ddCents: p.ddCents,
        collateralSats: p.collateralSats,
        unlockHeight: p.unlockHeight,
        tierLabel: p.tierLabel,
      };
    }),
    tipHeight: json.tipHeight,
  };
}

/** Activity history → TOLERANT: malformed entries are dropped, the rest are
 * kept; a non-object payload or missing array yields an empty list. Returns
 * { history: [{ txid, height }] } (sanitized copies). */
export function validateHistory(json) {
  if (!isObj(json) || !Array.isArray(json.history)) return { history: [] };
  return {
    history: json.history
      .filter((h) => isObj(h) && TXID_RE.test(h.txid) && isHeight(h.height))
      .map((h) => ({ txid: h.txid, height: h.height })),
  };
}

/** Transaction detail (Activity enrichment) → TOLERANT. vin/vout are coerced
 * to arrays of plain objects (non-object elements dropped, entries shallow-
 * copied — display code already treats the fields defensively), confirmations
 * and time become finite numbers or null, feeSats a decimal string or null,
 * type a string or null. A non-object payload yields the empty shape. */
export function validateTxDetail(json) {
  const empty = { vin: [], vout: [], confirmations: null, time: null, feeSats: null, type: null };
  if (!isObj(json)) return empty;
  const rows = (x) => (Array.isArray(x) ? x.filter(isObj).map((e) => ({ ...e })) : []);
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    vin: rows(json.vin),
    vout: rows(json.vout),
    confirmations: num(json.confirmations),
    time: num(json.time),
    feeSats: typeof json.feeSats === 'string' && DECIMAL_RE.test(json.feeSats) ? json.feeSats : null,
    type: typeof json.type === 'string' ? json.type : null,
  };
}

/** "Spend DD" merchant directory → TOLERANT, like history: display-only data,
 * so malformed entries are dropped and never fatal — only a broken ENVELOPE
 * (non-object payload, merchants not an array) throws, since then there is
 * nothing honest to show. votes is coerced to a number and clamped at 0;
 * votedByYou is boolean-coerced; blurb/addedAt default to ''. listUrl is kept
 * only as an https string — it lands in an href, and esc() cannot stop a
 * javascript: URL. Returns { merchants, updatedAt, listUrl } (fresh copies). */
export function validateDirectory(json) {
  if (!isObj(json) || !Array.isArray(json.merchants)) malformed('directory');
  const merchants = [];
  for (const m of json.merchants) {
    if (!isObj(m)) continue;
    if (typeof m.id !== 'string' || !MERCHANT_ID_RE.test(m.id)) continue;
    if (typeof m.name !== 'string') continue;
    if (typeof m.url !== 'string' || !m.url.startsWith('https://')) continue;
    if (typeof m.category !== 'string') continue;
    const votes = Number(m.votes);
    if (!Number.isFinite(votes)) continue;
    merchants.push({
      id: m.id,
      name: m.name,
      url: m.url,
      category: m.category,
      blurb: typeof m.blurb === 'string' ? m.blurb : '',
      addedAt: typeof m.addedAt === 'string' ? m.addedAt : '',
      votes: Math.max(0, votes),
      votedByYou: !!m.votedByYou,
    });
  }
  return {
    merchants,
    updatedAt: typeof json.updatedAt === 'string' ? json.updatedAt : '',
    listUrl: typeof json.listUrl === 'string' && json.listUrl.startsWith('https://') ? json.listUrl : '',
  };
}
