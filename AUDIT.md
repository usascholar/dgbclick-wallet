# DGBclick Wallet — security audit

Date: 2026-07-26. Scope: `apps/wallet` (server.js, public/*) with `packages/digidollar-js`
treated as read-only (differential-tested byte-identical against DigiByte Core).
Posture assumed: real mainnet funds, hostile browser (storage eviction), hostile network
(dies mid-broadcast), hostile upstreams (third-party indexer), and a tired user.

Status legend: **FIXED** (this changeset), **PARTIAL**, **DEFERRED** (with reason),
**OK** (audited, already sound), **WONTFIX** (infeasible within constraints — stated plainly).

---

## CRITICAL

### C1. Broadcast ambiguity: a timed-out sendrawtransaction is treated as a definite failure — **FIXED**
`broadcastTx()` (app.js) threw on any error, and the UI showed a plain failure. If the
connection dropped or the proxy's 15 s timeout fired *after* the node accepted the tx, the
user saw "failed" while the tx sat in the mempool — and the natural next move (rebuild and
re-send) is a second, conflicting transaction over the same UTXOs. Worse, nothing was
persisted between signing and broadcasting, so a tab crash in that window left zero trace
that funds may have moved.

Fix:
- New `public/broadcastlog.js`: the signed hex + locally computed txid (double-SHA-256,
  so reconciliation does not depend on the node answering) is persisted to localStorage
  **before** every broadcast, for all five flows (send, transfer, mint, redeem, consolidate).
- Broadcast errors are classified: node reject strings (consensus/policy rejections,
  including the `bad-txns-*` family) are *definite* failures — the record is dropped and the
  error shown. Transport errors (timeout, connection drop, 5xx without a reject token) are
  *ambiguous*: the record is kept and the UI says exactly that — "may have been broadcast".
- Ambiguous outcomes offer **Rebroadcast** (the identical hex — idempotent, same txid;
  "already in mempool" from the node is treated as success) and **Check status**
  (indexer `/tx/:txid` lookup). A boot-time recovery card re-surfaces any record that
  survived a page kill. Records are cleared only on confirmation or a definite node reject.

### C2. Browser storage eviction = silent total loss of funds — **FIXED**
IndexedDB (the vault) is evictable under storage pressure, on "clear site data", and
aggressively on mobile. The app never asked for persistence, never told the user whether it
had it, and — worst — a wiped vault was indistinguishable from a fresh install: the guest
hero cheerfully offered "Create new wallet" to someone who had funds minutes ago.

Fix:
- `navigator.storage.persist()` is requested at vault creation and unlock; the result
  (`persisted()` + the request outcome) is shown in Network → "Browser storage protection".
- When storage is **not** persisted, backup urgency escalates: the backup warning strip
  fires even at zero balance (it was balance-gated), with wording that names eviction.
- A localStorage tombstone (`diginaut.hadVault`) is written whenever a vault exists and
  cleared only by the two *deliberate* erase paths (global erase, last-wallet removal).
  Boot with tombstone + no vault → the guest hero shows honest recovery guidance
  ("this browser previously held a wallet; its stored data is gone — restore from your seed
  phrase or backup file") instead of the fresh-install hero. Limitations stated plainly:
  localStorage and IndexedDB are usually evicted together, so the tombstone is a
  best-effort signal, not a guarantee; it catches the cases where they diverge (partial
  eviction, IndexedDB corruption, quota trimming), which is where silent confusion lived.

### C3. Mainnet allowed skipping the seed backup — **FIXED**
The backup ceremony had a "Remind me later" skip on every network. On mainnet that is real
money with zero backup one click away. Fix: `backupSkipAllowed(chain)` in netchrome.js
(same runtime-chain gating as the $500 beta cap) — on `main`, and on an *unknown* chain
(node down on a mainnet deployment must fail strict), the skip button is hidden and the
ceremony cannot be dismissed until the 3-word quiz passes. Testnet/regtest keep the
frictionless flow. The receive-flow interception and badge already nagged; this removes
the skip that made the nagging optional on the one network where it matters.

---

## HIGH

### H1. No timeout on any frontend fetch — **FIXED**
`rpc()`, `fetchIndexer()`, `/api/config`, `/api/price-history`, and the faucet claim all
used bare `fetch` with no timeout. A stalled connection (not refused — *stalled*, the
common mobile/NAT failure) hangs forever: permanent spinner, poll loops that silently
stop rescheduling, confirm buttons that never un-disable. Fix: every frontend fetch now
has an `AbortSignal.timeout` (15–30 s by path), and timeout/abort errors are translated to
plain-language messages ("the node did not answer in time — it may be down or the
connection dropped") rather than `AbortError` stack text. The boot path keeps the
`bootStuck()` philosophy: a dead boot states the reason, it does not animate forever.

### H2. Indexer-supplied JSON fed transaction building unvalidated — **FIXED**
The wallet signs transactions built from indexer UTXO/position JSON, and `INDEXER_URL` may
be a third-party service. Display data was already consumed defensively (#55), but the
*signing* inputs — txids, vouts, valueSats, cents, collateral, lock heights — were trusted
blindly. A malicious or buggy upstream could inject a negative/huge value, a bogus lock
height, or a malformed outpoint into what the user is asked to sign.

Fix: new `public/validate.js` applied at the `fetchIndexer` boundary. Signing inputs
(utxos, dd-utxos, positions) are **strict**: one malformed entry (bad txid shape, non-integer
vout, value above MAX_MONEY, garbage lock height) throws, and the UI shows "indexer returned
malformed data — refusing to use it" rather than a confident wrong balance or a poisoned
signing set. Display-only data (history, tx detail) stays **tolerant**: malformed entries are
dropped, good ones render. All validators return fresh objects (no prototype pollution).

### H3. Node reject strings for spent/conflicting inputs shown raw — **FIXED**
`bad-txns-inputs-missingorspent` and `txn-mempool-conflict` are exactly the errors a user
gets after an ambiguous broadcast retry — and they were shown verbatim, inviting the worst
response ("rebuild and send again"). Fix: dderrors.js now translates the spent/conflict/
already-broadcast families into guidance that says *stop, check Activity first, do not
re-send* (see C1). `isAlreadyBroadcast()` lets the rebroadcast path treat
"already in mempool" as the success it is.

### H4. No rate limit or body-size limit on the proxy — **FIXED**
`/api/rpc` and `/api/faucet/claim` read request bodies into memory unbounded, and nothing
throttled per-client request rates — a cheap way to DoS the wallet host (and through it,
the node and faucet it proxies to). Fix in server.js: body limits (1 MiB RPC — large
consolidation txs are legitimately a few hundred KB of hex; 16 KiB faucet) → 413, and a
fixed-window per-IP rate limit (defaults 120/min RPC, 6000/min indexer — the wallet itself
is the dominant legitimate consumer: each 8 s money poll costs ~(receiveIndex+3) × 6
address reads and a receive-chain rescan bursts ~100 more, so the first draft of this
limit, 600/min, self-DoS'd a restored wallet at index ≥ ~7 for a full window — caught by
the verify-receive-index browser driver; 20/min faucet) → 429 + `retry-after`.
Limits are overridable via `startServer` overrides for tests and operators.

### H5. Stale indexer data invisible at signing time — **FIXED**
The indexer can lag the node (initial sync, catch-up after an outage); a UTXO set that is
even one block behind can double-count a just-spent coin. Fix: the money poll already
receives the indexer's `tipHeight`; it is now retained, and every confirm screen
(send / transfer / mint / redeem / consolidate) shows a warning row when the indexer tip
lags the node's block count, telling the user the balance/positions shown may be behind
and to wait or double-check before confirming.

---

## MEDIUM

### M1. Encrypted backup file buried; not offered at creation — **FIXED**
The keystore-file export existed only deep in the wallet switcher (⋯ → manage). The audit
position (and the repo's own benchmark doc) is that a browser wallet's IndexedDB is fragile
enough to justify offering the encrypted file *at creation*, next to the seed words.
Fix: the backup ceremony's success step now offers "Download encrypted backup file"
(re-auth gated, like the switcher export — it re-proves the password the file will need).
Messaging stays honest per the benchmark: the file is a convenience copy that dies with a
forgotten password; it does **not** count as backed up (only the seed quiz clears that).

### M2. Restore-from-backup-file roundtrip was untested — **FIXED**
The import path (parse → decrypt → validate → vault add) had unit coverage of its parts but
nothing proving create → export → wipe → restore yields the same wallet. Fix:
`test/backup-roundtrip.test.js` runs the full lifecycle with the real WebCrypto path and
real `digidollar-js` derivation — addresses derived after a from-file restore are
byte-identical to the originals (indices 0 and 3), a wrong password rejects, and a tampered
ciphertext rejects with GCM auth failure (no decryption oracle).

### M3. No HSTS for TLS deployments — **FIXED**
A wallet served over TLS without HSTS is one sslstrip away from serving the key-holding page
over plain HTTP on a hostile network. Fix: `HSTS=1` env adds
`Strict-Transport-Security: max-age=15552000; includeSubDomains` to every response.
Default off — the wallet also legitimately runs on localhost/http where HSTS would be wrong.

---

## LOW / reviewed

### L1. Vault crypto: KDF, IV/salt handling, wrong-password behavior, v1→v2 migration — **OK**
`keystore.js` uses PBKDF2-HMAC-SHA256 at 600,000 iterations — the current OWASP Password
Storage Cheat Sheet floor for SHA-256 — with fresh random 16-byte salts and fresh 12-byte
AES-GCM IVs per encryption. Web Crypto offers no Argon2/scrypt, so PBKDF2 at the OWASP
floor is the strongest option **within the zero-dependency constraint**; raising iterations
further is safe (the count is stored per-record and echoed verbatim on re-encryption, so a
bump never bricks old vaults) and is a tuning decision, not a fix. Wrong password → GCM
auth failure → generic "wrong password": no padding oracle, no distinguishable error.
The v1→v2 migration writes v2, verifies it decrypts, and only then deletes v1 — crash-safe
at every step, and interrupted migrations (both records present) resolve correctly.
The key↔salt invariant (held session key always matches the stored kdf block) is documented
in-code and correctly maintained by `encryptJsonWithKey`. No changes made.

### L2. Re-auth before seed reveal; typed confirmation before erase — **OK**
Both gaps the benchmark doc (`docs/discovery/wallet-ux-benchmark.md`) flagged — zero-re-auth
reveal and one-click erase — are **already closed** in this tree: seed reveal, backup
re-entry, and keystore export all go through `requireReauth()` (a decrypt probe, not a
string compare); wallet removal requires typing the wallet's name; global erase requires
typing `ERASE`. Verified, no changes.

### L3. Plaintext key lifetime — **PARTIAL**
What exists: autolock (default 5 min) drops the session key and all plaintext mnemonics;
a revealed seed auto-hides after 60 s and on tab blur; ceremony words are wiped from the DOM
when the modal closes; per-UTXO private keys in pending drafts are dropped on modal
cancel/close/lock/switch; the previous-addresses cache holds only addresses, never keys.

What remains, honestly: while unlocked, the vault manager necessarily holds every mnemonic
in page memory (it re-encrypts on each mutation without re-prompting), and `wallet.seed`
(a 64-byte BIP39 seed) lives for the whole unlocked session to derive addresses and sign.
JavaScript cannot reliably zero strings/Uint8Arrays that have been through the engine, so
"overwrite secrets after use" is only partially implementable in this platform. The
meaningful controls are the ones shipped: autolock, lock-on-switch, DOM hygiene, and the
reveal ceremonies. True memory hardening would require a WASM keystore with explicit
buffer management — **DEFERRED** (out of scope; would add a build step and a dependency).

### L4. Clipboard seed copy + 60 s clipboard overwrite — **WONTFIX (N/A by design)**
There is deliberately **no** seed-copy path anywhere in the UI (the benchmark recommends
BlueWallet's no-copy stance over Rainbow's copy button). The only clipboard writes are
addresses and BIP21 URIs — public data. Overwriting the clipboard 60 s after copying an
*address* would be user-hostile (it nukes whatever they copied since) to protect nothing.

### L5. innerHTML sinks — **OK**
Every `innerHTML` sink in app.js was re-grepped and re-read. Untrusted interpolations
(indexer/node/oracle JSON, txids, addresses, wallet names) all pass through `esc()` or are
constrained to character classes that cannot carry markup (BigInt-formatted amounts,
regex-validated txids, numbers). The explorer URL is operator config, not peer input.
The CSP (no `'unsafe-inline'` scripts, no `'unsafe-hashes'`) remains the second line of
defense behind per-sink escaping, and H2 now hardens the data at the boundary as well.

### L6. Confirm-screen integrity — **OK**
The signer consumes only the `pendingSend` / `pendingTransfer` / `pendingMint` /
`pendingRedeem` / `pendingConsolidate` objects captured at review time — the same objects
the confirm rows were rendered from. Nothing is re-read from the DOM between "Confirm" and
signing. (The mint's fresh block-height fetch at sign time is the intended behavior — CLTV
needs the actual tip — and cannot alter amount, tier, or recipient.)

### L7. CSP / RPC allow-list / vendor pinning — **OK, preserved**
`script-src 'self' + sha256` with no `'unsafe-inline'`; the CRLF-safe importmap hash
(`\r\n?`→`\n` normalization) is untouched and still covered by its drift test. The RPC
proxy allow-list contains no wallet-spending methods; `mintdigidollar` / `redeemdigidollar`
/ `senddigidollar` remain unexposed. vendor.lock verification still fails closed at boot.

### L8. `style-src 'unsafe-inline'` — **DEFERRED (accepted risk)**
The UI kit relies on inline `style=""` attributes and a `<style>` block; removing
`'unsafe-inline'` from styles is a large restyle for marginal gain — CSS injection cannot
exfiltrate keys under this CSP (no external `connect-src`/`img-src` for an attacker URL),
and the security-in-depth boundary for scripts is intact.

### L9. localStorage for non-secret state — **OK**
Everything in localStorage is non-secret by construction: autolock preference, the mainnet
ack, the pending-broadcast log (signed tx hex — public once broadcast, useless for spending
without keys), and the new vault tombstone. Secrets live only in IndexedDB under AES-GCM.
The tombstone leaks one bit ("a wallet existed here") to anyone with local JS access —
acceptable; anyone with local JS access already owns the page.

### L10. Mock mode surface — **OK**
Mock mode (no RPC creds) cannot reach a real node; the faucet button only appears when a
faucet URL is configured; the `?autolockSecs=` override is honored only in mock mode so a
crafted link cannot weaken auto-lock on a live deployment.

---

## Tooling note (not a wallet-security finding)

The headless-Chrome CDP drivers in `apps/wallet/scripts/verify-*.mjs` were unrunnable on
Windows: they built filesystem paths with `new URL(..., import.meta.url).pathname`
(`/C:/...`), which neither `spawn('node', …)` nor fs writes accept on Windows — CI is
Linux, so it never showed. Six of the ten default drivers failed identically **before**
this changeset (baseline verified via `git stash`). The idiom was replaced with
`fileURLToPath(new URL(...))` so the browser-driver gate runs on this checkout too.
