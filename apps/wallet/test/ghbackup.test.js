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
    [`PUT ${REPO}/contents/wallets/w-1/dd100-2036-07-21-a.keystore.json`]: { status: 201, body: {} },
  });
  const gh = connected(storage, fetchImpl);
  const r = await gh.pushKeystore({ walletId: 'w-1', slug: 'dd100-2036-07-21-a', keystoreJson: '{"cipher":1}' });
  assert.deepEqual(r, { path: 'wallets/w-1/dd100-2036-07-21-a.keystore.json', created: true });
  assert.equal(puts(fetchImpl).length, 1);
  assert.equal(putBody(puts(fetchImpl)[0]).sha, undefined);
  assert.match(putBody(puts(fetchImpl)[0]).message, /^Backup dd100-2036-07-21-a \(\d{4}-\d{2}-\d{2}\)$/);
});

test('pushKeystore: existing file → PUT carries the fetched sha, created:false', async () => {
  const storage = memStorage();
  const fetchImpl = mockFetch({
    [`GET ${REPO}/contents/wallets/w-1/dd100-2036-07-21-a.keystore.json`]: { status: 200, body: { sha: 'old-sha' } },
    [`PUT ${REPO}/contents/wallets/w-1/dd100-2036-07-21-a.keystore.json`]: { status: 200, body: {} },
  });
  const gh = connected(storage, fetchImpl);
  const r = await gh.pushKeystore({ walletId: 'w-1', slug: 'dd100-2036-07-21-a', keystoreJson: '{"cipher":2}' });
  assert.equal(r.created, false);
  assert.equal(putBody(puts(fetchImpl)[0]).sha, 'old-sha');
});

test('pushKeystore: a 409 re-fetches the sha and retries the PUT exactly once', async () => {
  const storage = memStorage();
  let shaReads = 0;
  let putAttempts = 0;
  const fetchImpl = mockFetch({
    // the race: first read says 'sha-1', the world moved, second says 'sha-2'
    [`GET ${REPO}/contents/wallets/w-1/dd100-2036-07-21-a.keystore.json`]: () => (
      ++shaReads === 1 ? { status: 200, body: { sha: 'sha-1' } } : { status: 200, body: { sha: 'sha-2' } }
    ),
    [`PUT ${REPO}/contents/wallets/w-1/dd100-2036-07-21-a.keystore.json`]: () => (
      ++putAttempts === 1 ? { status: 409, body: {} } : { status: 200, body: {} }
    ),
  });
  const gh = connected(storage, fetchImpl);
  const r = await gh.pushKeystore({ walletId: 'w-1', slug: 'dd100-2036-07-21-a', keystoreJson: '{"cipher":3}' });
  assert.equal(r.created, false);
  const allPuts = puts(fetchImpl);
  assert.equal(allPuts.length, 2, 'exactly two PUTs: the raced one and the retry');
  assert.equal(putBody(allPuts[0]).sha, 'sha-1');
  assert.equal(putBody(allPuts[1]).sha, 'sha-2', 'retry must carry the NEW sha');
});

test('pushKeystore: base64 upload round-trips UTF-8 (emoji + accents)', async () => {
  const storage = memStorage();
  const fetchImpl = mockFetch({
    [`PUT ${REPO}/contents/wallets/w-1/dd250-2031-07-21-c.keystore.json`]: { status: 201, body: {} },
  });
  const gh = connected(storage, fetchImpl);
  const payload = '{"name":"Trésor 🚀 été","cipher":"…"}';
  await gh.pushKeystore({ walletId: 'w-1', slug: 'dd250-2031-07-21-c', keystoreJson: payload });
  assert.equal(putText(puts(fetchImpl)[0]), payload);
});

test('pushKeystore: unsafe slugs are refused before any network call', async () => {
  const fetchImpl = mockFetch({});
  const gh = connected(memStorage(), fetchImpl);
  for (const bad of ['Upper', 'has space', '../escape', '-leading', 'under_score']) {
    await assert.rejects(() => gh.pushKeystore({ walletId: 'w-1', slug: bad, keystoreJson: '{}' }), /lowercase letters, numbers and hyphens/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

// --- pushManifest -----------------------------------------------------------

test('pushManifest: a secret-looking field stops the upload', async () => {
  const fetchImpl = mockFetch({});
  const gh = connected(memStorage(), fetchImpl);
  await assert.rejects(
    () => gh.pushManifest({ walletId: 'w-1', treasuries: [{ slug: 'dd100-a', mnemonic: 'abandon abandon …' }] }),
    /"mnemonic" — secrets must never be uploaded/,
  );
  assert.equal(fetchImpl.calls.length, 0, 'the guard fires before any network call');
});

test('pushManifest: clean metadata writes the documented shape', async () => {
  const storage = memStorage();
  const fetchImpl = mockFetch({
    [`PUT ${REPO}/contents/manifests/w-1.json`]: { status: 201, body: {} },
  });
  const gh = connected(storage, fetchImpl);
  const treasuries = [{
    slug: 'dd100-2036-07-21-a', walletId: 'w-1', name: 'House fund',
    ddAmount: 100, maturity: '2036-07-21', backedUpAt: '2026-07-26T12:00:00.000Z',
  }];
  const r = await gh.pushManifest({ walletId: 'w-1', treasuries });
  assert.equal(r.path, 'manifests/w-1.json');
  const written = JSON.parse(putText(puts(fetchImpl)[0]));
  assert.equal(written.v, 2);
  assert.equal(written.walletId, 'w-1');
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
    { slug: 'dd100-2036-07-21-a', walletId: null, path: 'wallets/dd100-2036-07-21-a.keystore.json', sha: 's1' },
    { slug: 'dd250-2031-07-21-c', walletId: null, path: 'wallets/dd250-2031-07-21-c.keystore.json', sha: 's3' },
  ]);
});

test('pullKeystore: GitHub line-wrapped base64 decodes to the original JSON text', async () => {
  const original = '{"name":"Trésor 🚀","cipher":{"data":"AAA"}}';
  const raw = Buffer.from(original, 'utf8').toString('base64');
  const wrapped = raw.replace(/(.{20})/g, '$1\n'); // GitHub wraps content every 60 chars
  const fetchImpl = mockFetch({
    [`GET ${REPO}/contents/wallets/w-1/dd100-2036-07-21-a.keystore.json`]: {
      status: 200,
      body: { content: wrapped, encoding: 'base64' },
    },
  });
  const gh = connected(memStorage(), fetchImpl);
  assert.equal(await gh.pullKeystore('wallets/w-1/dd100-2036-07-21-a.keystore.json'), original);
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
  await assert.rejects(() => gh.pushKeystore({ walletId: 'w-1', slug: 'dd100-a', keystoreJson: '{}' }), /connect a repository first/);
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

// --- one repo shared by several wallets -------------------------------------
// The properties below are what make sharing safe. Before namespacing, two
// wallets that each held a $250 treasury maturing 2036-07 with sequence A both
// wrote wallets/dd250-2036-07-a.keystore.json, and the second push silently
// REPLACED the first wallet's encrypted backup through the Contents API update
// path. Nothing surfaced; the file was simply gone.

test('two wallets with an identical slug write to different files', async () => {
  const fetchImpl = mockFetch({
    [`PUT ${REPO}/contents/wallets/w-1/dd250-2036-07-a.keystore.json`]: { status: 201, body: {} },
    [`PUT ${REPO}/contents/wallets/w-2/dd250-2036-07-a.keystore.json`]: { status: 201, body: {} },
  });
  const gh = connected(memStorage(), fetchImpl);
  const a = await gh.pushKeystore({ walletId: 'w-1', slug: 'dd250-2036-07-a', keystoreJson: '{"a":1}' });
  const b = await gh.pushKeystore({ walletId: 'w-2', slug: 'dd250-2036-07-a', keystoreJson: '{"b":2}' });
  assert.notEqual(a.path, b.path, 'the collision that silently ate a backup must be impossible');
  assert.equal(a.path, 'wallets/w-1/dd250-2036-07-a.keystore.json');
  assert.equal(b.path, 'wallets/w-2/dd250-2036-07-a.keystore.json');
});

test('two wallets syncing at once write separate manifests, so neither is lost', async () => {
  const fetchImpl = mockFetch({
    [`PUT ${REPO}/contents/manifests/w-1.json`]: { status: 201, body: {} },
    [`PUT ${REPO}/contents/manifests/w-2.json`]: { status: 201, body: {} },
  });
  const gh = connected(memStorage(), fetchImpl);
  const one = await gh.pushManifest({ walletId: 'w-1', treasuries: [{ slug: 'a', name: 'A' }] });
  const boundary = fetchImpl.calls.length;
  const two = await gh.pushManifest({ walletId: 'w-2', treasuries: [{ slug: 'b', name: 'B' }] });
  assert.equal(one.path, 'manifests/w-1.json');
  assert.equal(two.path, 'manifests/w-2.json');
  // The invariant that makes a shared repo safe: a wallet's sync never READS or
  // WRITES another wallet's manifest. (It does GET its OWN file first, for the
  // sha the Contents API demands on an update — that is not cross-wallet.) With
  // no read-modify-write across wallets there is no update to lose, however the
  // two syncs interleave.
  assert.equal(fetchImpl.calls.slice(boundary).filter((c) => c.url.includes('w-1')).length, 0,
    "wallet 2's sync must never touch wallet 1's manifest");
  assert.equal(fetchImpl.calls.slice(0, boundary).filter((c) => c.url.includes('w-2')).length, 0,
    "wallet 1's sync must never touch wallet 2's manifest");
});

test('a wallet id that could climb out of its folder is refused before any request', async () => {
  const fetchImpl = mockFetch({});
  const gh = connected(memStorage(), fetchImpl);
  for (const bad of ['../README', 'a/b', '', '.', '..', 'w 1', 'w#1']) {
    await assert.rejects(
      () => gh.pushKeystore({ walletId: bad, slug: 'dd100-a', keystoreJson: '{}' }),
      /not usable as a folder name/,
      `wallet id ${JSON.stringify(bad)} must be refused`,
    );
  }
  assert.equal(fetchImpl.calls.length, 0, 'nothing may reach the network');
});

test('listKeystores walks every wallet folder AND still finds legacy flat files', async () => {
  const fetchImpl = mockFetch({
    [`GET ${REPO}/contents/wallets`]: {
      status: 200,
      body: [
        { type: 'file', name: 'old-flat.keystore.json', path: 'wallets/old-flat.keystore.json', sha: 's0' },
        { type: 'dir', name: 'w-1', path: 'wallets/w-1' },
        { type: 'dir', name: 'w-2', path: 'wallets/w-2' },
      ],
    },
    [`GET ${REPO}/contents/wallets/w-1`]: {
      status: 200,
      body: [{ type: 'file', name: 'dd100-a.keystore.json', path: 'wallets/w-1/dd100-a.keystore.json', sha: 's1' }],
    },
    [`GET ${REPO}/contents/wallets/w-2`]: {
      status: 200,
      body: [
        { type: 'file', name: 'dd100-a.keystore.json', path: 'wallets/w-2/dd100-a.keystore.json', sha: 's2' },
        { type: 'file', name: 'notes.txt', path: 'wallets/w-2/notes.txt', sha: 'sx' },
      ],
    },
  });
  const gh = connected(memStorage(), fetchImpl);
  assert.deepEqual(await gh.listKeystores(), [
    { slug: 'old-flat', walletId: null, path: 'wallets/old-flat.keystore.json', sha: 's0' },
    { slug: 'dd100-a', walletId: 'w-1', path: 'wallets/w-1/dd100-a.keystore.json', sha: 's1' },
    { slug: 'dd100-a', walletId: 'w-2', path: 'wallets/w-2/dd100-a.keystore.json', sha: 's2' },
  ]);
});

test('readManifest merges every wallet, and still reads a legacy manifest.json', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
  const fetchImpl = mockFetch({
    [`GET ${REPO}/contents/manifests`]: {
      status: 200,
      body: [
        { type: 'file', name: 'w-1.json', path: 'manifests/w-1.json' },
        { type: 'file', name: 'w-2.json', path: 'manifests/w-2.json' },
      ],
    },
    [`GET ${REPO}/contents/manifests/w-1.json`]: { status: 200, body: { content: b64({ v: 2, treasuries: [{ name: 'A' }] }) } },
    [`GET ${REPO}/contents/manifests/w-2.json`]: { status: 200, body: { content: b64({ v: 2, treasuries: [{ name: 'B' }] }) } },
    [`GET ${REPO}/contents/manifest.json`]: { status: 200, body: { content: b64({ v: 1, treasuries: [{ name: 'OLD' }] }) } },
  });
  const gh = connected(memStorage(), fetchImpl);
  const { treasuries } = await gh.readManifest();
  assert.deepEqual(treasuries.map((t) => t.name).sort(), ['A', 'B', 'OLD'],
    'a restore must find a treasury backed up by ANY wallet, including an older layout');
});

test('readManifest survives a corrupt manifest instead of blocking every restore', async () => {
  const fetchImpl = mockFetch({
    [`GET ${REPO}/contents/manifests`]: {
      status: 200,
      body: [{ type: 'file', name: 'w-1.json', path: 'manifests/w-1.json' }],
    },
    [`GET ${REPO}/contents/manifests/w-1.json`]: { status: 200, body: { content: Buffer.from('{ not json', 'utf8').toString('base64') } },
  });
  const gh = connected(memStorage(), fetchImpl);
  assert.deepEqual(await gh.readManifest(), { treasuries: [] });
});

test('readManifest on a fresh repo is empty, not an error', async () => {
  const gh = connected(memStorage(), mockFetch({}));
  assert.deepEqual(await gh.readManifest(), { treasuries: [] });
});

// --- manifest entry selection on restore -------------------------------------
// Matching by display name ALONE across all wallets' merged manifests attached
// another wallet's DD amount and unlock date to the restored card whenever two
// wallets held a same-named treasury — wrong-money metadata that then
// propagated into future backups. The file's own wallet folder is the
// disambiguator.

test('a namespaced restore takes metadata only from its own wallet', async () => {
  const { pickManifestEntry } = await import('../public/ghbackup.js');
  const treasuries = [
    { walletId: 'w-1', name: 'DD250 2036-07 A', ddAmount: 250, maturity: '2036-07-21' },
    { walletId: 'w-2', name: 'DD250 2036-07 A', ddAmount: 999, maturity: '2031-01-01' },
  ];
  const hit = pickManifestEntry(treasuries, { name: 'DD250 2036-07 A', sourceWalletId: 'w-2' });
  assert.equal(hit.ddAmount, 999, 'must take w-2 metadata for a file pulled from w-2');
  assert.equal(pickManifestEntry(treasuries, { name: 'DD250 2036-07 A', sourceWalletId: 'w-1' }).ddAmount, 250);
});

test('a namespaced file with no entry in ITS wallet gets nothing, never a name-match from elsewhere', async () => {
  const { pickManifestEntry } = await import('../public/ghbackup.js');
  const treasuries = [{ walletId: 'w-1', name: 'House fund', ddAmount: 100 }];
  assert.equal(pickManifestEntry(treasuries, { name: 'House fund', sourceWalletId: 'w-9' }), null,
    'no metadata is strictly better than another wallet\'s metadata');
});

test('a legacy flat file still matches by name, as it always did', async () => {
  const { pickManifestEntry } = await import('../public/ghbackup.js');
  const treasuries = [{ walletId: 'w-1', name: 'House fund', ddAmount: 100 }];
  assert.equal(pickManifestEntry(treasuries, { name: 'House fund', sourceWalletId: null }).ddAmount, 100);
  assert.equal(pickManifestEntry(treasuries, { name: 'Nope', sourceWalletId: null }), null);
  assert.equal(pickManifestEntry(undefined, { name: 'x', sourceWalletId: null }), null, 'no manifest at all is not a crash');
});
