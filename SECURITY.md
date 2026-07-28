# Security Policy

DGBclick Wallet is a non-custodial wallet: keys are generated and used in the
browser and never leave the device. A vulnerability here can put real funds at
risk, so we take reports seriously and ask you to disclose them privately.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** Public
disclosure before a fix is available puts users at risk.

Instead, use **GitHub's Private Vulnerability Reporting**:
1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version/commit, and a proof of concept if
   you have one.

This opens a private advisory visible only to you and the maintainers, so
triage and a fix can happen before anything is public.

## What to expect

- We aim to acknowledge a report within a few days.
- We will confirm the issue, work on a fix, and coordinate disclosure timing
  with you.
- Fixes ship to the live sites (wallet.dgbclick.com, beta.dgbclick.com) first;
  this repository receives reviewed release snapshots after.

## Scope

In scope — the code in this repository:
- the wallet server and browser client (`apps/wallet`),
- the indexer façade (`apps/indexer`),
- the protocol library (`packages/digidollar-js`),
- the faucet (`apps/faucet`).

The DigiByte node, DigiByte Core, ElectrumX, and the DigiDollar consensus
protocol itself are separate upstream projects — please report issues in those
to their respective maintainers.

## Good to know

- This is beta software operating on a live network. The UI states this
  plainly; users bear their own risk.
- The wallet holds no server-side custody of funds and never transmits private
  keys. Findings that assume otherwise are likely misreadings — but if you can
  demonstrate key or fund exposure, that is exactly what we want to hear about.
