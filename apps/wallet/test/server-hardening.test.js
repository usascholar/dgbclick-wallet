// Hardening tests: request body caps, per-IP fixed-window rate limits, and
// env-gated HSTS. Mirrors the withServer pattern from server.test.js,
// extended with overrides so the limits can shrink to test-friendly sizes —
// the defaults (1 MiB body, 120 req/min) would make these tests slow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startServer } from '../server.js';

async function withServer(fn, overrides = {}) {
  const server = startServer({ port: 0, ...overrides }); // mock mode: no RPC creds passed
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

function postRpc(base) {
  return fetch(base + '/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'getblockchaininfo' }),
  });
}

// ---- Body size caps ----

test('POST /api/rpc with an oversized body → 413, and the server keeps serving', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getblockchaininfo', padding: 'x'.repeat(4096) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'request body too large' });
    // rejecting the giant body did not wedge the connection handling
    assert.equal((await postRpc(base)).status, 200);
  }, { bodyLimits: { rpcBytes: 1024 } });
});

test('POST /api/faucet/claim with an oversized body → 413', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/faucet/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'y'.repeat(4096) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'request body too large' });
    // a claim under the cap still reaches the normal path (503: no faucet configured)
    const ok = await fetch(base + '/api/faucet/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'dgbrt1q...' }),
    });
    assert.equal(ok.status, 503);
  }, { bodyLimits: { faucetBytes: 1024 } });
});

test('a body exactly at the limit still parses — no off-by-one in the cap', async () => {
  const limit = 1024;
  await withServer(async (base) => {
    // build a valid JSON-RPC body of EXACTLY `limit` bytes
    const skeleton = JSON.stringify({ method: 'getblockchaininfo', padding: '' });
    const atLimit = skeleton.slice(0, -2) + 'x'.repeat(limit - skeleton.length) + '"}';
    assert.equal(Buffer.byteLength(atLimit), limit);
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: atLimit,
    });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).result.blocks > 0);

    // limit + 1 bytes, still valid JSON, must tip over
    const oneOver = atLimit.slice(0, -2) + 'x"}';
    assert.equal(Buffer.byteLength(oneOver), limit + 1);
    const over = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oneOver,
    });
    assert.equal(over.status, 413);
  }, { bodyLimits: { rpcBytes: limit } });
});

// ---- Rate limits ----

test('rate limit: the (max+1)th POST /api/rpc in a window → 429 + retry-after', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await postRpc(base)).status, 200, `request ${i + 1} within allowance`);
    }
    const res = await postRpc(base);
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'rate limit exceeded — slow down' });
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 60, `retry-after ${retryAfter}`);
    // endpoint classes without a limiter still answer
    assert.equal((await fetch(base + '/api/config')).status, 200);
  }, { rateLimits: { windowMs: 60_000, rpcMax: 3 } });
});

test('rate-limit buckets are per endpoint class: a burned rpc bucket does not 429 /api/indexer', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 3; i++) await postRpc(base);
    assert.equal((await postRpc(base)).status, 429, 'rpc bucket exhausted');
    const res = await fetch(base + '/api/indexer/address/dgbrt1qfoo/utxos');
    assert.notEqual(res.status, 429, 'indexer bucket untouched');
    assert.equal(res.status, 503, 'no indexer configured');
  }, { rateLimits: { windowMs: 60_000, rpcMax: 3 } });
});

test('faucet claims have their own, tighter bucket', async () => {
  await withServer(async (base) => {
    const claim = () => fetch(base + '/api/faucet/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'dgbrt1q...' }),
    });
    assert.equal((await claim()).status, 503, 'within allowance: normal path (no faucet configured)');
    assert.equal((await claim()).status, 503);
    const res = await claim();
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  }, { rateLimits: { windowMs: 60_000, faucetMax: 2 } });
});

test('behind a loopback proxy, buckets key on the PROXY-APPENDED (last) x-forwarded-for element — not the client-supplied prefix (security F1)', async () => {
  await withServer(async (base) => {
    const rpcAs = (ip) => fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ method: 'getblockchaininfo' }),
    });
    // visitor A burns their own allowance…
    assert.equal((await rpcAs('203.0.113.7')).status, 200);
    assert.equal((await rpcAs('203.0.113.7')).status, 200);
    assert.equal((await rpcAs('203.0.113.7')).status, 429, 'A exhausted A\'s bucket');
    // …without touching visitor B's (the pre-fix behavior pooled both into
    // the loopback socket address and B would 429 here)
    assert.equal((await rpcAs('198.51.100.9')).status, 200, 'B has their own bucket');
    // THE FIX: nginx appends the real peer LAST, so the key is the last
    // element. A spoofed prefix must NOT open a fresh bucket — same real IP
    // (last), same bucket, regardless of what the client prepends.
    assert.equal((await rpcAs('1.1.1.1, 198.51.100.9')).status, 200, 'C: real IP 198.51.100.9 (last), first hit');
    assert.equal((await rpcAs('2.2.2.2, 198.51.100.9')).status, 429, 'spoofed prefix cannot dodge C\'s bucket — last element is the key');
    // a garbage / non-IP header cannot key its own bucket — it falls back to
    // the shared loopback PEER bucket, so rotating junk all pools together
    assert.equal((await rpcAs('not-an-ip')).status, 200, 'junk #1 → peer bucket');
    assert.equal((await rpcAs('also-junk')).status, 200, 'junk #2 → same peer bucket');
    assert.equal((await rpcAs('more/junk')).status, 429, 'non-IP headers all share the peer bucket — cannot each mint one');
  }, { rateLimits: { windowMs: 60_000, rpcMax: 2 } });
});

test('spoofing the x-forwarded-for PREFIX no longer bypasses the limit (F1 regression guard)', async () => {
  await withServer(async (base) => {
    const rpcSpoof = (n) => fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.${n}, 203.0.113.50` },
      body: JSON.stringify({ method: 'getblockchaininfo' }),
    });
    // every request carries a UNIQUE spoofed prefix but the same real (last) IP
    assert.equal((await rpcSpoof(1)).status, 200);
    assert.equal((await rpcSpoof(2)).status, 200);
    assert.equal((await rpcSpoof(3)).status, 429, 'rotating the spoofed prefix does NOT mint fresh buckets');
  }, { rateLimits: { windowMs: 60_000, rpcMax: 2 } });
});

// ---- HSTS ----

test('HSTS: off by default; HSTS=1 at server start adds it to every response', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(base + '/api/config')).headers.get('strict-transport-security'), null);
    assert.equal((await postRpc(base)).headers.get('strict-transport-security'), null);
  });

  const saved = process.env.HSTS;
  process.env.HSTS = '1';
  try {
    await withServer(async (base) => {
      for (const res of [await fetch(base + '/api/config'), await postRpc(base), await fetch(base + '/')]) {
        assert.equal(res.headers.get('strict-transport-security'), 'max-age=15552000; includeSubDomains');
      }
    });
  } finally {
    if (saved === undefined) delete process.env.HSTS;
    else process.env.HSTS = saved;
  }
});

// ---- /api/events (SSE server push) ----

test('/api/events is a live SSE stream: right headers, immediate hello, clean detach', async () => {
  await withServer(async (base) => {
    const ac = new AbortController();
    const res = await fetch(base + '/api/events', { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no'); // nginx must not buffer the stream
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /: connected/);
    ac.abort(); // detaching must not wedge the server…
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await postRpc(base)).status, 200); // …which keeps serving
  });
});

// ---- F3: the bulk indexer read is weighed by address count ----

test('rate limit: a bulk indexer POST spends one token PER ADDRESS, not one per request', async () => {
  await withServer(async (base) => {
    const post = (n) => fetch(base + '/api/indexer/addresses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: Array.from({ length: n }, (_, i) => `addr${i}`) }),
    });
    // 3 addresses against an allowance of 5 → passes the limiter (503: no
    // indexer configured in mock mode — the request REACHED the proxy)
    assert.equal((await post(3)).status, 503);
    // 3 more in the same window → count 6 > 5 → limited. Had this cost 1
    // token per request, both would have sailed through.
    const res = await post(3);
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'rate limit exceeded — slow down' });
    // a single-address POST still costs exactly 1 — but the window is spent
    assert.equal((await post(1)).status, 429);
  }, { rateLimits: { indexerMax: 5 } });
});

test('POST /api/indexer/addresses with an oversized body → 413 at the route, before any limiter token or upstream call', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/indexer/addresses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: ['a'], pad: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'request body too large' });
  });
});

test('an unparseable bulk body costs 1 token and is answered by the indexer path, not a crash', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/indexer/addresses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    // mock mode has no indexer configured: the weigh step tolerated the bad
    // JSON (cost 1) and handed the body through for the proxy to reject
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'no indexer configured' });
  });
});
