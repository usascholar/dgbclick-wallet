# DD Classifieds — Feature Specification for DGBclick Wallet (wallet.dgbclick.com)

**Status:** v0.1 DRAFT — design for discussion; §12 open questions must be settled before implementation
**Evolves toward:** the DD Marketplace (§11) — v1 is deliberately the smallest honest version

## 1. The Idea in One Paragraph

A classifieds board inside the wallet: any wallet holder can post a listing
("tires, $80 DD, ships from Miami"), signed by their wallet key; any other
holder can browse, make a private offer, haggle over an end-to-end encrypted
channel, and settle peer-to-peer in DD — in person by QR, or by shipping
between parties who trust each other's track record. The operator (us) hosts
a bulletin board and a ciphertext relay; the operator NEVER holds funds,
never sees negotiations, and never learns shipping addresses. Craigslist
economics, cash replaced by a stablecoin the wallet already spends.

## 2. What Already Exists (observed 2026-07-28, main @ 83a1304)

| Primitive | Where | Reused for |
|---|---|---|
| Schnorr keypair per wallet, signs arbitrary data | digidollar-js (schnorr over secp256k1) | listing signatures, offer signatures, receipts, login-free identity |
| Stable-value payments wallet-to-wallet | DD transfer flow | settlement (unchanged — classifieds never adds a payment path) |
| Per-wallet voter token + salted-hash vote store | Spend DD directory (server.js, `~/diginaut-data`) | listing upvotes and flag/report counts |
| Moderated-content pattern: fetch ladder, per-entry validation, snapshot fallback | directory source ladder | listing store resilience |
| SSE push (`/api/events`) | wallet server | "new offer on your listing" notification while the wallet is open |
| QR display + camera scan | receive/send screens | in-person settlement |
| Strict/tolerant validator pattern (validate.js) | everywhere | every classifieds payload |
| Busy-button, modal, card UI conventions | app.js/index.html | the Classifieds screen |

**Gap:** no user-generated content path (the merchant directory is
operator-curated), no wallet-key message signing exposed in the UI, no
encrypted messaging, no reputation record.

## 3. Hard Constraints the Design Must Respect

1. **Zero custody.** The operator never holds, routes, or escrows funds.
   Settlement is a plain DD transfer (or in-person QR payment) between the
   two parties, using flows that already exist. This is a legal posture as
   much as a technical one: we are a bulletin board, not an exchange or
   money transmitter.
2. **PII never in plaintext on our infrastructure.** Shipping addresses,
   meetup places/times, phone numbers, names — all negotiation content —
   exist only inside the E2E-encrypted offer channel (§6). The server
   relays ciphertext it cannot read. Public listings carry at most a
   coarse region ("Miami area", free-text, seller-chosen).
3. **Moderation before publication.** Listings enter a queue and appear
   publicly only after operator approval (v1: manual; the queue UI can be
   a simple admin page or even CLI). Prohibited-items policy is published
   in the UI. Flag threshold auto-unlists pending re-review.
4. **Keys sign everything; the server authenticates nothing.** A listing,
   offer, or receipt is valid because its signature verifies against the
   embedded pubkey — not because our server said so. This is what makes
   v2/v3 (§11) possible without a data migration: the objects are already
   self-authenticating.
5. **No new consensus or protocol claims.** No MuSig escrow, no on-chain
   listing references, no OP_RETURN memos — the DD envelope is
   consensus-fixed and stays untouched. Escrow is explicitly out of scope
   for v1 (§12 Q4).
6. **The signing key is not the spending key's secret leaked anywhere new.**
   Signing uses the wallet's existing key material client-side, same as
   transaction signing; raw keys never leave the browser.

## 4. Objects (all JSON, all signed, all self-authenticating)

### 4.1 Listing

```json
{
  "v": 1,
  "type": "listing",
  "id": "<sha256 of the signed body, hex — assigned by canonical hashing, not by the server>",
  "pubkey": "<x-only hex, 32B — the seller's wallet key>",
  "title": "≤80 chars",
  "body": "≤2000 chars, plain text",
  "priceCents": "string bigint — DD cents; 0 = 'make an offer'",
  "region": "≤60 chars free text, seller-chosen coarseness",
  "shipping": "local | ships | both",
  "category": "≤24 chars",
  "photos": ["≤4 data-URI JPEGs, each ≤200KB re-encoded client-side"],
  "createdAt": "ISO date",
  "expiresAt": "ISO date, ≤60 days out (auto-unlist)",
  "sig": "<schnorr signature over the canonical serialization of every field above>"
}
```

- **Canonical serialization** (deterministic key order, no whitespace) is
  specified once and shared client/server; `id` = sha256 of it. The same
  listing therefore has the same id everywhere — this is the property v2/v3
  mirroring depends on.
- Photos re-encode client-side (canvas) to strip EXIF — GPS metadata in a
  photo would defeat §3.2.
- Server-side validation mirrors the directory's `cleanMerchant` posture:
  strict on shape, but a listing failing validation is rejected at POST
  time (the author is present to fix it), not silently dropped later.

### 4.2 Offer (private)

```json
{
  "v": 1,
  "type": "offer",
  "listingId": "<listing id>",
  "from": "<buyer x-only pubkey>",
  "to": "<seller x-only pubkey>",
  "payload": "<ciphertext, see §6 — amount, message, contact, logistics>",
  "createdAt": "ISO",
  "sig": "<schnorr by `from` over (listingId | to | payload | createdAt)>"
}
```

The SERVER sees: who is talking to whom about which listing, and when —
metadata only, never content. This metadata visibility must be stated
plainly in the UI ("the operator can see that you contacted this seller,
never what you said").

### 4.3 Receipt (the reputation atom)

```json
{
  "v": 1,
  "type": "receipt",
  "listingId": "<listing id>",
  "seller": "<pubkey>", "buyer": "<pubkey>",
  "txid": "<optional DD transfer txid — present when settled by shipping/transfer>",
  "createdAt": "ISO",
  "sellerSig": "<schnorr by seller over the body>",
  "buyerSig": "<schnorr by buyer over the body>"
}
```

- Valid only with BOTH signatures — one party cannot fabricate history.
- Public. A key's profile = its receipts (count, age span) + its live
  listings + votes. No stars, no reviews text in v1 — co-signed completions
  only, because they are the only thing that cannot be faked cheaply.
- `txid` optional: in-person QR settlements produce a txid too, but parties
  may choose not to link it; a receipt without txid still counts (it is
  still co-signed by two keys who could instead have refused).

## 5. Identity & Sybil Resistance

- Market identity = the wallet's x-only pubkey, displayed as a short
  fingerprint + generated avatar (identicon). No usernames in v1 (§12 Q2).
- **Posting gate:** creating a listing requires the signing key's wallet to
  demonstrate ≥ a configurable dust-level balance (e.g. 100 DGB or $5 DD)
  at post time — server checks via the indexer. Costless for real users,
  expensive for thousand-key spam farms. Browsing and offering are gated
  only by rate limits (buyers may be brand-new wallets, that's fine).
- Per-key rate limits: ≤N active listings (default 10), ≤M offers/hour.
  Existing per-IP limits stay underneath as the outer wall.

## 6. Private Offer Channel (E2E encryption)

- **Scheme:** ECDH over secp256k1 between buyer key and seller key →
  HKDF → XChaCha20-Poly1305 (or AES-GCM if we stay within WebCrypto —
  implementation detail, §12 Q5). Both directions use the same shared
  secret; nonces are random per message.
- The wallet decrypts inbox messages locally; the server stores and relays
  ciphertext blobs, capped (≤8KB/message, ≤200 messages/thread), expiring
  with the listing + 30 days.
- Delivery: poll on the existing 8s cycle + SSE `offer` event push when the
  wallet is open. No push when closed (v1 accepts this; a listing lists an
  expected response time instead).
- **Failure honesty:** if the recipient never opens their wallet, messages
  simply wait. The UI must say "offers are delivered when the seller next
  opens their wallet" — no false immediacy.

## 7. Settlement (deliberately boring)

- **Local (recommended, default filter):** meet, inspect, buyer scans the
  seller's existing receive QR, pays exact DD, both tap "complete" →
  receipt co-signed via the offer channel. The wallet adds nothing new to
  payments — the entire flow is today's transfer + a receipt exchange.
- **Shipped:** buyer pays first (plain transfer), seller ships. The UI
  states the risk in unmissable text and shows the seller's receipt
  history beside the decision. No protection is offered because none
  honestly exists in v1 — better to say so than to imply safety.
- The listing page shows: seller key age (first receipt / first listing
  date), receipt count, flag status. That's the entire trust surface, and
  it is honest.

## 8. Moderation, Abuse, Legal Posture

- Listings: POST → `pending` → operator approves → `live` → expires/sold/
  removed. The pending queue is not publicly visible.
- Published prohibited-items policy (weapons, counterfeits, recalled goods,
  stolen goods, anything illegal in the operator's jurisdiction, financial
  instruments — DD itself is not listable).
- Flags: any wallet can flag (voter-token dedupe); K flags (default 3)
  auto-unlists pending re-review. Flag reasons are an enum, not free text.
- Operator can remove anything, any time; removal is unlist-only (signed
  objects may already be mirrored — the design does not pretend deletion
  is global, and the UI says so at posting time: "listings are public and
  may be copied").
- Terms line at first use of the Classifieds tab: peer-to-peer venue, no
  custody, no guarantee, DYOR — same tone as the existing mainnet-beta
  acknowledgement, one-time typed/checked ack.
- **Data dir:** listings/offers/votes live under `DIGINAUT_DATA_DIR`
  (survives deploys; ReadWritePaths already in place per the Spend DD
  runbook).

## 9. Server Surface (v1)

```
GET  /api/classifieds                 → { listings: [live listings], updatedAt }
GET  /api/classifieds/:id             → one listing + its receipt summary
POST /api/classifieds                 → submit signed listing  (balance-gated → pending)
POST /api/classifieds/:id/flag        → voter-token flag (enum reason)
POST /api/classifieds/:id/vote        → voter-token upvote (Spend DD pattern)
GET  /api/classifieds/inbox/:pubkey   → ciphertext threads for this key (signed request)
POST /api/classifieds/offer           → relay one signed offer envelope
POST /api/classifieds/receipt         → submit a co-signed receipt
GET  /api/classifieds/profile/:pubkey → receipts + live listings for a key
```

- Inbox reads require a signed request (challenge or signed timestamp) —
  ciphertext is private to its participants even though it is ciphertext.
- All endpoints: body caps, per-IP + per-key rate buckets, strict
  validation, chain-guard-independent (like the directory — the board
  works during node maintenance).

## 10. Wallet UI (v1)

- New "Classifieds" pill beside "Spend DD" → full-screen modal, list view
  with category/region/local-vs-ships filters, votes-then-date ordering.
- Listing page: photos, body, price, seller trust panel (§7), "Make an
  offer" → amount + message composer (encrypts client-side).
- "My listings" and "Offers" tabs: post form (client-side photo re-encode +
  EXIF strip), thread view per listing with decrypt-on-open, "mark sold" →
  receipt co-sign handshake through the thread.
- Every state explicit (loading / error+retry / designed empty state) —
  Spend DD conventions; empty state seeds the market: "Nothing listed in
  your region yet — be the first."

## 11. Evolution Path (why v1's shapes are the way they are)

- **v2 — mirrored board:** the approved-listing set is published as a
  signed JSON bundle (merchants-repo pattern). Anyone can mirror it;
  other wallet deployments can render it. Possible because listings are
  self-authenticating (§3.4) with deterministic ids (§4.1).
- **v3 — Nostr rails:** taproot and Nostr share curve + signature scheme,
  and Nostr has a classifieds event kind (NIP-99) and live relay
  infrastructure. The wallet key becomes a Nostr identity; listings/offers
  become Nostr events (offers via NIP-17-style DMs); our server becomes a
  cache + moderated *view*, not the source of truth. DD stays the payment
  rail. v1 objects are designed to translate 1:1 (§12 Q6 tracks the
  mapping).
- **Escrow (unscheduled research):** 2-of-2 MuSig on DD token outputs is
  cryptographically plausible but has NO refund path if a counterparty
  vanishes (DD outputs are key-path-only). Do not build, do not promise,
  revisit only with a regtest proof and a documented recovery story.

## 12. Open Questions (settle before implementation)

1. **Which key signs?** The wallet's receive key (index 0) vs a dedicated
   derivation for market identity (rotatable, unlinkable from funds).
   Privacy says dedicated path; simplicity says receive key. Leaning:
   dedicated derivation (e.g. an unused change-level path) so a market
   identity never links to treasury balances — needs a small hd.js note,
   no consensus impact.
2. Display names: pure pubkey/identicon (v1 lean) or optional self-chosen
   handle (uniqueness fights, impersonation)?
3. Balance gate level and mechanics: amount, DGB or DD, checked once at
   post or re-checked on renew?
4. Escrow: confirmed out of v1 per §11 — revisit trigger = a written
   regtest proof, nothing less.
5. Cipher suite: WebCrypto AES-GCM (zero new deps) vs libsodium-style
   XChaCha (nicer nonces, new vendor dep — vendor.lock impact).
6. v3 mapping table (listing→NIP-99, offer→DM): write it now to keep v1
   fields compatible, or defer entirely?
7. Photos: 4×200KB inline data-URIs make listings ~1MB — fine for v1
   volume? Or a separate capped upload endpoint with content hashing?
8. Does the Spend DD directory fold in later (merchants = "verified
   business" listings), or stay separate forever?

## 13. Non-Goals (v1, explicitly)

Payments changes of any kind · escrow · auctions/bids with deadlines ·
search beyond filter/sort · mobile push · fiat display of anything except
the existing DD≈USD equivalence · cross-server federation (that's v2/v3) ·
automated dispute resolution · seller fees (free while the market grows;
a listing-renewal fee in DD is the obvious future anti-spam + revenue
lever, noted and deferred).
