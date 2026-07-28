// FR-8 GitHub backup provider: pushes ALREADY-ENCRYPTED .keystore.json files
// to one private GitHub repo via the Contents API, so a newbie has an
// off-device backup and the repo file listing works as a searchable inventory
// (filenames carry the FR-6 self-describing slug — Ctrl+F for `dd250` or
// `2036-07` on the repo page finds the treasury).
//
// Security model (non-negotiable, per docs/treasury-wallets-spec.md FR-8):
// - This module never sees plaintext: callers hand us keystore JSON that the
//   wallet's existing encryption already produced. Only those bytes upload.
// - The token lives only in browser storage and is sent only to api.github.com
//   over HTTPS. It must NEVER appear in an error message, so every failure is
//   mapped to a fixed plain-English string and nothing from the request (or
//   the token) is interpolated. Tests enforce this with a canary token.
// - manifest.json is metadata only (slugs, amounts, maturities). A guard rail
//   refuses to write it if any field name smells like key material.

export const GH_STORE_KEY = 'diginaut.ghBackup';

// Fixed plain-English messages. Newbie-facing, and — critically — constant:
// no user input, status detail, or token ever gets concatenated in.
const MSG_PUBLIC =
  'that repository is PUBLIC — make it private first (or create a new private one); ' +
  'encrypted backups still belong out of sight';
const MSG_401 = 'GitHub rejected the token — check it was copied fully and has not expired';
const MSG_403 = 'the token cannot write to that repository — it needs Contents: Read and write on it';
const MSG_404_REPO = 'repository not found — create a PRIVATE repository first, or check owner/name';
const MSG_NETWORK = 'GitHub is unreachable — check the connection and try again';
const MSG_NOT_CONNECTED = 'no GitHub backup is connected yet — connect a repository first';
const MSG_FILE_MISSING = 'that backup file is not in the repository';

const API_VERSION = '2022-11-28';
const KEYSTORE_SUFFIX = '.keystore.json';

// Written once into a fresh repo so anyone who later stumbles onto it (or the
// user themselves, months on) understands what it holds and how to restore.
const README_TEXT = `# Encrypted DGBclick Wallet treasury backups

This repository holds encrypted backup files of DigiByte treasury wallets
created by the DGBclick Wallet browser wallet.

- Every file under \`wallets/\` is a \`.keystore.json\` that was encrypted in
  the browser BEFORE it was uploaded. GitHub only ever stores scrambled data.
- Without the wallet password these files are useless — no keys, seeds or
  passwords exist in this repository in readable form.
- \`manifest.json\` is an inventory only (names, amounts, unlock dates).

## How to restore

1. Open https://wallet.dgbclick.com in your browser.
2. Choose "Get started" → "Restore from backup file".
3. Pick a \`.keystore.json\` file from the \`wallets/\` folder here and enter
   the wallet password you used when that treasury was created.

## KEEP THIS REPOSITORY PRIVATE

Even though everything here is encrypted, treat this backup as sensitive.
Never make this repository public. If it is ever exposed, move the funds to
new wallets. A GitHub backup protects against device loss — it cannot help
with a forgotten password, so keep your written seed words safe too.
`;

// GitHub base64 line-wraps file contents it returns; a plain atob would choke
// on the newlines, so strip whitespace before decoding. Decoding goes through
// UTF-8 bytes — keystore payloads can carry non-ASCII (emoji in wallet names).
function utf8ToBase64(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}
function base64ToUtf8(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  return new TextDecoder().decode(Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)));
}

// Field names that must never reach the manifest. Deliberately broad
// (substring match) — a false positive on a legit metadata field is a one-line
// rename; a false negative uploads someone's seed.
const FORBIDDEN_FIELD = /key|seed|secret|mnemonic|private|password/i;
function assertNoSecrets(node, trail = 'manifest') {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => assertNoSecrets(item, `${trail}[${i}]`));
    return;
  }
  for (const [field, value] of Object.entries(node)) {
    if (FORBIDDEN_FIELD.test(field)) {
      throw new Error(
        `the backup manifest tried to include a field called "${field}" — ` +
        'secrets must never be uploaded, so the backup was stopped',
      );
    }
    assertNoSecrets(value, `${trail}.${field}`);
  }
}

export function createGitHubBackup({
  fetchImpl = globalThis.fetch,
  storage,
  apiBase = 'https://api.github.com',
} = {}) {
  if (!storage) throw new Error('ghbackup needs a storage object ({ getItem, setItem, removeItem })');

  const load = () => {
    try {
      return JSON.parse(storage.getItem(GH_STORE_KEY) || 'null');
    } catch {
      return null; // corrupted entry is treated as "not connected", never as a crash
    }
  };
  const requireCreds = () => {
    const creds = load();
    if (!creds?.token || !creds?.owner || !creds?.repo) throw new Error(MSG_NOT_CONNECTED);
    return creds;
  };

  // Status → fixed message. The token and request details are never
  // interpolated anywhere in this module — see the header.
  function statusError(status) {
    if (status === 401) return new Error(MSG_401);
    if (status === 403) return new Error(MSG_403);
    if (status === 404) return new Error(MSG_404_REPO);
    return new Error(`GitHub answered with an unexpected error (${status}) — try again in a moment`);
  }

  async function request(creds, method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${creds.token}`,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000), // a hung request must not wedge the backup flow
      });
    } catch {
      // fetch rejection = DNS/TLS/offline/timeout — all mean the same to a newbie
      throw new Error(MSG_NETWORK);
    }
    return res;
  }

  async function readJson(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  // Existing file → its sha (the Contents API demands it on updates);
  // 404 → null (create instead of update); anything else → throw.
  async function getSha(creds, base, path) {
    const res = await request(creds, 'GET', `${base}/contents/${path}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw statusError(res.status);
    return (await readJson(res))?.sha ?? null;
  }

  // The shared create/update dance: PUT without sha to create, with sha to
  // update, and exactly ONE re-GET+retry on a 409 (another sync raced us and
  // moved the sha between our GET and PUT — one retry settles a single race;
  // looping would hide a real two-writers problem).
  async function putFile(path, text, message) {
    const creds = requireCreds();
    const base = `/repos/${creds.owner}/${creds.repo}`;
    const content = utf8ToBase64(text);
    const sha = await getSha(creds, base, path);
    const created = sha == null;
    const putBody = (s) => ({ message, content, ...(s ? { sha: s } : {}) });
    let res = await request(creds, 'PUT', `${base}/contents/${path}`, putBody(sha));
    if (res.status === 409) {
      res = await request(creds, 'PUT', `${base}/contents/${path}`, putBody(await getSha(creds, base, path)));
    }
    if (res.status !== 200 && res.status !== 201) throw statusError(res.status);
    return { path, created };
  }

  return {
    // UI display only — the token must never reach the screen.
    savedTarget() {
      const creds = load();
      return creds ? { owner: creds.owner, repo: creds.repo } : null;
    },

    hasToken() {
      return typeof load()?.token === 'string' && load().token.length > 0;
    },

    async connect({ token, owner, repo } = {}) {
      for (const [name, value] of [['token', token], ['repository owner', owner], ['repository name', repo]]) {
        if (typeof value !== 'string' || value.trim() === '') {
          throw new Error(`enter the ${name} first`);
        }
      }
      if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
        throw new Error('the owner and repository name may only contain letters, numbers, dots, hyphens and underscores');
      }
      const res = await request({ token, owner, repo }, 'GET', `/repos/${owner}/${repo}`);
      if (res.status !== 200) throw statusError(res.status);
      const body = await readJson(res);
      if (body?.private !== true) throw new Error(MSG_PUBLIC);
      storage.setItem(GH_STORE_KEY, JSON.stringify({ token, owner, repo }));
      return { fullName: body.full_name ?? `${owner}/${repo}`, isPrivate: true };
    },

    forget() {
      storage.removeItem(GH_STORE_KEY);
    },

    // One-time repo scaffolding: explains itself to the future user. Never
    // overwrites — a README the user edited stays theirs.
    async ensureReadme() {
      const creds = requireCreds();
      const base = `/repos/${creds.owner}/${creds.repo}`;
      const res = await request(creds, 'GET', `${base}/contents/README.md`);
      if (res.status === 200) return { path: 'README.md', created: false };
      if (res.status !== 404) throw statusError(res.status);
      await putFile('README.md', README_TEXT, 'Explain what this backup repository is');
      return { path: 'README.md', created: true };
    },

    async pushKeystore({ slug, keystoreJson, message } = {}) {
      if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        throw new Error('that file name is not usable — use lowercase letters, numbers and hyphens only');
      }
      const path = `wallets/${slug}${KEYSTORE_SUFFIX}`;
      return putFile(path, String(keystoreJson),
        message ?? `Backup ${slug} (${new Date().toISOString().slice(0, 10)})`);
    },

    async pushManifest({ treasuries } = {}) {
      const manifest = { v: 1, updatedAt: new Date().toISOString(), treasuries };
      // no-plaintext guard rail: metadata only, ever — see assertNoSecrets
      assertNoSecrets(manifest);
      const { path } = await putFile('manifest.json', JSON.stringify(manifest, null, 2),
        `Update manifest (${new Date().toISOString().slice(0, 10)})`);
      return { path };
    },

    async listKeystores() {
      const creds = requireCreds();
      const base = `/repos/${creds.owner}/${creds.repo}`;
      const res = await request(creds, 'GET', `${base}/contents/wallets`);
      if (res.status === 404) return []; // first sync — the folder does not exist yet
      if (res.status !== 200) throw statusError(res.status);
      const body = await readJson(res);
      if (!Array.isArray(body)) return [];
      return body
        .filter((f) => f?.type === 'file' && typeof f.name === 'string' && f.name.endsWith(KEYSTORE_SUFFIX))
        .map((f) => ({ slug: f.name.slice(0, -KEYSTORE_SUFFIX.length), path: f.path, sha: f.sha }));
    },

    async pullKeystore(path) {
      const creds = requireCreds();
      const base = `/repos/${creds.owner}/${creds.repo}`;
      const res = await request(creds, 'GET', `${base}/contents/${path}`);
      if (res.status === 404) throw new Error(MSG_FILE_MISSING);
      if (res.status !== 200) throw statusError(res.status);
      const body = await readJson(res);
      if (typeof body?.content !== 'string') throw statusError(200);
      return base64ToUtf8(body.content);
    },
  };
}
