# Core wallets as gift recipients — PROVEN first-class on regtest Core v9.26.4

Date: 2026-07-27. Question: can a plain **DigiByte Core wallet** receive a gifted
(mint-to-order) treasury and live with it using **nothing but Core RPCs** — no Diginaut,
no seed import, no manual script surgery? Verified empirically by
`scripts/core-recipient-spike.mjs` (self-contained: boots its own regtest node).

## Verdict: YES — see it, track it, redeem it, Core-only

1. **The Gift-key extraction recipe works as documented.** For a descriptor wallet's
   bech32m address, `getaddressinfo` exposes the raw x-only owner key inside the
   `desc` field (`tr([origin]KEY)`; drop a leading `02`/`03` if 66 hex chars), and
   `ddTokenOutputKey(extracted key) == the address's witness program` — asserted, exact.
   Encoding that key as `ddgift1…` round-trips through `encodeGiftKey`/`decodeGiftKey`.
2. **The gifted DD is visible immediately.** `getdigidollarbalance` on the recipient
   wallet reports the full minted amount as soon as the gift mint confirms.
   ⚠ Units gotcha: this build reports **cents** (`{"confirmed":10000,…,"total":10000}`
   = $100), not dollars — a naive dollar reading looks 100× off.
3. **The position itself is tracked.** `listdigidollarpositions` on the recipient
   wallet shows the gifted position with `position_id` (the mint txid), `dd_minted`,
   `dgb_collateral`, `unlock_height`, `unlock_date`, `blocks_remaining`, `status`,
   `health_ratio` and `can_redeem` — Core's position scanner indexes owner-keyed
   positions regardless of which wallet authored the mint transaction.
4. **Redemption is one RPC.** After maturity, `redeemdigidollar <position_txid> <cents>`
   from the recipient wallet burned the gifted DD and unlocked the full collateral to a
   fresh address of theirs (75,260.80 DGB in the proof run). No other party involved.

## The recipe to document for Core-wallet recipients

```
# 1. make (or pick) a taproot address
digibyte-cli getnewaddress "" bech32m
# 2. read its descriptor — the key inside tr(...) is your raw owner key
digibyte-cli getaddressinfo <the dgb1p… address>
#    desc: "tr([...]<KEY>)#..." → KEY (drop a leading 02/03 if 66 chars)
# 3. turn KEY into a ddgift1… Gift key (checksummed) and hand THAT to the giver
```

Step 3 needs tooling (nobody should hand-assemble bech32m): the wallet should grow a
small client-side "Make a Gift key" helper where a Core user pastes their
`getaddressinfo` output and gets the `ddgift1…` string plus the derived DD address to
cross-check. Until it exists, the extraction is operator-assisted.

## Mainnet confirmation (2026-07-27, real gift, Diginaut beta → Core Qt v9.26.2)

A live $100 / 10-year gift to a Core **Qt GUI** wallet (v9.26.2 — older than the
regtest-proven 9.26.4) confirmed the proof and mapped the GUI's rendering of it:

- **Balance ✓** — the $DD Overview credited the $100 immediately (spendable).
- **Vault ✓** — the position appears in the $DD Vault tab with its 10-year term.
- **Main Overview** — shows the gift as a generic "DigiDollar Transfer (In)" row.
- **GUI blind spot** — the "$DD Transactions" list does NOT show the incoming
  gift: it classifies Send / Receive (transfers) / Mint (own mints), and an
  externally-authored mint matches none of its categories. Balance and vault
  come from the UTXO and position scans, which both see it — money and position
  are correct; only the history list is blind. Worth reporting upstream to the
  DigiDollar Core developers as a mint-to-order rendering gap. RETESTED after
  updating that wallet to the current DigiDollar build (2026-07-27): same
  behavior — the gap is present in the latest release, not just v9.26.2.

Caveats that keep this honest:

- Proven on **descriptor** wallets (the v9.26 default). Legacy non-descriptor wallets
  have no `tr()` descs; taproot-and-DD-capable wallets are descriptor wallets anyway.
- The recipient must keep a small DGB **fee pocket** to redeem later — the gift-note
  text already says so.
- `getdigidollarbalance` is address-scoped by wallet; the gifted DD sits at whichever
  address's key was shared — sweeping/consolidating it later is the recipient's normal
  wallet business.
