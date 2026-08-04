# Treasury Wallets — Feature Specification for Diginaut (wallet.dgbclick.com)

**Status:** v1.1 — §10 verification COMPLETE (2026-07-26, all 8 questions answered against shipped code with file/line refs); cleared for implementation

---

## 1. The Idea in One Paragraph

Let a user take DGB sitting in their main Diginaut wallet and **split it into many small, independent, individually named wallets** — each one locking DGB as collateral and minting **at least $100 of DigiDollar (DD)** with a chosen lock period (default 10 years). Each of these "Treasury Wallets" is a self-contained vault: it has its **own seed phrase, its own locked DGB position, and its own minted DD**. Because each treasury is a fully independent wallet (not a derived account of the main wallet), the user can **sell or give away a single treasury** — the encrypted wallet file plus its password — to another person, without exposing or affecting any of the other treasuries. Think of each treasury as a **mini treasury bond that matures on its unlock date**.

The original inspiration (paraphrased): *"With 1,000,000 DGB I could split it across many separate wallets, lock DigiDollars in each for 10 years, and if DGB appreciated significantly, sell one of those wallets to a private investor without affecting the others. Each wallet is its own treasury that matures after 10 years."*

---

## 2. What Already Exists in Diginaut (observed 2026-07-26)

Diginaut is a fully client-side browser wallet for DigiByte + DigiDollar. Keys are generated in the browser and never leave it. Confirmed existing capabilities this feature **builds on**:

- **Multi-wallet support** — a "Wallets" panel with "Add wallet"; each wallet has its own seed phrase (12/24 words), its own name, and removal requires typing the wallet's name.
- **Master password** — one password unlocks all wallets on the device; per-wallet keystore export exists ("Download an encrypted backup file", `.keystore.json`).
- **Mint DigiDollar flow** — amount in DD, lock-period slider (1 hour → 10 years), review screen showing collateral to lock, collateral ratio, oracle price, network fee, and unlock date.
- **Positions view** — "DigiDollar positions" list, redeem flow (burn DD → collateral returned).
- **Send/Receive** for both DGB and DD (DD addresses `dgbt1…` / `DD…`, taproot `dgb1p…`, plus a v0 compatibility address).
- **Consolidate coins** helper (merges UTXOs when a single large-enough coin is needed).
- **$500 per-transaction beta cap** on mainnet beta.
- Auto-lock timer, seed-phrase reveal, erase-device flow, storage-persistence warnings.

**Gap:** wallets must currently be created, funded, named, minted, and backed up **one at a time, manually**. There is no batch/split flow, no treasury dashboard, no transfer/handover flow, and no remote (e.g. GitHub) backup.

---

## 3. Protocol Facts the Design Must Respect

Source: digibyte.io/digidollar + DigiByte Core v9.26.x docs (verify against the code Diginaut ships).

1. **Collateral ratios by lock tier** — minting $100 of DD requires locking DGB worth:

   | Lock period | Collateral ratio | DGB value to lock for $100 DD |
   |---|---|---|
   | 1 hour | 1000% | $1,000 |
   | 30 days | 500% | $500 |
   | 1 year | 300% | $300 |
   | 5 years | 225% | $225 |
   | **10 years** | **200%** | **$200** |

2. **So "minimum $100 per wallet" means ~$200+ of DGB value locked per treasury at the 10-year tier**, plus a small DGB fee reserve (see FR-5). The UI must show this math honestly — the user is not "splitting into $100 chunks", they are creating **$100 DD positions backed by ~$200 of locked DGB each**.
3. **Redemption requires burning DD — and any DD will do.** After the lock expires, the holder releases the collateral by burning DD equal to the position's minted amount. **DD is fungible: the burn does not have to be the exact same DD that was minted from that wallet.** So a treasury whose original DD was spent is **not broken and not stuck** — it is *economically impaired*: to unlock, say, $200 of DGB collateral, the holder must first acquire $100 of DD on the open market and burn it. Practical consequences:
   - **For the dashboard/valuation:** a treasury with its DD intact is "self-unlocking" (nothing more to buy). A treasury without its DD has net value ≈ `locked DGB value − cost to re-acquire the DD`. Buyers must be shown which one they're getting (see FR-4 flag).
   - **Appreciation cuts both ways:** if DGB 10x'd, buying back $100 of DD to unlock $2,000 of collateral is trivial. If DGB crashed hard, the DD buyback can exceed the collateral's worth — that's the protocol's ERR/undercollateralization territory, not a wallet bug.
   - **Resolved (§10, Q8):** the shipped P2TR script tree has **no** owner-reclaim-without-burn leaf — both MAST leaves require the DD burn. FR-4's guard is therefore **value-critical**, not advisory.
4. **Collateral is locked in a time-locked P2TR output controlled by that wallet's keys (CLTV).** Ownership of the position == ownership of the keys. There is no on-chain "transfer ownership" operation — handing over the wallet **is** the transfer (see §7 for the trust implications).
5. **Oracle price** (7-of-35 MuSig2 quorum) determines collateral at mint time. The split wizard must fetch the live oracle price and quote the DGB amounts before the user confirms.
6. **$500 beta cap** per transaction on mainnet beta — the wizard must enforce/warn.
7. **DGB dust for fees:** every treasury wallet needs a small spendable DGB balance left over, or it can never pay the network fee to redeem or move its DD later.

---

## 4. Core Design Decision: Independent Seeds, Not Sub-Accounts

Each treasury wallet MUST be a **fresh, independent HD wallet with its own random seed phrase** — exactly the kind Diginaut already creates with "Add wallet".

**Do NOT** derive treasuries from the main wallet's seed (BIP-32 sub-accounts). If treasuries shared a master seed, selling one treasury would either expose the master seed (catastrophic) or be impossible to do cleanly. Independent seeds are what make each treasury a **separately sellable artifact**.

Consequence: the user's main-wallet seed does **not** back up the treasuries. Every treasury needs its own backup — which is why the GitHub backup feature (§8) and the naming/export system are first-class requirements, not nice-to-haves.

---

## 5. Feature Requirements

### FR-1 — "Split into Treasuries" wizard (the headline feature)

A 4-step wizard launched from the main wallet ("Split into treasury wallets"). Target user: a complete newbie. One decision per screen, plain language, live numbers.

**Step 1 — Amount.** "How much DGB do you want to put into treasuries?" Shows available confirmed balance, USD equivalent at the current oracle price. If the wallet's balance is spread across many UTXOs and no single coin is large enough, offer the existing **Consolidate coins** step inline first.

**Step 2 — Size of each treasury.**
- Default: **$100 DD per treasury** (the floor). User can raise it ($150, $200, custom) with a simple slider/stepper — "Bigger treasuries, fewer wallets."
- Live preview, computed at the current oracle price and selected lock tier:
  - `N treasuries × $100 DD each`
  - `Collateral per treasury: ~$200 of DGB (≈ X DGB)` at 10-year tier
  - `Fee reserve per treasury: ~0.5 DGB`
  - `Total DGB needed: ≈ (X + 0.5) × N + network fees`
  - If the amount from Step 1 doesn't divide evenly: the remainder stays in the main wallet, or the last treasury is smaller (but never below the $100 floor).
- Lock period selector: default **10 years** (best collateral ratio, matches the "matures in 10 years" idea), other tiers available behind "Advanced".

**Step 3 — Names.** "Name your treasuries." Auto-suggest names using the **self-describing naming convention from FR-6** (e.g. `DD100-2036-07-21-A`), so the DD amount and maturity date are visible in the name itself — on the dashboard, in the GitHub repo file listing, and in any backup folder — without opening a single file. One-tap rename to a custom alias; the structured parts are always kept in metadata even if the alias replaces them. Names must be unique on the device.

**Step 4 — Review & confirm.** One plain-English summary:
> "This will create **8 new wallets**. Each will lock **≈ 40,000 DGB (~$200)** for **10 years** and mint **$100 DigiDollar**. Until **July 2036** the DGB in them cannot be spent. Each wallet gets its own secret backup words. Estimated network fees: **≈ 0.1 DGB**."

Then a big **"Create 8 treasuries"** button with password confirmation.

**Execution engine (background, with progress screen "Creating your treasuries… 3/8"):**
For each treasury:
1. Generate a new independent wallet (new seed) locally.
2. Send `collateral + fee reserve` DGB from the funding wallet to the new wallet's receive address.
3. Wait for confirmation (or queue mints per confirmation policy — surface a clear status: `funded ⏳ / minting ⏳ / done ✅`).
4. Mint `$amount` DD at the selected lock tier from the new wallet.
5. Record treasury metadata locally (see §6).
6. Trigger backup prompt / GitHub sync (FR-7).

Must be **resumable**: if the browser closes mid-batch, reopening the wizard shows which treasuries were created, which are funded-but-unminted, and which are pending — with "Resume" and no duplicate mints. Persist a batch job record in local storage keyed by batch ID.

**Beta-cap guard:** at $100 DD per treasury, mints are under the $500 cap. If the user raises the per-treasury amount above the cap, block with a plain explanation.

### FR-2 — Treasury dashboard

A new "Treasuries" tab showing every treasury wallet as a card:

```
┌─────────────────────────────────────┐
│  Treasury 3            🔒 Locked     │
│  $100 DigiDollar minted              │
│  40,012 DGB locked                   │
│  Unlocks: 21 Jul 2036  (9y 11m 26d)  │
│  [Open] [Back up] [Transfer…]        │
└─────────────────────────────────────┘
```

Statuses: `Funded` (DGB arrived, not yet minted), `Locked` (position active), `Unlocking soon` (< 90 days), `Mature` (lock expired — "Ready to redeem"), `Redeemed`, `Transferred out`.
Aggregate header: total locked DGB, total DD, next maturity date. Sort by name / maturity / status.

### FR-3 — Open a treasury

Tapping a card switches to that wallet (Diginaut's existing multi-wallet switcher), showing its DGB, DD, and position. Newbies should experience treasuries as "folders", not as a scary multi-wallet system.

### FR-4 — Treasury integrity guard

A treasury's value proposition is **locked DGB + its DD, together**. Add a guard on treasury wallets:
- Sending DD **out of** a treasury wallet triggers a hard warning: *"Spending this DigiDollar breaks the treasury — without it, the locked DGB can't be redeemed at maturity. Are you sure?"* (Allow override for advanced users; log the override in metadata so a buyer can see "DD was moved".)
- Ideally, a treasury metadata flag `ddIntact: true/false` derived on-chain: does the wallet still hold ≥ the minted DD amount? Show it on the card ("✅ DD intact" / "⚠️ DD moved").

### FR-5 — Fee reserve

Each treasury keeps a small unspendable-looking-but-spendable DGB reserve (default ~0.5 DGB, configurable in Advanced) so it can always pay future network fees (redeem, DD send). Never let the mint consume 100% of the treasury's DGB. Surface it as "Fee pocket: 0.5 DGB" on the card.

### FR-6 — Naming & metadata

**Self-describing naming convention (default).** Auto-generated treasury names encode the essentials so a wallet is identifiable at a glance — in the dashboard, in a GitHub file listing, in a backup folder, or when a seller is searching for "the one the buyer asked about":

```
DD{amount}-{maturity ISO date}-{sequence}   [– optional custom alias]

Examples:
  DD100-2036-07-21-A
  DD100-2036-07-21-B
  DD250-2031-07-21-C – Mum's gift
```

- `{amount}` = minted DD dollars; `{maturity}` = estimated unlock date (`YYYY-MM-DD`); `{sequence}` = letter/index within the batch (guarantees uniqueness when a batch shares amount + date).
- If the user renames to a pure alias ("Mum's gift"), the canonical `DD…-date-seq` slug is still kept in metadata and still used for the **backup filename**, so GitHub listings stay searchable even when display names are friendly.
- Names and filenames must never contain seed words, keys, passwords, or anything sensitive — amount and maturity only. (Privacy note: a filename reveals "a $100 treasury maturing 2036" to anyone who can see the repo listing — acceptable for a private repo, and exactly what makes it useful; surfaced as an info note in settings.)
- **Dashboard search/filter** must match on any part of the name: typing `2036` lists everything maturing that year, `DD250` lists all $250 treasuries — this is the seller-side "find the one the buyer is considering" flow.
- Names editable anytime (local metadata only, never on-chain; rename triggers a backup re-sync so the filename follows).
- Per-treasury metadata record (stored locally + inside encrypted backups):

```json
{
  "walletId": "…",
  "name": "Treasury 3",
  "batchId": "split-2026-07-26-001",
  "createdAt": "2026-07-26T13:00:00Z",
  "mint": {
    "ddAmount": 100,
    "lockTierYears": 10,
    "collateralDGB": 40012.55,
    "oraclePriceAtMint": 0.002498,
    "unlockHeight": 24500000,
    "unlockDateEstimate": "2036-07-21",
    "positionTxid": "…"
  },
  "ddIntact": true,
  "transferredOut": false
}
```

### FR-7 — Transfer / sell a treasury (handover flow)

"Transfer…" on a treasury card opens a guided handover:

1. **Explain, plainly:** *"Transferring gives the other person full control of this wallet's locked DGB and DigiDollar. This cannot be undone on-chain."*
2. **Export** the treasury's `.keystore.json`, with two options:
   - **Re-encrypt for the recipient (recommended):** seller enters a one-time **transfer passphrase** that they share with the buyer over a separate channel. The exported file is encrypted with that passphrase, not the seller's master password.
   - Export with the existing encryption.
3. **Handover package** (single download): `{name}.keystore.json` + a human-readable `RECEIPT.txt` (treasury name, minted DD, locked DGB, unlock date, position txid so the buyer can verify on a block explorer, and restore instructions pointing at wallet.dgbclick.com → "Restore from backup file").
4. **After confirmed handover:** "Remove from this device" (existing flow, typing the name). Sets `transferredOut: true` in local metadata.
5. **Honesty warning shown to the seller:** *"Deleting your copy does not prove you forgot the keys. Buyers should know a seller could keep a copy of the backup words."* → see §7.

**Receiving side needs nothing new** — Diginaut already has "Restore from backup file" — but add a "Received a treasury?" hint on that screen that explains what the buyer is getting and how to verify the position on-chain (link to explorer with the txid).

### FR-8 — Encrypted backup to a private GitHub repository

Goal: a newbie-proof, encrypted, off-device backup of every treasury wallet.

**Security model (non-negotiable):**
- The `.keystore.json` files are **already encrypted client-side** with the wallet's encryption (PBKDF2/Argon2id + AES-256-GCM or whatever Diginaut currently uses — reuse it, don't invent a second scheme). **Only the encrypted bytes ever leave the browser. Plaintext seeds, private keys, and passwords must never touch the GitHub API, commit history, logs, or analytics.**
- The UI must say exactly that: *"Your wallets are encrypted on this device before upload. GitHub only ever stores scrambled data."*

**Flow:**
1. Settings → "Backup to GitHub" → user pastes a **fine-grained personal access token** with `Contents: Read & Write` on **one specific private repository** (guide with screenshots: create private repo `dgb-treasury-backups`, create fine-grained PAT scoped to just that repo, 90-day expiry reminder).
2. Token stored only in browser storage, never transmitted anywhere except `api.github.com` over HTTPS. Offer "forget token" and show token status.
3. Folder layout in the repo — **filenames use the FR-6 self-describing slug**, so the GitHub file listing itself works as a searchable inventory (a seller can Ctrl+F the repo page for `dd250` or `2036-07` when discussing a specific treasury with a buyer):
   ```
   /
   ├── README.md            ← "What is this repo / how to restore" (auto-written)
   ├── manifest.json        ← slugs, walletIds, amounts, maturities, backup dates (NO keys, NO seeds)
   └── wallets/
       ├── dd100-2036-07-21-a.keystore.json
       ├── dd100-2036-07-21-b.keystore.json
       ├── dd250-2031-07-21-c.keystore.json
       └── …
   ```
4. Sync via the GitHub Contents API (`GET/PUT /repos/{owner}/{repo}/contents/{path}`): one commit per sync ("Backup: 8 wallets, 2026-07-26 13:42"), creating files for new treasuries and updating changed ones. Handle the file-`sha` requirement for updates and 409 conflicts with a simple retry.
5. **Auto-sync prompt** after: creating treasuries, minting, renaming, redeeming — *"Back up 2 new treasuries to GitHub now?"* (with a manual "Sync now" button always available).
6. **Restore:** on a fresh browser, "Restore from GitHub" → paste token + repo → list wallets → pick → import (asks for the wallet's master/transfer password). This is also the **device-migration** story.
7. **Warnings the UI must carry:**
   - Keep the repo **private forever**; even encrypted, treat it as sensitive. If the repo is ever made public, rotate by moving funds to new wallets.
   - A GitHub backup protects against **device loss**, not against a **forgotten password** — the seed words remain the ultimate backup and the wizard still forces the user through the written-words backup for each treasury (batched UX: reveal/verify words per treasury, with a printable "backup sheet" listing all treasury names + word grids to write on).

**Alternatives noted in settings (do not build now):** encrypted zip download, WebDAV/Nextcloud, IPFS — GitHub is simply the first backend behind a small `BackupProvider` interface so others can be added later.

---

## 6. UX Principles (the "newbie test")

A first-time crypto user should succeed without reading docs.

- **One decision per screen.** No sliders next to sliders. Advanced options collapsed by default.
- **Dollars first, DGB second.** Say "$100 DigiDollar, backed by ≈ $200 of DGB (40,012 DGB)" — not the reverse.
- **Plain words:** "locked until 21 July 2036" not "CLTV expiry at height 24,500,000" (block height available in an "Details" expander).
- **Constant reassurance about where keys live:** "Created and stored only in this browser."
- **Progress and recovery:** the batch screen survives refresh; nothing is ever silently half-done.
- **Every irreversible action** (mint lock-in, transfer, remove) has a review screen with the consequences in one sentence.
- Keep Diginaut's existing visual language, modals, and disclaimer style.

---

## 7. Honest Limitations (put these in the UI and docs)

1. **Wallet transfer is not trustless.** Selling a treasury = handing over keys. The seller can keep a copy of the seed and claw the funds back later. There is no on-chain way to rotate the key controlling a CLTV-locked collateral output (verify in §10 — if the protocol offers any script-path that allows key rotation or trustless position sale, prefer it). Until then, private sales need trust/escrow/legal agreement — say so in the handover flow rather than overselling the feature.
2. **Spent DD impairs the treasury** (§3.3) — hence FR-4.
3. **Price risk:** the 200% (10-yr) buffer absorbs a ~50% DGB drop; deeper crashes can leave the position undercollateralized (protocol's ERR rules then apply). The dashboard should show a simple health indicator per treasury.
4. **Beta cap:** $500/tx on mainnet beta.
5. **Unlock date is an estimate** (block-time based); display "≈".
6. GitHub is a backup convenience, not a security boundary — encryption happens before upload, always.

---

## 8. Technical Notes for Implementation

- **Reuse, don't rebuild:** wallet creation, keystore encryption, mint flow, positions tracking, consolidate-coins, and the multi-wallet switcher all exist. This feature is 80% orchestration (wizard + batch engine + dashboard) and 20% new surface (GitHub sync, handover export).
- **Batch engine:** persist `{batchId, step, treasuries: [{name, walletId, fundTxid, mintTxid, state}]}` in the same storage layer Diginaut uses; make every step idempotent (check on-chain before re-sending or re-minting).
- **UTXO planning:** funding N treasuries = N+ outputs; consider one funding transaction with N outputs (cheaper, atomic-ish) vs N separate sends (simpler recovery) — recommend **one batched funding tx per treasury sequentially** for clean resume semantics, or a single multi-output tx with a clear all-or-nothing review. Decide in code review; document the choice.
- **Oracle price:** read from the same feed the mint flow uses; re-quote if the wizard sits idle > 5 minutes.
- **GitHub API:** `api.github.com`, endpoints `GET /user/repos` (verify repo + privacy), `GET/PUT /repos/{owner}/{repo}/contents/{path}`. Fine-grained PAT, `X-GitHub-Api-Version: 2022-11-28`. Never log the token. Graceful offline/401/403/404/409 handling with plain-English messages.
- **BackupProvider interface:** `connect(credentials) / push(walletDescriptor, encryptedBytes) / pull() / list()` — GitHub first, filesystem-download second (actually zero-cost: the existing export button).
- **No new external network calls** beyond the existing indexer/oracle endpoints and `api.github.com`. Everything else stays client-side, matching Diginaut's current trust model.

---

## 9. Acceptance Criteria

1. A user with 350,000 DGB can, from the wizard, create **8 treasuries × $100 DD** (10-yr lock) in one flow, with correct collateral math at the live oracle price, remainder left in the main wallet, and every treasury individually named.
2. Closing the browser mid-batch and reopening offers a truthful "Resume" that never double-funds or double-mints.
3. Each treasury card shows: name, DD minted, DGB locked, unlock date countdown, DD-intact flag, fee pocket.
4. Transfer produces a passphrase-re-encrypted `.keystore.json` + receipt; a second browser restores it via "Restore from backup file" and sees the position; the seller's device can then remove the wallet.
5. GitHub backup: with a fine-grained PAT on a private repo, one click pushes encrypted keystores + manifest; a fresh browser restores from GitHub. **Repo contents contain zero plaintext key material** (verify by inspecting a pushed file).
6. All warnings in §7 appear at the relevant steps.
7. No regression: existing send/receive/mint/redeem/backup flows untouched.

---

## 10. Open Questions — VERIFIED against the shipped code, 2026-07-26

All eight questions verified against this repo (the same code production runs at
wallet.dgbclick.com, build ≥ `14d02d5`) and, where noted, against the live mainnet node.
File/line references are to this repo.

1. **Trustless position transfer: NO — design the handover flow as key transfer.**
   The collateral P2TR uses a **NUMS internal key** (provably unspendable key path) plus a
   **2-leaf MAST** — Normal redemption and ERR — and nothing else
   (`packages/digidollar-js/src/taproot.js:4`, leaves at `:66` and `:75`, control block
   `:132-141`). Both leaves require the owner's CHECKSIG **and** a DD burn. There is no
   rotation/assignment leaf and no key-path spend at all, so §7.1's honesty warning is the
   correct and only story: selling a treasury = handing over keys, seller may retain a copy.
2. **Mint limits: $100 DD is exactly the protocol MINIMUM mint on mainnet.**
   `DD_TX_LIMITS.mainnet = { minMintCents: 10_000, maxMintCents: 10_000_000, minOutputCents: 100 }`
   (`packages/digidollar-js/src/index.js:85-89`): min mint **$100.00**, max **$100,000**,
   min DD output **$1**. The spec's per-treasury floor is therefore also the protocol floor —
   the wizard must not offer smaller. The beta cap **defaults to $500 per transaction**,
   mainnet-only, client-side, explicitly **no cumulative/daily tracking**
   (`apps/wallet/public/netchrome.js`) — $100–$500 treasuries all clear it, one mint per tx.
   The user may raise that ceiling on their own device (`apps/wallet/public/txcap.js`), so
   the wizard must read the effective cap rather than assume $500; it still clears either way.
3. **Single-UTXO funding: YES, both shapes work.** The mint builder emits an owner P2WPKH
   change output only when change exceeds the fold threshold; sub-threshold change is folded
   into the fee rather than emitted as dust (`packages/digidollar-js/src/txbuild.js:6`,
   fold logic `:219-237`, mint anatomy `:60`). Funding each treasury with one consolidated
   UTXO of ≈ `collateral + fee reserve + txfee` is clean: at worst a small P2WPKH change
   output returns to the treasury's own key, which simply joins its fee pocket (FR-5).
4. **DD-intact detection: YES, cheap.** The indexer façade already serves per-address
   `positions` (scanner at `apps/indexer/server.js:119-155`) and `dd-utxos`
   (route regex `apps/indexer/server.js:272`; wallet-side proxy allow-list
   `apps/wallet/server.js` `/api/indexer/...`). `ddIntact` = sum of the treasury's dd-utxos
   ≥ the position's minted cents — two indexed reads per treasury, no new infrastructure.
5. **Unlock-time estimation: `SECONDS_PER_BLOCK = 15`** (`apps/wallet/public/app.js:1977`);
   dates are rendered as `now + blocksLeft × 15 s` and displayed with "≈"
   (`app.js:2008`, helper `:2823`). Reuse the same helper for treasury names/cards so the
   FR-6 maturity slug matches what the positions view shows.
6. **Keystore format: PBKDF2-HMAC-SHA256, 600,000 iterations (OWASP floor) → AES-256-GCM**,
   fresh random 16-byte salt and 12-byte IV per encryption; the iteration count is stored
   per record and echoed on re-encryption, so future bumps never brick old files
   (`apps/wallet/public/keystore.js:2,9,17-34`). GitHub backups (FR-8) must push these
   `.keystore.json` bytes unmodified — they then restore through the existing
   "Restore from backup file" path with zero new crypto. Audited 2026-07-26 (AUDIT.md L1)
   and found sound: no distinguishable wrong-password oracle, crash-safe v1→v2 migration.
7. **Mainnet activation: ACTIVE.** BIP9 `digidollar` deployment active on mainnet since
   block **23,869,440** (verified live via `getdeploymentinfo` against the production node,
   2026-07-26). No feature flag needed: the wallet already gates DD flows at runtime on the
   node's reported deployment status (`apps/wallet/public/app.js:335-337`), so one build
   serves testnet and mainnet correctly.
8. **Owner-reclaim path: DOES NOT EXIST — "DD intact" (FR-4) is VALUE-CRITICAL.**
   Same evidence as Q1: both MAST leaves carry `OP_DIGIDOLLAR <ddCents> OP_DDVERIFY`
   (the burn) before the owner CHECKSIG — Normal (`taproot.js:66`) and ERR
   (`taproot.js:75`; independently documented from regtest against real Core in
   `docs/discovery/regtest-oracle-findings.md:31-36`). Collateral can never be reclaimed
   without burning the position's DD amount. Pricing consequence for sales: a DD-less
   treasury is worth ≈ `locked DGB value − market cost of re-acquiring its DD`, exactly as
   §3.3 models; the FR-4 guard and card flag must ship in v1, not later.

---

*End of spec. This document is the single source of truth for the feature; amend here first, then code.*
