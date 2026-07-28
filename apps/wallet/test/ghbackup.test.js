// FR-8 GitHub backup provider, exercised entirely through a mock fetchImpl —
// a tiny (method, url) router — and Map-backed storage. No network, no real
// token: what we verify is the contract the UI depends on (sha dance, 409
// retry, error wording) and the security invariant that the token can never
// leak into a thrown message (canary test below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubBackup, GH_STORE_KEY } from '../public/ghbackup.js';

const TOKEN = 'canary-token-CANARY-123';
const BASE = 'https://api.github.com';
const REPO = `${BASE}/repos/alice/backups`;

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// routes: { 'METHOD url': { status, body } | (init) => { status, body } }
// Every call is recorded so tests can count PUTs and inspect request bodies.
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, init });
    const handler = routes[`${method} ${url}`];
    if (!handler) return { status: 404, async json() { return { message: 'Not Found' }; } };
    const out = typeof handler === 'function' ? handler(init) : handler;
    return { status: out.status, async json() { return out.body; } };
  };
  fn.calls = calls;
  return fn;
}

function connected(storage, fetchImpl) {
  storage.setItem(GH_STORE_KEY, JSON.stringify({ token: TOKEN, owner: 'alice', repo: 'backups' }));
  return createGitHubBackup({ fetchImpl, storage });
}

const puts = (fetchFn) => fetchFn.calls.filter((c) => c.method === 'PUT');
const putBody = (call) => JSON.parse(call.init.body);
// Node-side decode of the base64 the provider sent — what GitHub would store.
const putText = (call) => Buffer.from(putBody(call).content, 'base64').toString('utf8');

// --- connect ---------------------------------------------------------------

test('connect: private repo stores the target and returns its full name', async () => {
  const storage = memStorage();
  const fetchImpl = mockFetch({
    [`GET ${REPO}`]: { status: 200, body: { private: true, full_name: 'alice/backups' } },
  });
  const gh = createGitHubBackup({ fetchImpl, storage });
  const r = await gh.connect({ token: TOKEN, owner: 'alice', repo: 'backups' });
  assert.deepEqual(r, { fullName: 'alice/backups', isPrivate: true });
  assert.deepEqual(gh.savedTarget(), { owner: 'alice', repo: 'backups' });
  assert.equal(gh.hasToken(), true);
  // display surface must not expose the token
  assert.equal(JSON.stringify(gh.savedTarget()).includes(TOKEN), false);
  // auth header shape the Contents API expects
  const headers = fetchImpl.calls[0].init.headers;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('connect: a PUBLIC repository is refused and nothing is stored', async () => {
  const storage = memStorage();
  const fetchImpl = mockFetch({
    [`GET ${REPO}`]: { status: 200, body: { private: false } },
  });
  const gh = createGitHubBackup({ fetchImpl, storage });
  await assert.rejects(
    () => gh.connect({ token: TOKEN, owner: 'alice', repo: 'backups' }),
    /PUBLIC — make it private first/,
  );
  assert.equal(gh.hasToken(), false);
});

test('connect: 401/403/404 each map to their plain-English message', async () => {
  for (const [status, pattern] of [
    [401, /rejected the token/],
    [403, /Contents: Read and write/],
    [404, /create a PRIVATE repository first/],
  ]) {
    const fetchImpl = mockFetch({ [`GET ${REPO}`]: { status, body: {} } });
    const gh = createGitHubBackup({ fetchImpl, storage: memStorage() });
    await assert.rejects(() => gh.connect({ token: TOKEN, owner: 'alice', repo: 'backups' }), pattern);
  }
});

test('connect: a network failure says GitHub is unreachable', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const gh = createGitHubBackup({ fetchImpl, storage: memStorage() });
  await assert.rejects(
    () => gh.connect({ token: TOKEN, owner: 'alice', repo: 'backups' }),
    /unreachable — check the connection/,
  );
});

test('connect: inputs are validated before any network call', async () => {
  const fetchImpl = mockFetch({});
  const gh = createGitHubBackup({ fetchImpl, storage: memStorage() });
  await assert.rejects(() => gh.connect({ token: '', owner: 'alice', repo: 'backups' }), /enter the token/);
  await assert.rejects(() => gh.connect({ token: TOKEN, owner: '  ', repo: 'backups' }), /enter the repository owner/);
  await assert.rejects(() => gh.connect({ token: TOKEN, owner: 'no spaces!', repo: 'backups' }), /letters, numbers/);
  await assert.rejects(() => gh.connect({ token: TOKEN, owner: 'alice', repo: 'a/b' }), /letters, numbers/);
  assert.equal(fetchImpl.calls.length, 0);
});

// --- pushKeystore -----------------------------------------------------------

test('pushKeystore: missing file → PUT without sha, created:true', async () => {
  const storage = memStorage();
  const fetchImpl = mockFetch({
    [`PUT ${REPO}/contents/wallets/dd100-2036-07-21-a.keystore.json`]: { status: 201, body: {} },
  });
  const gh = connected(storage, fetchImpl);
  const r = await gh.pushKeystore({ slug: 'dd100-2036-07-21-a', keystoreJson: '{"cipher":1}' });
  assert.deepEqual(r, { path: 'wallets/dd100-2036-07-21-a.keystore.json', created: true });
  assert.equal(puts(fetchImpl).length, 1);
  assert.equal(putBody(puts(fetchImpl)[0]).sha, undefined);
  assert.match(putBody(puts(fetchImpl)[0]).message, /^Backup dd100-2036-07-21-a \(\d{4}-\d{2}-\d{2}\)$/);
});

test('pushKeystore: existing file → PUT carries the fetched sha, created:false', async () => {
  const storage = memStorage();
  const fetchImpl = mockFetch({
    [`GET ${REPO}/contents/wallets/dd100-2036-07-21-a.keystore.json`]: { status: 200, body: { sha: 'old-sha' } },
    [`PUT ${REPO}/contents/wallets/dd100-2036-07-21-a.keystore.json`]: { status: 200, body: {} },
  });
  const gh = connected(storage, fetchImpl);
  const r = await gh.pushKeystore({ slug: 'dd100-2036-07-21-a', keystoreJson: '{"cipher":2}' });
  assert.equal(r.created, false);
  assert.equal(putBody(puts(fetchImpl)[0]).sha, 'old-sha');
});

test('pushKeystore: a 409 re-fetches the sha and retries the PUT exactly once', async () => {
  const storage = memStorage();
  let shaReads = 0;
  let putAttempts = 0;
  const fetchImpl = mockFetch({
    // the race: first read says 'sha-1', the world moved, second says 'sha-2'
    [`GET ${REPO}/contents/wallets/dd100-2036-07-21-a.keystore.json`]: () => (
      ++shaReads === 1 ? { status: 200, body: { sha: 'sha-1' } } : { status: 200, body: { sha: 'sha-2' } }
    ),
    [`PUT ${REPO}/contents/wallets/dd100-2036-07-21-a.keystore.json`]: () => (
      ++putAttempts === 1 ? { status: 409, body: {} } : { status: 200, body: {} }
    ),
  });
  const gh = connected(storage, fetchImpl);
  const r = await gh.pushKeystore({ slug: 'dd100-2036-07-21-a', keystoreJson: '{"cipher":3}' });
  assert.equal(r.created, false);
  const allPuts = puts(fetchImpl);
  assert.equal(allPuts.length, 2, 'exactly two PUTs: the raced one and the retry');
  assert.equal(putBody(allPuts[0]).sha, 'sha-1');
  assert.equal(putBody(allPuts[1]).sha, 'sha-2', 'retry must carry the NEW sha');
});

test('pushKeystore: base64 upload round-trips UTF-8 (emoji + accents)', async () => {
  const storage = memStorage();
  const fetchImpl = mockFetch({
    [`PUT ${REPO}/contents/wallets/dd250-2031-07-21-c.keystore.json`]: { status: 201, body: {} },
  });
  const gh = connected(storage, fetchImpl);
  const payload = '{"name":"Trésor 🚀 été","cipher":"…"}';
  await gh.pushKeystore({ slug: 'dd250-2031-07-21-c', keystoreJson: payload });
  assert.equal(putText(puts(fetchImpl)[0]), payload);
});

test('pushKeystore: unsafe slugs are refused before any network call', async () => {
  const fetchImpl = mockFetch({});
  const gh = connected(memStorage(), fetchImpl);
  for (const bad of ['Upper', 'has space', '../escape', '-leading', 'under_score']) {
    await assert.rejects(() => gh.pushKeystore({ slug: bad, keystoreJson: '{}' }), /lowercase letters, numbers and hyphens/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

// --- pushManifest -----------------------------------------------------------

test('pushManifest: a secret-looking field stops the upload', async () => {
  const fetchImpl = mockFetch({});
  const gh = connected(memStorage(), fetchImpl);
  await assert.rejects(
    () => gh.pushManifest({ treasuries: [{ slug: 'dd100-a', mnemonic: 'abandon abandon …' }] }),
    /"mnemonic" — secrets must never be uploaded/,
  );
  assert.equal(fetchImpl.calls.length, 0, 'the guard fires before any network call');
});

test('pushManifest: clean metadata writes the documented shape', async () => {
  const storage = memStorage();
  const fetchImpl = mockFetch({
    [`PUT ${REPO}/contents/manifest.json`]: { status: 201, body: {} },
  });
  const gh = connected(storage, fetchImpl);
  const treasuries = [{
    slug: 'dd100-2036-07-21-a', walletId: 'w-1', name: 'House fund',
    ddAmount: 100, maturity: '2036-07-21', backedUpAt: '2026-07-26T12:00:00.000Z',
  }];
  const r = await gh.pushManifest({ treasuries });
  assert.equal(r.path, 'manifest.json');
  const written = JSON.parse(putText(puts(fetchImpl)[0]));
  assert.equal(written.v, 1);
  assert.equal(typeof written.updatedAt, 'string');
  assert.deepEqual(written.treasuries, treasuries);
});

// --- listKeystores / pullKeystore -------------------------------------------

test('listKeystores: missing wallets folder means an empty list, not an error', async () => {
  const gh = connected(memStorage(), mockFetch({}));
  assert.deepEqual(await gh.listKeystores(), []);
});

test('listKeystores: only *.keystore.json files are returned, as slugs', async () => {
  const fetchImpl = mockFetch({
    [`GET ${REPO}/contents/wallets`]: {
      status: 200,
      body: [
        { type: 'file', name: 'dd100-2036-07-21-a.keystore.json', path: 'wallets/dd100-2036-07-21-a.keystore.json', sha: 's1' },
        { type: 'file', name: 'notes.txt', path: 'wallets/notes.txt', sha: 's2' },
        { type: 'file', name: 'dd250-2031-07-21-c.keystore.json', path: 'wallets/dd250-2031-07-21-c.keystore.json', sha: 's3' },
      ],
    },
  });
  const gh = connected(memStorage(), fetchImpl);
  assert.deepEqual(await gh.listKeystores(), [
    { slug: 'dd100-2036-07-21-a', path: 'wallets/dd100-2036-07-21-a.keystore.json', sha: 's1' },
    { slug: 'dd250-2031-07-21-c', path: 'wallets/dd250-2031-07-21-c.keystore.json', sha: 's3' },
  ]);
});

test('pullKeystore: GitHub line-wrapped base64 decodes to the original JSON text', async () => {
  const original = '{"name":"Trésor 🚀","cipher":{"data":"AAA"}}';
  const raw = Buffer.from(original, 'utf8').toString('base64');
  const wrapped = raw.replace(/(.{20})/g, '$1\n'); // GitHub wraps content every 60 chars
  const fetchImpl = mockFetch({
    [`GET ${REPO}/contents/wallets/dd100-2036-07-21-a.keystore.json`]: {
      status: 200,
      body: { content: wrapped, encoding: 'base64' },
    },
  });
  const gh = connected(memStorage(), fetchImpl);
  assert.equal(await gh.pullKeystore('wallets/dd100-2036-07-21-a.keystore.json'), original);
});

test('pullKeystore: a missing file gets the plain-English message', async () => {
  const gh = connected(memStorage(), mockFetch({}));
  await assert.rejects(() => gh.pullKeystore('wallets/nope.keystore.json'), /not in the repository/);
});

// --- security invariants -----------------------------------------------------

test('no thrown error message ever contains the token', async () => {
  // every failure flavour: bad token, forbidden, missing repo, public repo,
  // unexpected status, offline — the canary must survive none of them
  const scenarios = [
    mockFetch({ [`GET ${REPO}`]: { status: 401, body: {} } }),
    mockFetch({ [`GET ${REPO}`]: { status: 403, body: {} } }),
    mockFetch({ [`GET ${REPO}`]: { status: 404, body: {} } }),
    mockFetch({ [`GET ${REPO}`]: { status: 200, body: { private: false } } }),
    mockFetch({ [`GET ${REPO}`]: { status: 500, body: {} } }),
    async () => { throw new TypeError('fetch failed'); },
  ];
  for (const fetchImpl of scenarios) {
    const gh = createGitHubBackup({ fetchImpl, storage: memStorage() });
    const err = await gh.connect({ token: TOKEN, owner: 'alice', repo: 'backups' }).then(
      () => { throw new Error('expected connect to throw'); },
      (e) => e,
    );
    assert.equal(err.message.includes('CANARY'), false, `leaked via: ${err.message}`);
  }
});

test('operations before connect fail plainly and without network calls', async () => {
  const fetchImpl = mockFetch({});
  const gh = createGitHubBackup({ fetchImpl, storage: memStorage() });
  await assert.rejects(() => gh.pushKeystore({ slug: 'dd100-a', keystoreJson: '{}' }), /connect a repository first/);
  await assert.rejects(() => gh.listKeystores(), /connect a repository first/);
  assert.equal(fetchImpl.calls.length, 0);
});

// --- storage lifecycle --------------------------------------------------------

test('forget() wipes the stored target and token', async () => {
  const storage = memStorage();
  const fetchImpl = mockFetch({
    [`GET ${REPO}`]: { status: 200, body: { private: true, full_name: 'alice/backups' } },
  });
  const gh = createGitHubBackup({ fetchImpl, storage });
  assert.equal(gh.hasToken(), false);
  assert.equal(gh.savedTarget(), null);
  await gh.connect({ token: TOKEN, owner: 'alice', repo: 'backups' });
  assert.equal(gh.hasToken(), true);
  gh.forget();
  assert.equal(gh.hasToken(), false);
  assert.equal(gh.savedTarget(), null);
  assert.equal(storage.getItem(GH_STORE_KEY), null);
});

test('ensureReadme: written once, never overwritten', async () => {
  const storage = memStorage();
  const first = mockFetch({
    [`PUT ${REPO}/contents/README.md`]: { status: 201, body: {} },
  });
  const gh = connected(storage, first);
  const r1 = await gh.ensureReadme();
  assert.deepEqual(r1, { path: 'README.md', created: true });
  const text = putText(puts(first)[0]);
  assert.match(text, /Encrypted DGBclick Wallet treasury backups/);
  assert.match(text, /KEEP THIS REPOSITORY PRIVATE/);
  assert.match(text, /Restore from backup file/);

  const second = mockFetch({
    [`GET ${REPO}/contents/README.md`]: { status: 200, body: { sha: 'readme-sha' } },
  });
  const gh2 = connected(storage, second);
  const r2 = await gh2.ensureReadme();
  assert.deepEqual(r2, { path: 'README.md', created: false });
  assert.equal(puts(second).length, 0, 'an existing README is left alone');
});
