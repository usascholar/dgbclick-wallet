# Recovering a "stranded" gift position

> This is the generic operator's guide for `scripts/recover-stranded-gift.mjs`.
> It contains no live positions, keys, or wallet data — yours stay in your own
> gitignored `scripts/recovery-position.json`.

## The bug class this covers

The wallet's first gift flow (pre-Gift-key builds) passed the recipient's **address
key** into the mint's `ownerKeyHex`, which expects the **raw internal key**. A
DigiDollar address encodes `Q = ddTokenOutputKey(P)` — a one-way BIP-341-style tweak
of the internal key `P` — so such a mint was created owned by `Q` instead of `P`.
The position is perfectly valid on-chain; it simply sits at scripts no shipped wallet
scans or signs for:

- the DD token output and the collateral's redemption leaf answer to the **tweaked**
  script `tweak(Q)`, while wallets look for positions owned by `P`;
- both outputs are nevertheless controlled by `dQ` — the once-tweaked private key of
  the recipient address:

```
dQ = (d + taggedHash('TapTweak', xOnly(d))) mod n     // negate d first if its Y is odd
```

where `d` is the private key of the recipient DD address (`DD1…`), exportable from
the wallet that holds it (Core: the address's private descriptor / `dumpprivkey`).

**Nothing is urgent and nothing expires.** The outputs stay valid and unspent until
you move them; the collateral's timelock matures on its schedule whether or not any
wallet watches it. Handle the key offline, use it in one session, and never paste it
into anything networked.

## The tool

`scripts/recover-stranded-gift.mjs` is a mainnet CLI that performs the recovery with
the wallet's own protocol builders:

```
node scripts/recover-stranded-gift.mjs status        # read-only; never asks for a key
node scripts/recover-stranded-gift.mjs recover-dd    # sweep the DD to an address you watch
node scripts/recover-stranded-gift.mjs redeem        # release the collateral (after maturity)
```

Safety, by construction:

- the private key is **never** a CLI argument (shell history) and never touches disk —
  it is typed at a hidden prompt, held in memory, used, and dropped;
- the script **refuses to continue** unless the typed key's tweaked pubkey equals the
  position's owner key — a wrong key stops before any signing;
- nothing is broadcast without an explicit typed `yes` after a full preview;
- chain state is read through **your own node** only (no third-party service).

Position parameters live in `scripts/recovery-position.json` (gitignored — it names a
live position). Shape:

```json
{
  "mintTxid": "<64-hex mint/position txid>",
  "collateralSats": 123456789,
  "ddCents": 10000,
  "unlockHeight": 44900000,
  "ownerKeyHex": "<the position's owner key Q as minted — 64-hex x-only>",
  "hrp": "dgb",
  "network": "mainnet",
  "rpcUrl": "http://127.0.0.1:14022",
  "conf": "/path/to/digibyte.conf"
}
```

`rpcUrl`/`conf` can be replaced by the `DGB_RPC_USER`/`DGB_RPC_PASS` (and `DGB_RPC_URL`,
`DGB_CONF`) environment variables.

## What each step does

- **recover-dd** (any time — no deadline): the stranded script `tweak(Q)` is itself a
  payable address. The tool asks you to fund it with a small fee coin (~1 DGB), then
  builds a DD transfer that spends the stranded DD token *and* the fee coin from that
  script, signed with `dQ`, paying the DD to an address your wallet already watches.
- **redeem** (after the lock matures): the collateral's Normal redemption leaf is
  owned by `Q`. Put the required DD amount back at the stranded address (DD is
  fungible — any DD works), plus a fee coin; the tool builds a redeem signed with
  `dQ`, returning the collateral to an address you choose.
  ⚠️ There is **no owner-reclaim path without burning DD** (verified against Core
  consensus): the DD is mandatory at redemption. If the original DD was spent,
  budget for re-acquiring it before the collateral can be released.

## Proof

`scripts/stranded-gift-recovery-spike.mjs` performs this whole lifecycle — gift to an
address key, strand, sweep the DD, mature, redeem the collateral — against a
throwaway regtest chain with a real DigiByte Core node. Read it as executable
documentation before touching mainnet.
