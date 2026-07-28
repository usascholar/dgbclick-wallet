# Treasury Wallets — Use Cases from the Shipped Code

Date: 2026-07-26. Companion to `docs/treasury-wallets-spec.md`. Every case below maps to
a flow that exists in the wallet today — no hypotheticals. The organizing principle is
the trust model: a treasury is keys, and keys can be copied, so the right question for
each case is **who has to trust whom, and for how long**.

The three primitives the code provides:

1. **Time-locked collateral (CLTV)** — nobody, not even the owner, not a court, can
   release the DGB before the unlock height. Pre-maturity the only thing anyone can do
   is move the minted DD (visible on-chain, FR-4 flag).
2. **Independent seeds per treasury** — each treasury is a separately handable-over
   artifact (`.keystore.json` + password), with a self-describing name
   (`DD100-2036-07-21-A`) and a GitHub-backed encrypted inventory.
3. **Mint-to-order ("Gift a locked treasury")** — the funder's key signs, the
   *recipient's* key owns the position from the first block. The funder never holds
   anything and can never claw back. Proven consensus-valid full-cycle on regtest Core
   (`docs/discovery/mint-to-order-spike.md`).

---

## Class 1 — Yourself (no transfer, no trust problem)

The strongest fits, because "the seller keeps a copy" is meaningless when you are both.

### Forced savings / anti-panic-sell vault
Split a stack into 10-year treasuries (Split wizard). The CLTV is a commitment device
enforced by consensus: you *cannot* dump in a bear market, at 3am, on a margin call.
The minted DD stays liquid — you lock the upside, not the grocery money.

### Liquidity today, exposure tomorrow
Each treasury is a self-issued, over-collateralized loan: lock ≈ $200 of DGB, spend
$100 DD now, keep full long-term DGB exposure. No lender, no margin call mechanism on
the lender side — the protocol holds the collateral, not a counterparty.

### Retirement ladder
Treasuries maturing in different years (`DD100-2030-…`, `DD100-2032-…`, …) — a bond
ladder that pays out on a schedule and can't be raided early. The self-describing
names make the ladder legible in the dashboard and in the GitHub backup listing
(search `2030` → that year's rung).

### Public proof-of-commitment
A founder points at an on-chain position: "my collateral is consensus-locked until
2036 — verify it yourself, I cannot dump." No auditor, no promise. The position txid
is the proof; the lock is enforced by the protocol, not by reputation.

---

## Class 2 — Family (transfers inside trust)

The "seller keeps a copy" issue is acceptable here — or even useful.

### Wills / spreading wealth among heirs
One treasury per heir, independent seeds, no shared point of failure. The keystore
file is a bearer instrument: print it, safe-deposit it, leave the passphrase with the
executor. The self-describing filename makes the estate administrable ("the
2036-07-21 treasuries A–C go to the kids"), and RECEIPT.txt from the handover flow is
half of an estate letter already. Two honest properties:
- **Revocable while alive** — you keep your seed copies, so you can redeem and
  re-mint at maturity if the family changes. That's what a will *is*.
- **Bearer risk** — whoever finds the envelope owns it; estate law won't help. Death
  without the password reaching the executor is total loss. Mitigation: the GitHub
  encrypted backup (repo access to the executor) + passphrase held by the lawyer.

### Time-locked gifts ("for your 18th birthday")
Two shapes, depending on how much you trust yourself:
- **Treasury handover** (Class 2 trust): you create, hold, and hand over the keystore
  later. You retain a copy — parental control while they're a minor.
- **Mint-to-order gift** (trustless): you fund it, they own it from the first block.
  Irrevocable — even you can't take it back. The wallet's gift note tells them what
  they got and when it unlocks. The minted DD is theirs to spend today; the
  collateral waits for the date. "Here's $100 for now, and $200+ for 2036" in one
  transaction.

### Kids' savings vaults
Parent creates and holds treasuries per child (dashboard cards named per child),
hands over at maturity. Retention of keys is the point.

---

## Class 3 — Public / pseudonymous (know the limits)

### Public treasure hunts / geocached bounties
Hide a seed phrase physically. Whoever finds it owns "$100 DD now + locked DGB in
2030" — a prize that appreciates, that even the hider can't grab back early (CLTV),
and that is first-come-first-served by design. The independent seed means the rest of
your wallets are not exposed.

### Donations with a date
Fund a scholarship that unlocks in 5 years (mint-to-order to the recipient's key, or
hand over a keystore). Honest privacy note: the *funding transaction* is on a public
ledger, so main-wallet → treasury links you on-chain. Independent seeds separate
treasuries *from each other*, not from their funder. "Hard to casually associate" —
not anonymous.

---

## Class 4 — Strangers (was impossible, unlocked by mint-to-order)

These all need "the giver provably cannot reclaim." Before mint-to-order this class
was a pinky promise; now it's protocol truth. (For *existing* treasuries the old
warning still stands — an already-minted owner key cannot be rotated; only new
positions get the trustless property.)

### Employee / contractor vesting
Mint-to-order a 4-year treasury to the employee's address. The employer cannot claw
it back (they never held the key); the employee cannot spend it early (CLTV). That is
*actual* vesting, enforceable by no one because it needs no one.

### Grants / DAO payouts
Same shape: the grant is minted to the recipient's key with a lock. Non-revocable
funding with enforced delayed release — the two properties grant-givers and
grant-receivers both want, and neither could get from a plain send.

### Private sales of locked positions, safely
A buyer can now commission a position: "fund and mint $100 DD at the 10-year tier to
my address, and I'll pay you on delivery" — the seller's retained knowledge is
worthless because the owner key was never theirs. (Payment-vs-delivery itself is
still a normal commerce problem — escrow, trust, or a plain swap of the mint for
payment; but the *clawback* vector is gone.)

---

## What still doesn't work (be honest with yourself)

- **Selling an EXISTING treasury trustlessly.** The owner key is baked into the
  position at mint. Redeem-and-re-mint at maturity is the only "rotation," and it
  needs the current holder's cooperation. The handover flow's warning stays.
- **Locking the DD itself.** DD is a liquid stablecoin by design — a mint-to-order
  recipient can spend the $100 immediately. What locks is the collateral. "None of
  it spendable until 2036" is not a thing the protocol offers.
- **Anonymity.** See Class 3: pseudonymous separation, not anonymity.
- **Recovering from a lost password.** The GitHub backup is encrypted; the password
  is the key to it. Seed words on paper remain the ultimate backup.

---

*Implementation pointers: Split wizard (FR-1), dashboard + handover (FR-2/FR-7),
GitHub backup (FR-8), gift flow (`gift-modal` / mint-to-order). Every flow here is
covered by a CDP driver in `apps/wallet/scripts/`.*
