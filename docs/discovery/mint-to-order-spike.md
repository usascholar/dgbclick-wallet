# Mint-to-order: consensus feasibility — PROVEN on regtest Core v9.26.4

Date: 2026-07-26. Question: can a mint be **funded and signed by key A (a "seller/giver")
while naming key B (a "buyer/recipient") as the position owner** — so the funder never
holds anything worth keeping? Verified empirically against a real DigiByte Core v9.26.4
regtest node (`scripts/regtest-stand.sh --keep`, deterministic mock oracle at 13,420 µUSD).

## Verdict: YES — consensus-valid, full cycle

`scripts/mint-to-order-spike.mjs` hand-builds a mint whose funding input is signed by A
while vout[0] (collateral), vout[1] (DD token) and vout[2] (metadata `ownerKeyHex`) all
name B, broadcasts it, and then has **B redeem unaided** using the shipped
`buildSignedRedeemTx` unmodified:

1. **Exotic mint ACCEPTED by mempool and mined** (`sendrawtransaction` OK, confirmed in
   block) — `ValidateMintTransaction` does not require the funding key to equal the
   metadata owner key.
2. **Buyer redemption ACCEPTED** — at the 1-hour tier's unlock height, B burned the
   minted DD and released the collateral with only key B. The seller never possessed
   the owner key, so there is nothing to claw back. This is the trustless endowment
   primitive the treasury spec's §7.1 said did not exist: it exists at *creation*
   time; it does not help *existing* positions (their owner key is already baked in).

## Regtest mechanics that obscured the result (know them before testing mints)

- **Dandelion**: broadcasts land in the *stempool* (embargo) first — blocks ignore them
  until fluff. For deterministic harness runs, start the node with `-dandelion=0`.
- **Oracle-bundle gating**: DD txs are only mined in blocks carrying a fresh MuSig2
  oracle bundle (`CreateNewBlock(): skipping DD tx … no valid MuSig2 oracle bundle is
  ready`). The mock oracle produces a bundle per `setmockoracleprice` call — force one
  before mining a mint, and expect mints to sit unconfirmed in bundle-less blocks.
- **Lock window**: a mint must be mined within its lock window or it is dropped as
  `bad-lock-period`. A mint stuck in the mempool past its window is dead; rebuild it.
- The mock oracle **resets its price on node restart** (to 6,500 µUSD) — a >50% move
  that trips the volatility mint freeze until the window clears (~240 blocks).

## Consequence for the wallet

`buildSignedMintTx` derives `ownerKey = xOnlyPubKey(privKeyHex)` internally
(`packages/digidollar-js/src/txbuild.js:526`). Mint-to-order is therefore one ADDITIVE
parameter away: accept an optional `ownerKeyHex` (default: the signer's key — byte-
identical output for every existing caller and fixture) and use it for the three owner
outputs while the funding script, signature and change stay the signer's. The exotic
shape is proven byte-level compatible with real Core above.
