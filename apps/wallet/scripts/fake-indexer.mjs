// Minimal in-memory stand-in for the ElectrumX indexer façade (apps/indexer),
// serving just the four address endpoints the wallet reads. It has NO chain
// behind it: you POST canned UTXOs for an address and it echoes them back,
// deriving history from the UTXO set. Purpose: exercise the wallet's balance /
// send / send-max / fiat flows locally without a regtest node + ElectrumX.
//
// /__auto (treasury-split driver): when enabled, /utxos, /positions and
// /dd-utxos for addresses with NO explicit funding answer with one big canned
// confirmed coin / one canned $100 position / $100 of DD — so the batch
// engine's funding-confirmation and mint-coin reads succeed for freshly
// generated treasury addresses whose funding "transaction" only ever existed
// in mock-broadcast land. /history is NOT auto-answered (the receive-chain
// gap-limit scan would never terminate if every derivation looked used).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.PORT) || 8799;
const TIP = Number(process.env.TIP) || 100_000;
const funded = new Map(); // address -> { utxos, ddCents, ddUtxos }
let failing = false; // fault injection: make every address read answer 503
let incomplete = false; // F3 injection: funded addresses answer the incomplete marker
let auto = null; // { valueSats, height } — see header note; null = off

const autoTxid = (address) => createHash('sha256').update(`auto:${address}`).digest('hex');

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  // Control endpoint: register canned UTXOs for an address.
  if (req.method === 'POST' && req.url === '/__fund') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { address, utxos = [], ddCents = '0', ddUtxos = [], positions = [] } = JSON.parse(raw || '{}');
    funded.set(address, { utxos, ddCents: String(ddCents), ddUtxos, positions });
    return json(res, 200, { ok: true, address, count: utxos.length });
  }
  // Deliberately does NOT clear `failing`: a driver that resets funding between
  // parts should not have its injected outage silently switched off underneath it.
  if (req.method === 'POST' && req.url === '/__reset') { funded.clear(); return json(res, 200, { ok: true }); }
  // Control endpoint: make the address reads fail, so a driver can prove the
  // wallet recovers from an indexer outage rather than giving up on it.
  if (req.method === 'POST' && req.url === '/__incomplete') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    incomplete = JSON.parse(raw || '{}').on !== false;
    return json(res, 200, { ok: true, incomplete });
  }
  if (req.method === 'POST' && req.url === '/__fail') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    failing = JSON.parse(raw || '{}').on !== false;
    return json(res, 200, { ok: true, failing });
  }
  // Control endpoint: auto-answer utxos/positions/dd-utxos for UNFUNDED
  // addresses (see header). { on: false } disables; { valueSats, height } tunes.
  if (req.method === 'POST' && req.url === '/__auto') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    auto = body.on === false ? null : {
      valueSats: String(body.valueSats ?? '200000000000000'), // 2M DGB
      height: Number.isInteger(body.height) ? body.height : TIP - 100,
    };
    return json(res, 200, { ok: true, auto: Boolean(auto) });
  }

  // One answering brain for both the per-address GETs and the bulk POST — the
  // wallet must see identical data whichever transport it picks.
  function answerFor(address, what) {
    const entry = funded.get(address) || { utxos: [], ddCents: '0', ddUtxos: [], positions: [] };
    const hasEntry = funded.has(address);
    if (what === 'utxos') {
      if (!hasEntry && auto) {
        return { address, utxos: [{ txid: autoTxid(address), vout: 0, valueSats: auto.valueSats, height: auto.height }] };
      }
      return { address, utxos: entry.utxos };
    }
    if (what === 'history') {
      // one history row per distinct txid, carrying the UTXO's height
      const seen = new Map();
      for (const u of entry.utxos) if (!seen.has(u.txid)) seen.set(u.txid, u.height);
      return { address, history: [...seen].map(([txid, height]) => ({ txid, height })) };
    }
    if (what === 'positions') {
      // explicitly funded positions win (auto-gather driver stages these)
      if (hasEntry && entry.positions.length) return { address, positions: entry.positions, tipHeight: TIP };
      if (!hasEntry && auto) {
        return {
          address,
          positions: [{
            txid: autoTxid(address), height: auto.height, ddCents: '10000', tierId: '10y',
            tierLabel: '10 years', unlockHeight: TIP + 1_000_000, collateralSats: '1490300000000',
          }],
          tipHeight: TIP,
        };
      }
      return { address, positions: [], tipHeight: TIP };
    }
    // dd-utxos
    if (!hasEntry && auto) {
      return { address, totalCents: '10000', utxos: [{ txid: autoTxid(address), vout: 1, cents: '10000', height: auto.height }] };
    }
    return { address, totalCents: entry.ddCents, utxos: entry.ddUtxos };
  }

  // Bulk read, mirroring apps/indexer's POST /api/addresses response shape.
  if (req.method === 'POST' && req.url === '/api/addresses') {
    if (failing) return json(res, 503, { error: 'indexer down (injected)' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { addresses = [], want = ['utxos', 'history'] } = JSON.parse(raw || '{}');
    if (!Array.isArray(addresses) || addresses.length === 0) return json(res, 400, { error: 'addresses[] required' });
    if (addresses.length > 200) return json(res, 400, { error: 'at most 200 addresses per request' });
    const wants = new Set(want);
    const results = {};
    for (const a of addresses) {
      // F3 injection: when armed, funded addresses answer the complete-or-absent
      // INCOMPLETE marker (money keys omitted) so the client's last-good
      // substitution can be observed in a browser.
      if (incomplete && funded.has(a)) { results[a] = { complete: false, reason: 'scan-budget' }; continue; }
      const out = {};
      if (wants.has('utxos')) out.utxos = answerFor(a, 'utxos').utxos;
      if (wants.has('history')) out.history = answerFor(a, 'history').history;
      if (wants.has('positions')) out.positions = answerFor(a, 'positions').positions;
      if (wants.has('dd-utxos')) {
        const dd = answerFor(a, 'dd-utxos');
        out.ddUtxos = dd.utxos;
        out.ddTotalCents = dd.totalCents;
      }
      results[a] = out;
    }
    return json(res, 200, { tipHeight: TIP, results });
  }

  const m = req.url.match(/^\/api\/address\/([a-z0-9]+)\/(utxos|history|positions|dd-utxos)$/);
  if (!m) return json(res, 404, { error: 'unknown path' });
  // After the route matches, so an unknown path is still a 404 either way.
  if (failing) return json(res, 503, { error: 'indexer down (injected)' });
  const [, address, what] = m;
  return json(res, 200, answerFor(address, what));
}).listen(PORT, () => console.log(`fake-indexer on :${PORT} (tip ${TIP})`));
