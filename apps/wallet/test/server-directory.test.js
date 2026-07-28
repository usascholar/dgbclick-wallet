// "Spend DD" merchant directory tests: seed fallback, remote fetch with
// validation, vote toggle / per-IP uniqueness / persistence, rate limits.
// Mirrors the withServer pattern from server-hardening.test.js; every test
// gets its own temp dataDir so vote state never leaks between tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';

const MERCHANTS = [
  { id: 'dgb-cafe', name: 'DGB Café', url: 'https://dgb.cafe', category: 'food', blurb: 'Coffee for DigiDollars', addedAt: '2026-01-15T00:00:00.000Z' },
  { id: 'chain-books', name: 'Chain Books', url: 'https://books.example.com', category: 'books', blurb: 'Second-hand tech books', addedAt: '2026-02-01T00:00:00.000Z' },
  { id: 'sat-vpn', name: 'Sat VPN', url: 'https://satvpn.example.com', category: 'services', blurb: 'VPN payable in DD', addedAt: '2026-03-01T00:00:00.000Z' },
];

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'diginaut-dir-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withServer(fn, overrides = {}) {
  const server = startServer({ port: 0, ...overrides }); // mock mode: no RPC creds passed
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, server);
  } finally {
    server.close();
  }
}

// A local stub standing in for the public merchants repo file. `payload` may
// be anything JSON-serializable (including invalid entries); the stub URL is
// handed to the wallet as directoryUrl. Callers may keep the stub alive
// across multiple wallet servers (persistence test) via the second arg.
async function withMerchantSource(payload, fn) {
  let hits = 0;
  const stub = createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  stub.listen(0);
  await once(stub, 'listening');
  const url = `http://127.0.0.1:${stub.address().port}/merchants.json`;
  try {
    return await fn(url, { stub, hits: () => hits });
  } finally {
    stub.close();
  }
}

// The bundled seed is the last-resort fallback; tests assert its *shape* and
// that the server serves it verbatim, never its emptiness — the seed carries
// real launch merchants.
const SEED_URL = new URL('../merchants.seed.json', import.meta.url);
async function loadSeed() {
  return JSON.parse(await readFile(SEED_URL, 'utf8'));
}

function vote(base, id, ip, token) {
  return fetch(base + '/api/directory/vote', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip && { 'x-forwarded-for': ip }),
      ...(token && { 'x-voter-token': token }),
    },
    body: JSON.stringify({ id }),
  });
}

// ---- Reads ----

test('seed fallback: no directoryUrl → the bundled seed list, shape intact', async () => {
  await withTempDir(async (dataDir) => {
    await withServer(async (base) => {
      const seed = await loadSeed();
      const res = await fetch(base + '/api/directory');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.merchants.length, seed.length, 'serves the seed verbatim');
      assert.deepEqual(body.merchants.map((m) => m.id), seed.map((m) => m.id));
      for (const m of body.merchants) {
        assert.deepEqual(Object.keys(m).sort(), ['addedAt', 'blurb', 'category', 'id', 'name', 'url', 'votedByYou', 'votes']);
        assert.equal(m.votes, 0);
        assert.equal(m.votedByYou, false);
      }
      assert.equal(body.listUrl, 'https://dgbclick.com');
      assert.ok(!Number.isNaN(Date.parse(body.updatedAt)), `updatedAt is an ISO string: ${body.updatedAt}`);
    }, { dataDir });
  });
});

test('remote source: GET returns the stub merchants with votes merged, then reflects a vote', async () => {
  await withTempDir(async (dataDir) => {
    await withMerchantSource(MERCHANTS, async (url) => {
      await withServer(async (base) => {
        const res = await fetch(base + '/api/directory');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.merchants.length, 3);
        for (const m of body.merchants) {
          assert.deepEqual(Object.keys(m).sort(), ['addedAt', 'blurb', 'category', 'id', 'name', 'url', 'votedByYou', 'votes']);
          assert.equal(m.votes, 0);
          assert.equal(m.votedByYou, false);
        }
        assert.ok(!Number.isNaN(Date.parse(body.updatedAt)));
        assert.equal(body.listUrl, 'https://dgbclick.com');

        // votes merge into the list response, keyed to the requester
        const v = await vote(base, 'dgb-cafe');
        assert.equal(v.status, 200);
        const after = await (await fetch(base + '/api/directory')).json();
        const cafe = after.merchants.find((m) => m.id === 'dgb-cafe');
        assert.equal(cafe.votes, 1);
        assert.equal(cafe.votedByYou, true); // same loopback peer, no XFF → same voter
        assert.equal(after.merchants.find((m) => m.id === 'sat-vpn').votes, 0);
      }, { directoryUrl: url, dataDir });
    });
  });
});

test('validation drops bad entries but never the list: 2 of 5 invalid → 3 served, still 200', async () => {
  await withTempDir(async (dataDir) => {
    const mixed = [
      ...MERCHANTS,
      { id: 'http-only', name: 'Plain HTTP Shop', url: 'http://insecure.example.com', category: 'misc' },
      { id: 'BAD ID!', name: 'Bad Id', url: 'https://ok.example.com', category: 'misc' },
    ];
    await withMerchantSource(mixed, async (url) => {
      await withServer(async (base) => {
        const res = await fetch(base + '/api/directory');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.merchants.map((m) => m.id).sort(), ['chain-books', 'dgb-cafe', 'sat-vpn']);
      }, { directoryUrl: url, dataDir });
    });
  });
});

test('in-memory cache: a second GET within directoryCacheMs does not refetch', async () => {
  await withTempDir(async (dataDir) => {
    await withMerchantSource(MERCHANTS, async (url, source) => {
      await withServer(async (base) => {
        await (await fetch(base + '/api/directory')).json();
        await (await fetch(base + '/api/directory')).json();
        assert.equal(source.hits(), 1, 'second read served from memory cache');
      }, { directoryUrl: url, directoryCacheMs: 60_000, dataDir });
    });
  });
});

// ---- Voting ----

test('vote toggle: add then remove; the response carries no hash or IP', async () => {
  await withTempDir(async (dataDir) => {
    await withMerchantSource(MERCHANTS, async (url) => {
      await withServer(async (base) => {
        const first = await vote(base, 'dgb-cafe');
        assert.equal(first.status, 200);
        const a = await first.json();
        assert.deepEqual(a, { id: 'dgb-cafe', votes: 1, voted: true });
        // privacy: nothing but the contract keys — no hash, no IP
        assert.deepEqual(Object.keys(a).sort(), ['id', 'voted', 'votes']);

        const second = await vote(base, 'dgb-cafe');
        assert.deepEqual(await second.json(), { id: 'dgb-cafe', votes: 0, voted: false });
      }, { directoryUrl: url, dataDir });
    });
  });
});

test('per-IP uniqueness: two XFF visitors each get one vote; un-vote releases it', async () => {
  await withTempDir(async (dataDir) => {
    await withMerchantSource(MERCHANTS, async (url) => {
      await withServer(async (base) => {
        // requests come from loopback, so x-forwarded-for is honored
        assert.deepEqual(await (await vote(base, 'sat-vpn', '203.0.113.7')).json(), { id: 'sat-vpn', votes: 1, voted: true });
        assert.deepEqual(await (await vote(base, 'sat-vpn', '198.51.100.9')).json(), { id: 'sat-vpn', votes: 2, voted: true });
        // A voting again is a no-op toggle OFF, not a second vote
        assert.deepEqual(await (await vote(base, 'sat-vpn', '203.0.113.7')).json(), { id: 'sat-vpn', votes: 1, voted: false });
        // B's vote still stands, and B still sees votedByYou on the list
        const list = await (await fetch(base + '/api/directory', { headers: { 'x-forwarded-for': '198.51.100.9' } })).json();
        const vpn = list.merchants.find((m) => m.id === 'sat-vpn');
        assert.equal(vpn.votes, 1);
        assert.equal(vpn.votedByYou, true);
      }, { directoryUrl: url, dataDir });
    });
  });
});

test('voter tokens: two wallets behind ONE IP are two voters — additive, independent', async () => {
  await withTempDir(async (dataDir) => {
    await withMerchantSource(MERCHANTS, async (url) => {
      await withServer(async (base) => {
        // The reported bug: wallet A votes; wallet B on the same network is
        // the SAME IP voter, so B's click toggled A's vote off. With per-
        // wallet tokens, both votes land and neither can remove the other's.
        const walletA = 'a'.repeat(32);
        const walletB = 'b'.repeat(32);
        const sameHomeIp = '203.0.113.7';
        assert.deepEqual(await (await vote(base, 'dgb-cafe', sameHomeIp, walletA)).json(), { id: 'dgb-cafe', votes: 1, voted: true });
        assert.deepEqual(await (await vote(base, 'dgb-cafe', sameHomeIp, walletB)).json(), { id: 'dgb-cafe', votes: 2, voted: true });
        // B un-voting releases only B's vote — A's still stands
        assert.deepEqual(await (await vote(base, 'dgb-cafe', sameHomeIp, walletB)).json(), { id: 'dgb-cafe', votes: 1, voted: false });
        // …and each wallet sees its OWN votedByYou on the list, same IP or not
        const listA = await (await fetch(base + '/api/directory', { headers: { 'x-forwarded-for': sameHomeIp, 'x-voter-token': walletA } })).json();
        const cafeForA = listA.merchants.find((m) => m.id === 'dgb-cafe');
        assert.equal(cafeForA.votes, 1);
        assert.equal(cafeForA.votedByYou, true);
        const listB = await (await fetch(base + '/api/directory', { headers: { 'x-forwarded-for': sameHomeIp, 'x-voter-token': walletB } })).json();
        assert.equal(listB.merchants.find((m) => m.id === 'dgb-cafe').votedByYou, false);
      }, { directoryUrl: url, dataDir });
    });
  });
});

test('voter token validation: malformed/absent tokens fall back to IP keying', async () => {
  await withTempDir(async (dataDir) => {
    await withMerchantSource(MERCHANTS, async (url) => {
      await withServer(async (base) => {
        const ip = '203.0.113.7';
        // garbage token is ignored, NOT a 400 — the vote keys on the IP…
        assert.deepEqual(await (await vote(base, 'sat-vpn', ip, 'not-a-token')).json(), { id: 'sat-vpn', votes: 1, voted: true });
        // …so a tokenless old client from the same IP is the same voter
        assert.deepEqual(await (await vote(base, 'sat-vpn', ip)).json(), { id: 'sat-vpn', votes: 0, voted: false });
        // oversized but hex-shaped token is likewise ignored (pattern bounds length)
        assert.deepEqual(await (await vote(base, 'sat-vpn', ip, 'c'.repeat(128))).json(), { id: 'sat-vpn', votes: 1, voted: true });
      }, { directoryUrl: url, dataDir });
    });
  });
});

test('persistence: votes survive a server restart on the same dataDir', async () => {
  await withTempDir(async (dataDir) => {
    await withMerchantSource(MERCHANTS, async (url) => {
      await withServer(async (base) => {
        assert.equal((await vote(base, 'chain-books', '203.0.113.7')).status, 200);
        assert.equal((await vote(base, 'chain-books', '198.51.100.9')).status, 200);
      }, { directoryUrl: url, dataDir });
      // server closed; a fresh server on the SAME dataDir sees the votes
      await withServer(async (base) => {
        const list = await (await fetch(base + '/api/directory', { headers: { 'x-forwarded-for': '203.0.113.7' } })).json();
        const books = list.merchants.find((m) => m.id === 'chain-books');
        assert.equal(books.votes, 2);
        assert.equal(books.votedByYou, true); // salt persisted too → same hash for the same IP
        // …and the file itself holds only hashes, never IPs
        const stored = JSON.parse(await readFile(join(dataDir, 'votes.json'), 'utf8'));
        assert.ok(typeof stored.salt === 'string' && stored.salt.length > 0);
        assert.equal(stored.votes['chain-books'].length, 2);
        assert.ok(!JSON.stringify(stored).includes('203.0.113.7'));
      }, { directoryUrl: url, dataDir });
    });
  });
});

test('unknown id → 400; malformed id → 400; invalid JSON → 400; oversized body → 413', async () => {
  await withTempDir(async (dataDir) => {
    await withMerchantSource(MERCHANTS, async (url) => {
      await withServer(async (base) => {
        const unknown = await vote(base, 'no-such-shop');
        assert.equal(unknown.status, 400);
        assert.deepEqual(await unknown.json(), { error: 'unknown merchant id' });

        const malformed = await vote(base, 'BAD ID!');
        assert.equal(malformed.status, 400);
        assert.deepEqual(await malformed.json(), { error: 'malformed merchant id' });

        const badJson = await fetch(base + '/api/directory/vote', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
        });
        assert.equal(badJson.status, 400);
        assert.deepEqual(await badJson.json(), { error: 'invalid JSON body' });

        const oversized = await fetch(base + '/api/directory/vote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'dgb-cafe', padding: 'x'.repeat(8192) }),
        });
        assert.equal(oversized.status, 413);
        assert.deepEqual(await oversized.json(), { error: 'request body too large' });
      }, { directoryUrl: url, dataDir });
    });
  });
});

// ---- Fallback ladder ----

test('fetch failure with no cache and no snapshot → seed fallback', async () => {
  await withTempDir(async (dataDir) => {
    // a stub that is already dead: connection refused on every fetch
    const dead = createServer();
    dead.listen(0);
    await once(dead, 'listening');
    const url = `http://127.0.0.1:${dead.address().port}/merchants.json`;
    const deadClosed = once(dead, 'close');
    dead.close();
    await deadClosed;

    await withServer(async (base) => {
      const seed = await loadSeed();
      const res = await fetch(base + '/api/directory');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.merchants.map((m) => m.id), seed.map((m) => m.id), 'serves the seed verbatim');
    }, { directoryUrl: url, dataDir });
  });
});

test('fetch failure after a successful fetch → the persisted snapshot is served', async () => {
  await withTempDir(async (dataDir) => {
    await withMerchantSource(MERCHANTS, async (url, source) => {
      // first server: populates the memory cache AND the snapshot file
      await withServer(async (base) => {
        assert.equal((await (await fetch(base + '/api/directory')).json()).merchants.length, 3);
      }, { directoryUrl: url, dataDir });
      // wait for the fire-and-forget snapshot write to land
      const snapshot = JSON.parse(await readFile(join(dataDir, 'merchants.cache.json'), 'utf8'));
      assert.equal(snapshot.merchants.length, 3);

      // kill the source; a fresh server has no memory cache → snapshot
      const stubClosed = once(source.stub, 'close');
      source.stub.close();
      await stubClosed;
      await withServer(async (base) => {
        const body = await (await fetch(base + '/api/directory')).json();
        assert.deepEqual(body.merchants.map((m) => m.id).sort(), ['chain-books', 'dgb-cafe', 'sat-vpn']);
        assert.equal(body.updatedAt, snapshot.fetchedAt);
      }, { directoryUrl: url, dataDir });
    });
  });
});

// ---- Rate limits ----

test('rate limit: the (voteMax+1)th vote in a window → 429 + retry-after', async () => {
  await withTempDir(async (dataDir) => {
    await withMerchantSource(MERCHANTS, async (url) => {
      await withServer(async (base) => {
        assert.equal((await vote(base, 'dgb-cafe')).status, 200);
        assert.equal((await vote(base, 'dgb-cafe')).status, 200);
        const res = await vote(base, 'dgb-cafe');
        assert.equal(res.status, 429);
        assert.deepEqual(await res.json(), { error: 'rate limit exceeded — slow down' });
        assert.ok(Number(res.headers.get('retry-after')) > 0);
        // the read bucket is separate — directory GETs still answer
        assert.equal((await fetch(base + '/api/directory')).status, 200);
      }, { directoryUrl: url, dataDir, rateLimits: { windowMs: 60_000, voteMax: 2 } });
    });
  });
});

test('rate limit: directory reads have their own generous bucket', async () => {
  await withTempDir(async (dataDir) => {
    await withServer(async (base) => {
      for (let i = 0; i < 3; i++) assert.equal((await fetch(base + '/api/directory')).status, 200);
      const res = await fetch(base + '/api/directory');
      assert.equal(res.status, 429);
      // votes are unaffected by a burned read bucket
      const v = await vote(base, 'whatever-id');
      assert.notEqual(v.status, 429);
      assert.equal(v.status, 400, 'whatever-id is not a listed merchant → unknown id');
    }, { dataDir, rateLimits: { windowMs: 60_000, directoryMax: 3 } });
  });
});
