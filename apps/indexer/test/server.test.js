// Indexer façade HTTP seam. ElectrumX is faked with an in-process TCP server
// speaking newline-delimited JSON-RPC — tests assert the façade's translation
// (address → scripthash → HTTP JSON), not ElectrumX itself (that's the e2e).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createTcpServer } from 'node:net';
import { createHash } from 'node:crypto';
import { startServer, ElectrumClient, ElectrumPool, cachedVerboseTx, txCacheForTests } from '../server.js';

// bech32m of program 0x11…×32 (regtest); scripthash = reversed sha256(scriptPubKey)
const ADDR = 'dgbrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygszk8z3a';
const SCRIPTHASH = createHash('sha256')
  .update(Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from('11'.repeat(32), 'hex')]))
  .digest().reverse().toString('hex');

function fakeElectrum(handlers) {
  const seen = [];
  const server = createTcpServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line);
        seen.push(msg);
        const impl = handlers[msg.method] ?? (() => { throw new Error('unexpected: ' + msg.method); });
        sock.write(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result: impl(msg.params) }) + '\n');
      }
    });
  });
  return { server, seen };
}

const DEFAULT_HANDLERS = {
  'server.version': () => ['FakeElectrumX 0.0', '1.4'],
  'blockchain.headers.subscribe': () => ({ height: 1825, hex: '00' }),
  'blockchain.scripthash.listunspent': (params) =>
    params[0] === SCRIPTHASH
      ? [{ tx_hash: 'ab'.repeat(32), tx_pos: 1, value: 1_448_800_000_000, height: 1825 }]
      : [],
  'blockchain.scripthash.get_history': (params) =>
    params[0] === SCRIPTHASH
      ? [{ tx_hash: 'cd'.repeat(32), height: 1824, fee: 100 }, { tx_hash: 'ab'.repeat(32), height: 0 }]
      : [],
};

async function withIndexer(fn, handlers = DEFAULT_HANDLERS) {
  // The tx-body cache is module-level: clear it so one test's fake responses
  // can't leak into the next test's view of the same txid.
  txCacheForTests.map.clear();
  const { server: electrum, seen } = fakeElectrum(handlers);
  await new Promise((r) => electrum.listen(0, r));
  const server = startServer({
    port: 0,
    hrp: 'dgbrt',
    electrum: { host: '127.0.0.1', port: electrum.address().port },
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, seen);
  } finally {
    server.close();
    electrum.close();
  }
}

test('utxos: address is translated to a scripthash query and mapped to wallet-friendly JSON', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${ADDR}/utxos`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      address: ADDR,
      utxos: [{ txid: 'ab'.repeat(32), vout: 1, valueSats: '1448800000000', height: 1825 }],
    });
  });
});

test('history: confirmed and mempool (height 0) entries come through in order', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${ADDR}/history`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      address: ADDR,
      history: [
        { txid: 'cd'.repeat(32), height: 1824 },
        { txid: 'ab'.repeat(32), height: 0 },
      ],
    });
  });
});

test('bad checksum / wrong-network / junk addresses → 400 and Electrum is never queried', async () => {
  await withIndexer(async (base, seen) => {
    for (const bad of [
      ADDR.slice(0, -1) + 'b', // checksum
      'dgbt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsv89e8p', // testnet on regtest facade
      'nonsense',
    ]) {
      assert.equal((await fetch(`${base}/api/address/${bad}/utxos`)).status, 400, bad);
    }
    assert.equal(seen.filter((m) => m.method.startsWith('blockchain.')).length, 0);
  });
});

// ---- DigiDollar positions (#13) ----
// Reference data is the Core-built mint fixture from digidollar-js
// (test/fixtures/mint-tx.json): $100 at the 6-months tier, unlock 1037552.
const { readFile } = await import('node:fs/promises');
const MINT = JSON.parse(await readFile(
  new URL('../../../packages/digidollar-js/test/fixtures/mint-tx.json', import.meta.url), 'utf8',
)).result;
const TRANSFER = JSON.parse(await readFile(
  new URL('../../../packages/digidollar-js/test/fixtures/transfer-tx.json', import.meta.url), 'utf8',
)).result;
const OWNER_ADDR = MINT.vout[1].scriptPubKey.address; // the DD token P2TR = wallet receive address
const scripthashOfHex = (hex) =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest().reverse().toString('hex');
const OWNER_SCRIPTHASH = scripthashOfHex(MINT.vout[1].scriptPubKey.hex);
const COLLATERAL_SCRIPTHASH = scripthashOfHex(MINT.vout[0].scriptPubKey.hex);

const POSITION_HANDLERS = (collateralUnspent) => ({
  'server.version': () => ['FakeElectrumX 0.0', '1.4'],
  'blockchain.headers.subscribe': () => ({ height: 1825, hex: '00' }),
  'blockchain.scripthash.get_history': (params) =>
    params[0] === OWNER_SCRIPTHASH
      ? [
          { tx_hash: MINT.txid, height: 1800 },
          { tx_hash: TRANSFER.txid, height: 1810 }, // DD transfer — not a position
          { tx_hash: 'ee'.repeat(32), height: 1811 }, // plain DGB tx — not a position
        ]
      : [],
  'blockchain.transaction.get': (params) => {
    if (params[0] === MINT.txid) return MINT;
    if (params[0] === TRANSFER.txid) return TRANSFER;
    return { txid: params[0], version: 2, vout: [] }; // plain spend
  },
  'blockchain.scripthash.listunspent': (params) =>
    collateralUnspent && params[0] === COLLATERAL_SCRIPTHASH
      ? [{ tx_hash: MINT.txid, tx_pos: 0, value: 2_634_128_166_915, height: 1800 }]
      : [],
});

test('positions: a mint in history becomes an open position; transfers and plain txs do not', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${OWNER_ADDR}/positions`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      address: OWNER_ADDR,
      tipHeight: 1825,
      positions: [{
        txid: MINT.txid,
        height: 1800,
        ddCents: '10000',           // $100
        tierId: '6months',
        tierLabel: '6 months',
        unlockHeight: 1037552,
        collateralSats: '2634128166915',
      }],
    });
  }, POSITION_HANDLERS(true));
});

test('positions: a redeemed mint (collateral spent) is no longer an open position', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${OWNER_ADDR}/positions`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).positions, []);
  }, POSITION_HANDLERS(false));
});

// ---- DigiDollar spendable balance (#15) ----
// DD tokens live in zero-value P2TR outputs; their amounts come from the
// creating tx's OP_RETURN, paired positionally (mint: [ddCents], transfer:
// amountsCents in output order). dd-utxos resolves each zero-value UTXO on the
// address to its DD cents so the wallet can display and spend DigiDollar.
const TRANSFER_RECIPIENT_ADDR = TRANSFER.vout[0].scriptPubKey.address;
const TRANSFER_RECIPIENT_SCRIPTHASH = scripthashOfHex(TRANSFER.vout[0].scriptPubKey.hex);

const DD_UTXO_HANDLERS = {
  'server.version': () => ['FakeElectrumX 0.0', '1.4'],
  'blockchain.headers.subscribe': () => ({ height: 1825, hex: '00' }),
  'blockchain.scripthash.listunspent': (params) => {
    if (params[0] === OWNER_SCRIPTHASH) {
      return [
        { tx_hash: MINT.txid, tx_pos: 1, value: 0, height: 1800 },     // fresh mint DD
        { tx_hash: TRANSFER.txid, tx_pos: 1, value: 0, height: 1810 }, // DD change of a transfer
        { tx_hash: 'aa'.repeat(32), tx_pos: 0, value: 150_000_000, height: 1805 }, // plain DGB
      ];
    }
    if (params[0] === TRANSFER_RECIPIENT_SCRIPTHASH) {
      return [{ tx_hash: TRANSFER.txid, tx_pos: 0, value: 0, height: 1810 }];
    }
    return [];
  },
  'blockchain.transaction.get': (params) => {
    if (params[0] === MINT.txid) return MINT;
    if (params[0] === TRANSFER.txid) return TRANSFER;
    return { txid: params[0], version: 2, vout: [] };
  },
};

test('dd-utxos: zero-value DD outputs resolve to cents (mint full amount, transfer change)', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${OWNER_ADDR}/dd-utxos`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      address: OWNER_ADDR,
      totalCents: '17000', // $100 mint + $70 transfer change
      utxos: [
        { txid: MINT.txid, vout: 1, cents: '10000', height: 1800 },
        { txid: TRANSFER.txid, vout: 1, cents: '7000', height: 1810 },
      ],
    });
  }, DD_UTXO_HANDLERS);
});

test('dd-utxos: a transfer RECIPIENT sees the positional amount for their output', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${TRANSFER_RECIPIENT_ADDR}/dd-utxos`);
    assert.deepEqual((await res.json()).utxos, [
      { txid: TRANSFER.txid, vout: 0, cents: '3000', height: 1810 },
    ]);
  }, DD_UTXO_HANDLERS);
});

// ---- Per-tx enrichment (#69) ----
// Resolve one tx into a real history entry: DD type, resolved in/out addresses,
// fee (Σin − Σout, needing each input's prevout), timestamp, confirmations.
const PREV1 = TRANSFER.vin[0].txid; // funds vout[1]
const PREV2 = TRANSFER.vin[1].txid; // funds vout[1] (the DD fee coin)
const stubPrevout = (value, address) => ({ txid: 'ff'.repeat(32), version: 2, vout: [{ n: 0, value: 0, scriptPubKey: {} }, { n: 1, value, scriptPubKey: { address, hex: '00' } }] });

const TX_HANDLERS = {
  'server.version': () => ['FakeElectrumX 0.0', '1.4'],
  'blockchain.headers.subscribe': () => ({ height: 1825, hex: '00' }),
  'blockchain.transaction.get': (params) => {
    if (params[0] === TRANSFER.txid) return { ...TRANSFER, confirmations: 12, blocktime: 1_720_000_000 };
    if (params[0] === PREV1) return stubPrevout(14.36, 'dgbrt1qfunder00000000000000000000000000funder0');
    if (params[0] === PREV2) return stubPrevout(0.01, 'dgbrt1qfeecoin0000000000000000000000000feecn0');
    throw new Error('unexpected tx: ' + params[0]);
  },
};

test('tx: a DD transfer resolves to type, signed in/out addresses, fee, timestamp, confirmations', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/tx/${TRANSFER.txid}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      txid: TRANSFER.txid,
      confirmations: 12,
      time: 1_720_000_000,
      type: 'transfer',
      feeSats: '9244', // (14.36 + 0.01) − 14.36990756 DGB, in sats
      vin: [
        { address: 'dgbrt1qfunder00000000000000000000000000funder0', valueSats: '1436000000' },
        { address: 'dgbrt1qfeecoin0000000000000000000000000feecn0', valueSats: '1000000' },
      ],
      vout: [
        { n: 0, address: TRANSFER.vout[0].scriptPubKey.address, valueSats: '0', ddCents: '3000' },
        { n: 1, address: TRANSFER.vout[1].scriptPubKey.address, valueSats: '0', ddCents: '7000' },
        { n: 2, address: TRANSFER.vout[2].scriptPubKey.address, valueSats: '1436990756', ddCents: null },
        { n: 3, address: null, valueSats: '0', ddCents: null }, // OP_RETURN — no address, not DD-valued
      ],
    });
  }, TX_HANDLERS);
});

test('tx: a coinbase input makes the fee uncomputable (feeSats null), tx still resolves', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/tx/${'11'.repeat(32)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, 'dgb');
    assert.equal(body.feeSats, null);
    assert.deepEqual(body.vin, [{ address: null, valueSats: null }]);
    assert.deepEqual(body.vout, [{ n: 0, address: 'dgbrt1qminer0000000000000000000000000000miner0', valueSats: '625000000', ddCents: null }]);
  }, {
    'server.version': () => ['FakeElectrumX 0.0', '1.4'],
    'blockchain.transaction.get': (params) => ({
      txid: params[0], version: 2, confirmations: 100, blocktime: 1_720_000_500,
      vin: [{ coinbase: '02abcd', sequence: 0 }],
      vout: [{ n: 0, value: 6.25, scriptPubKey: { address: 'dgbrt1qminer0000000000000000000000000000miner0', hex: '0014' } }],
    }),
  });
});

test('tx: malformed txid in the path is rejected (404), Electrum never queried', async () => {
  await withIndexer(async (base, seen) => {
    assert.equal((await fetch(`${base}/api/tx/nothex`)).status, 404);
    assert.equal((await fetch(`${base}/api/tx/${'zz'.repeat(32)}`)).status, 404);
    assert.equal(seen.filter((m) => m.method.startsWith('blockchain.')).length, 0);
  }, TX_HANDLERS);
});

test('tx: prevout fan-out is capped at 40 — inputs past the cap are unresolved and the fee is null', async () => {
  const BIGTX = '99'.repeat(32);
  const PREVBIG = 'dd'.repeat(32);
  await withIndexer(async (base) => {
    const body = await (await fetch(`${base}/api/tx/${BIGTX}`)).json();
    assert.equal(body.vin.length, 45);
    assert.deepEqual(body.vin[0], { address: 'dgbrt1qfunder0000000000000000000000000fundr0', valueSats: '300000000' });
    assert.deepEqual(body.vin[39], { address: 'dgbrt1qfunder0000000000000000000000000fundr0', valueSats: '300000000' });
    assert.deepEqual(body.vin[40], { address: null, valueSats: null }); // past the cap
    assert.deepEqual(body.vin[44], { address: null, valueSats: null });
    assert.equal(body.feeSats, null); // inputs incomplete → fee not asserted
  }, {
    'server.version': () => ['FakeElectrumX 0.0', '1.4'],
    'blockchain.transaction.get': (params) => {
      if (params[0] === BIGTX) return { txid: BIGTX, version: 2, confirmations: 3, blocktime: 1_720_000_000,
        vin: Array.from({ length: 45 }, () => ({ txid: PREVBIG, vout: 0 })),
        vout: [{ n: 0, value: 100, scriptPubKey: { address: 'dgbrt1qbig000000000000000000000000000000big0', hex: '0014' } }] };
      if (params[0] === PREVBIG) return { txid: PREVBIG, version: 2, vout: [{ n: 0, value: 3, scriptPubKey: { address: 'dgbrt1qfunder0000000000000000000000000fundr0', hex: '0014' } }] };
      throw new Error('unexpected tx: ' + params[0]);
    },
  });
});

test('tx: a mempool tx (no confirmations/blocktime) reports confirmations 0 and time null, fee still resolves', async () => {
  const MEMTX = '77'.repeat(32);
  const PREVM = '66'.repeat(32);
  await withIndexer(async (base) => {
    const body = await (await fetch(`${base}/api/tx/${MEMTX}`)).json();
    assert.equal(body.confirmations, 0);
    assert.equal(body.time, null);
    assert.equal(body.feeSats, '1000000'); // 10 − 9.99 DGB
  }, {
    'server.version': () => ['FakeElectrumX 0.0', '1.4'],
    'blockchain.transaction.get': (params) => {
      if (params[0] === MEMTX) return { txid: MEMTX, version: 2, // no confirmations, no blocktime
        vin: [{ txid: PREVM, vout: 0 }],
        vout: [{ n: 0, value: 9.99, scriptPubKey: { address: 'dgbrt1qrecv00000000000000000000000000recv0', hex: '0014' } }] };
      if (params[0] === PREVM) return { txid: PREVM, version: 2, vout: [{ n: 0, value: 10, scriptPubKey: { address: 'dgbrt1qspend0000000000000000000000000spend0', hex: '0014' } }] };
      throw new Error('unexpected tx: ' + params[0]);
    },
  });
});

test('tx: a vin whose prevout vout index is missing leaves the fee null, tx still resolves', async () => {
  const GAPTX = '88'.repeat(32);
  const PREVG = '55'.repeat(32);
  await withIndexer(async (base) => {
    const body = await (await fetch(`${base}/api/tx/${GAPTX}`)).json();
    assert.deepEqual(body.vin, [{ address: null, valueSats: null }]); // vout[5] absent → unresolved
    assert.equal(body.feeSats, null);
  }, {
    'server.version': () => ['FakeElectrumX 0.0', '1.4'],
    'blockchain.transaction.get': (params) => {
      if (params[0] === GAPTX) return { txid: GAPTX, version: 2, confirmations: 1, blocktime: 1_720_000_000,
        vin: [{ txid: PREVG, vout: 5 }], // prevout only has vout[0]
        vout: [{ n: 0, value: 1, scriptPubKey: { address: 'dgbrt1qgap000000000000000000000000000000gap0', hex: '0014' } }] };
      if (params[0] === PREVG) return { txid: PREVG, version: 2, vout: [{ n: 0, value: 2, scriptPubKey: { address: 'x', hex: '0014' } }] };
      throw new Error('unexpected tx: ' + params[0]);
    },
  });
});

test('health reports the electrum tip height', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.deepEqual(await res.json(), { height: 1825 });
  });
});

test('reconnect after a dropped TCP session re-does the server.version handshake (#32)', async () => {
  // Strict fake: like real ElectrumX ≥1.4, it KILLS any connection whose first
  // message is not server.version. The façade must survive its long-lived
  // connection being dropped (idle timeout, ElectrumX restart) without a
  // process restart.
  const sockets = new Set();
  let handshakes = 0;
  const electrum = createTcpServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let handshaken = false;
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!handshaken && msg.method !== 'server.version') return sock.destroy();
        if (msg.method === 'server.version') { handshaken = true; handshakes++; }
        const result = msg.method === 'server.version' ? ['StrictFake 0.0', '1.4']
          : msg.method === 'blockchain.scripthash.listunspent' ? []
          : msg.method === 'blockchain.headers.subscribe' ? { height: 1, hex: '00' }
          : null;
        sock.write(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result }) + '\n');
      }
    });
  });
  await new Promise((r) => electrum.listen(0, r));
  const server = startServer({ port: 0, hrp: 'dgbrt', electrum: { host: '127.0.0.1', port: electrum.address().port } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/address/${ADDR}/utxos`)).status, 200, 'first query works');
    // drop the live TCP session server-side, as an idle timeout would
    for (const s of sockets) s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`${base}/api/address/${ADDR}/utxos`);
    assert.equal(res.status, 200, 'query after reconnect must succeed without a façade restart');
    assert.equal(handshakes, 2, 'a fresh server.version handshake on the new connection');
  } finally {
    server.close();
    electrum.close();
  }
});

test('electrum backend down → 502 with an error body, not a hang', async () => {
  const server = startServer({ port: 0, hrp: 'dgbrt', electrum: { host: '127.0.0.1', port: 1 } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/address/${ADDR}/utxos`);
    assert.equal(res.status, 502);
    assert.ok((await res.json()).error);
  } finally {
    server.close();
  }
});

// ---- Frame parser / pool / tx-cache (post-review fixes) ----
// These exercise ElectrumClient/ElectrumPool/cachedVerboseTx DIRECTLY against
// fake ElectrumX TCP servers — same newline-delimited JSON-RPC fakery as the
// HTTP seam tests above, minus the façade.
function lineRpcServer(onMessage) {
  return createTcpServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        onMessage(sock, msg);
      }
    });
  });
}
const reply = (sock, msg, result) =>
  sock.write(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result }) + '\n');

test('frame parser: a multi-MB single-line frame arriving in 64KB chunks parses correctly and fast (no O(n²))', async () => {
  // Verbose-tx responses can be megabytes of single-line JSON; the old
  // flatten+rescan-per-chunk framing was quadratic at exactly this shape.
  const BIG = 'x'.repeat(12 * 1024 * 1024);
  const electrum = lineRpcServer((sock, msg) => {
    const payload = msg.method === 'server.version' ? ['Fake 0.0', '1.4'] : { data: BIG };
    const frame = JSON.stringify({ id: msg.id, jsonrpc: '2.0', result: payload }) + '\n';
    // 64KB writes, like a real TCP stream chopping up a large response
    for (let i = 0; i < frame.length; i += 65536) sock.write(frame.slice(i, i + 65536));
  });
  await new Promise((r) => electrum.listen(0, r));
  const client = new ElectrumClient({ host: '127.0.0.1', port: electrum.address().port });
  try {
    const t0 = performance.now();
    const res = await client.request('big');
    const elapsed = performance.now() - t0;
    assert.equal(res.data, BIG);
    // Linear framing is tens of ms; the quadratic version needed seconds at
    // this size. Generous bound so slow CI can't flake.
    assert.ok(elapsed < 2000, `framing took ${Math.round(elapsed)}ms — O(n²) regression?`);
  } finally {
    client.recycle();
    electrum.close();
  }
});

test('frame parser: several pipelined small frames in one chunk are all dispatched', async () => {
  const electrum = lineRpcServer((sock, msg) => reply(sock, msg,
    msg.method === 'server.version' ? ['Fake 0.0', '1.4'] : `pong:${msg.method}`));
  await new Promise((r) => electrum.listen(0, r));
  const client = new ElectrumClient({ host: '127.0.0.1', port: electrum.address().port });
  try {
    // three concurrent requests → responses typically coalesce into one chunk
    const res = await Promise.all([client.request('a'), client.request('b'), client.request('c')]);
    assert.deepEqual(res, ['pong:a', 'pong:b', 'pong:c']);
  } finally {
    client.recycle();
    electrum.close();
  }
});

test('pool: RPC errors propagate WITHOUT recycle/retry; transport failures retry once on a fresh session', async () => {
  let conns = 0;
  const calls = { bad: 0, flaky: 0 };
  const electrum = lineRpcServer((sock, msg) => {
    if (msg.method === 'server.version') { conns++; return reply(sock, msg, ['Fake 0.0', '1.4']); }
    if (msg.method === 'bad.method') {
      calls.bad++;
      return sock.write(JSON.stringify({ id: msg.id, jsonrpc: '2.0', error: { code: -5, message: 'unknown transaction' } }) + '\n');
    }
    if (msg.method === 'flaky.method') {
      calls.flaky++;
      if (calls.flaky === 1) return sock.destroy(); // die mid-request, no answer
      return reply(sock, msg, 'ok');
    }
  });
  await new Promise((r) => electrum.listen(0, r));
  const pool = new ElectrumPool({ host: '127.0.0.1', port: electrum.address().port }, 1);
  try {
    // RPC-level error: the server ANSWERED — no recycle, no retry
    await assert.rejects(pool.request('bad.method'), (err) => {
      assert.equal(err.message, 'unknown transaction');
      assert.equal(err.electrumRpc, true, 'RPC errors must carry the transport/RPC discriminator');
      return true;
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.bad, 1, 'an RPC error must not be retried');
    assert.equal(conns, 1, 'an RPC error must not recycle the session');

    // Transport failure: the socket died without answering — recycle + retry once
    assert.equal(await pool.request('flaky.method'), 'ok');
    assert.equal(calls.flaky, 2, 'a transport failure is retried exactly once');
    assert.equal(conns, 2, 'the retry ran on a fresh session');
  } finally {
    pool.closeAll();
    electrum.close();
  }
});

test('pool: recycle with a reconnect in flight does not fail the new request (stale-close guard)', async () => {
  const electrum = lineRpcServer((sock, msg) => reply(sock, msg,
    msg.method === 'server.version' ? ['Fake 0.0', '1.4'] : `pong:${msg.method}`));
  await new Promise((r) => electrum.listen(0, r));
  const pool = new ElectrumPool({ host: '127.0.0.1', port: electrum.address().port }, 1);
  try {
    assert.equal(await pool.request('first'), 'pong:first'); // session live
    const client = pool.clients[0];
    client.recycle(); // destroys the socket; its async 'close' fires LATER
    // The reconnect starts immediately; the dying socket's late 'close' must
    // not null the new socket nor reject the new session's pending requests.
    assert.equal(await pool.request('second'), 'pong:second');
    await new Promise((r) => setTimeout(r, 50)); // let any stale events land
    assert.equal(await pool.request('third'), 'pong:third', 'successor session survived the stale close');
  } finally {
    pool.closeAll();
    electrum.close();
  }
});

test('tx cache: concurrent identical verbose tx.gets share ONE upstream call; entry expires after the TTL', async () => {
  const txid = 'c7'.repeat(32);
  txCacheForTests.map.delete(txid);
  let calls = 0;
  const slowElectrum = async (method, params) => {
    assert.equal(method, 'blockchain.transaction.get');
    calls++;
    await new Promise((r) => setTimeout(r, 25)); // stay in flight so the second caller overlaps
    return { txid: params[0], version: 2, vout: [] };
  };
  try {
    const [a, b] = await Promise.all([cachedVerboseTx(slowElectrum, txid), cachedVerboseTx(slowElectrum, txid)]);
    assert.equal(calls, 1, 'two concurrent callers, ONE upstream call');
    assert.equal(a, b, 'both callers get the same shared result');
    await cachedVerboseTx(slowElectrum, txid);
    assert.equal(calls, 1, 'within the TTL the cached body is reused');
    // age the entry past the TTL instead of sleeping 15s
    txCacheForTests.map.get(txid).at -= txCacheForTests.TTL_MS + 1;
    await cachedVerboseTx(slowElectrum, txid);
    assert.equal(calls, 2, 'past the TTL the tx is re-fetched');
  } finally {
    txCacheForTests.map.delete(txid);
  }
});

test('tx cache: a failed upstream call is evicted, not cached for the TTL', async () => {
  const txid = 'c8'.repeat(32);
  txCacheForTests.map.delete(txid);
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error('electrum down');
    return { txid, version: 2, vout: [] };
  };
  try {
    await assert.rejects(cachedVerboseTx(flaky, txid), /electrum down/);
    await new Promise((r) => setTimeout(r, 0)); // let the eviction handler run
    assert.equal((await cachedVerboseTx(flaky, txid)).txid, txid, 'the next call retries upstream');
    assert.equal(calls, 2);
  } finally {
    txCacheForTests.map.delete(txid);
  }
});

// ---- Bulk address reads (POST /api/addresses) ----

test('bulk: one POST answers utxos+history for many addresses, tipHeight once', async () => {
  await withIndexer(async (base, seen) => {
    const res = await fetch(`${base}/api/addresses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: [ADDR, ADDR], want: ['utxos', 'history'] }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.tipHeight, 1825);
    const entry = json.results[ADDR];
    // identical shapes to the per-address GETs — the client mixes them freely
    assert.deepEqual(entry.utxos, [{ txid: 'ab'.repeat(32), vout: 1, valueSats: '1448800000000', height: 1825 }]);
    assert.deepEqual(entry.history, [
      { txid: 'cd'.repeat(32), height: 1824 },
      { txid: 'ab'.repeat(32), height: 0 },
    ]);
    // FUSED: duplicate addresses in one request still cost one scripthash
    // subscription-free read pair each; headers.subscribe fired exactly once.
    assert.equal(seen.filter((c) => c.method === 'blockchain.headers.subscribe').length, 1);
  });
});

test('bulk: a bad address fails its own entry, not the request', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/addresses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: [ADDR, 'not-an-address'], want: ['utxos'] }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.results[ADDR].utxos, 'the good address still answered');
    assert.ok(json.results['not-an-address'].error, 'the bad one carries its error');
  });
});

test('bulk: caps — address count and body size are refused, not truncated', async () => {
  await withIndexer(async (base) => {
    const many = Array.from({ length: 201 }, () => ADDR);
    const res = await fetch(`${base}/api/addresses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: many }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /at most 200/);

    const fat = await fetch(`${base}/api/addresses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: [ADDR], pad: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(fat.status, 413);
  });
});

// ---- F4: upstream errors never reach the client verbatim ----

test('F4: unknown txid → 404 "not found", no ElectrumX fingerprint in the body', async () => {
  const electrum = lineRpcServer((sock, msg) => {
    if (msg.method === 'server.version') return reply(sock, msg, ['Fake 0.0', '1.4']);
    if (msg.method === 'blockchain.transaction.get') {
      // exactly what a stock ElectrumX returns for a missing tx
      return sock.write(JSON.stringify({ id: msg.id, jsonrpc: '2.0',
        error: { code: -5, message: "DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction. Use -txindex...'})" } }) + '\n');
    }
  });
  await new Promise((r) => electrum.listen(0, r));
  const server = startServer({ port: 0, hrp: 'dgbrt', electrum: { host: '127.0.0.1', port: electrum.address().port } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/tx/${'ab'.repeat(32)}`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'not found');
    assert.ok(!/daemon|electrum|txindex|-5|mempool/i.test(JSON.stringify(body)), 'no backend fingerprint leaked');
  } finally {
    server.close();
    electrum.close();
  }
});

test('F4: backend unreachable → 502 generic body, names no host/port/method', async () => {
  const server = startServer({ port: 0, hrp: 'dgbrt', electrum: { host: '127.0.0.1', port: 1 } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/address/${ADDR}/utxos`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(!/127\.0\.0\.1|:1\b|ECONNREFUSED|electrum|scripthash/i.test(JSON.stringify(body)), 'no transport detail leaked');
  } finally {
    server.close();
  }
});

// ---- F3: per-request scan budget — complete-or-absent, never a truncated list ----
import { createScanBudget, assertNoMoneyOnIncomplete } from '../server.js';

async function withIndexerOv(fn, handlers = DEFAULT_HANDLERS, overrides = {}) {
  txCacheForTests.map.clear();
  const { server: electrum, seen } = fakeElectrum(handlers);
  await new Promise((r) => electrum.listen(0, r));
  const server = startServer({
    port: 0,
    hrp: 'dgbrt',
    electrum: { host: '127.0.0.1', port: electrum.address().port },
    ...overrides,
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, seen);
  } finally {
    server.close();
    electrum.close();
  }
}

// A hot address: many history entries, each a plain (non-mint) tx, so the
// positions scan must fan out one verbose fetch per entry.
const HOT_TXS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((p) => p.repeat(32));
const BUDGET_HANDLERS = {
  'server.version': () => ['FakeElectrumX 0.0', '1.4'],
  'blockchain.headers.subscribe': () => ({ height: 1825, hex: '00' }),
  'blockchain.scripthash.get_history': (params) =>
    params[0] === SCRIPTHASH ? HOT_TXS.map((tx_hash, i) => ({ tx_hash, height: 1800 + i })) : [],
  'blockchain.transaction.get': (params) => ({ txid: params[0], version: 2, vout: [] }),
  'blockchain.scripthash.listunspent': () => [],
};

test('F3: a scan that blows the call budget answers complete:false and OMITS the money keys', async () => {
  await withIndexerOv(async (base) => {
    const res = await fetch(`${base}/api/address/${ADDR}/positions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.address, ADDR);
    assert.equal(body.complete, false);
    assert.equal(body.reason, 'calls');
    // THE invariant: absent, not []. An empty array renders "No open
    // positions" and the user's vault would vanish from the wallet.
    assert.ok(!('positions' in body), 'a budget-hit scan must omit positions, never truncate it');
    assert.ok(!('utxos' in body) && !('ddUtxos' in body));
  }, BUDGET_HANDLERS, { scanBudget: { maxUpstream: 3, maxItems: 5000, deadlineMs: 60_000 } });
});

test('F3: the items budget trips independently of the call count', async () => {
  await withIndexerOv(async (base) => {
    const body = await (await fetch(`${base}/api/address/${ADDR}/positions`)).json();
    assert.equal(body.complete, false);
    assert.equal(body.reason, 'items');
    assert.ok(!('positions' in body));
  }, BUDGET_HANDLERS, { scanBudget: { maxUpstream: 4000, maxItems: 2, deadlineMs: 60_000 } });
});

test('F3: a complete scan under budget is byte-for-byte the legacy shape (regression)', async () => {
  await withIndexerOv(async (base) => {
    const res = await fetch(`${base}/api/address/${OWNER_ADDR}/positions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.complete, undefined, 'a complete scan carries no marker');
    assert.deepEqual(body.positions, [{
      txid: MINT.txid,
      height: 1800,
      ddCents: '10000',
      tierId: '6months',
      tierLabel: '6 months',
      unlockHeight: 1037552,
      collateralSats: '2634128166915',
    }]);
  }, POSITION_HANDLERS(true), { scanBudget: { maxUpstream: 4000, maxItems: 5000, deadlineMs: 60_000 } });
});

test('F3 bulk: the hot address answers incomplete, the cheap one still completes with its arrays', async () => {
  // One budget shared by the whole request: tip(1) + two get_history(2,3) fit
  // under 3; the hot address's first verbose fetch would be call 4 — and the
  // debit throws BEFORE the upstream call happens.
  await withIndexerOv(async (base, seen) => {
    const res = await fetch(`${base}/api/addresses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: [OWNER_ADDR, ADDR], want: ['positions'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const cheap = body.results[OWNER_ADDR]; // empty history → completes
    const hot = body.results[ADDR];         // 6-entry history → budget hit
    assert.deepEqual(cheap.positions, [], 'a complete EMPTY answer still carries its array');
    assert.equal(hot.complete, false);
    assert.equal(hot.reason, 'calls');
    assert.ok(!('positions' in hot), 'per-address isolation: incomplete omits the money key');
    assert.equal(seen.filter((m) => m.method === 'blockchain.transaction.get').length, 0,
      'once the budget trips, no further upstream work happens');
  }, BUDGET_HANDLERS, { scanBudget: { maxUpstream: 3, maxItems: 5000, deadlineMs: 60_000 } });
});

test('F3: the sendJson assertion — an incomplete body carrying a money array throws', () => {
  assert.throws(() => assertNoMoneyOnIncomplete({ complete: false, reason: 'calls', positions: [] }), /complete-or-absent/);
  assert.throws(() => assertNoMoneyOnIncomplete({ results: { a: { complete: false, reason: 'calls', utxos: [] } } }), /complete-or-absent/);
  // the honest shapes pass untouched
  assertNoMoneyOnIncomplete({ complete: false, reason: 'calls' });
  assertNoMoneyOnIncomplete({ results: { a: { complete: false, reason: 'calls' }, b: { utxos: [], positions: [] } } });
  assertNoMoneyOnIncomplete({ address: 'x', positions: [] });
});

test('F3: the admission ceiling answers 503 "index busy — retry" and the queued request recovers', async () => {
  const electrum = createTcpServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        const result = msg.method === 'server.version' ? ['Fake 0.0', '1.4']
          : msg.method === 'blockchain.scripthash.listunspent' ? []
          : null;
        // hold every non-handshake answer so a second request arrives while
        // the first is still admitted
        const frame = JSON.stringify({ id: msg.id, jsonrpc: '2.0', result }) + '\n';
        if (msg.method === 'server.version') sock.write(frame);
        else setTimeout(() => sock.write(frame), 150);
      }
    });
  });
  await new Promise((r) => electrum.listen(0, r));
  const server = startServer({
    port: 0, hrp: 'dgbrt', maxAdmitted: 1,
    electrum: { host: '127.0.0.1', port: electrum.address().port },
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = fetch(`${base}/api/address/${ADDR}/utxos`);
    await new Promise((r) => setTimeout(r, 50)); // first is admitted, upstream held
    const res = await fetch(`${base}/api/address/${ADDR}/utxos`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'index busy — retry' });
    assert.equal((await first).status, 200, 'the admitted request completes normally');
    // and once it drains, the ceiling opens again
    assert.equal((await fetch(`${base}/api/address/${ADDR}/utxos`)).status, 200);
  } finally {
    server.close();
    electrum.close();
  }
});

test('F3: the budget unit itself — note/debit trip reasons and the sticky tripped reason', () => {
  const b = createScanBudget({ maxUpstream: 2, maxItems: 1, deadlineMs: 60_000 });
  b.note();
  assert.throws(() => b.note(), (e) => e.scanIncomplete === true && e.reason === 'items');
  // already tripped: the SAME reason re-throws on either check
  assert.throws(() => b.debit(), (e) => e.scanIncomplete === true && e.reason === 'items');

  const c = createScanBudget({ maxUpstream: 2, maxItems: 100, deadlineMs: 60_000 });
  c.debit();
  c.debit();
  assert.throws(() => c.debit(), (e) => e.reason === 'calls');
});
