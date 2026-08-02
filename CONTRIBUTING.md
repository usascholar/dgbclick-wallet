# Contributing to DGBclick Wallet

This is a wallet: the code here generates and signs with keys that control real
money. That shapes everything below. Contributions are welcome, and the bar is
"a reviewer can convince themselves this is correct," not "it works on my
machine."

**If you are an AI agent working in this repo, read [For AI agents](#for-ai-agents)
at the bottom. It is not optional and it is short.**

## The one thing that trips up every new checkout: line endings

**All source files use LF. Never commit CRLF.**

This is not a style preference. `apps/wallet/vendor.lock` stores a SHA-256 hash
of every file the browser executes, including `packages/digidollar-js/src/*.js`,
and **the server refuses to start if any hash mismatches**. Git converts line
endings per platform, so a file committed with CRLF from Windows hashes
differently on a Linux checkout, which means:

- CI goes red on every run, and
- a Linux build or container deploy **refuses to boot**, because the integrity
  check is deliberately fail-closed.

`.gitattributes` pins the hashed sources to `eol=lf`, so a normal checkout is
correct automatically. You only hit trouble if you create files outside git's
control (a generator, an editor writing CRLF, a copy-paste into a new file).

**Check before you commit:**

```bash
npm run vendor:verify   # includes "git archive matches vendor.lock"
```

If it reports `git archive does NOT match vendor.lock`, fix it with:

```bash
rm <the-file> && git checkout -- <the-file> && npm run vendor:lock
```

## Before you open a PR

```bash
npm ci                  # not npm install; installs the lockfile exactly
npm test                # the full node:test suite across all workspaces
npm run vendor:verify   # supply-chain + line-ending checks (offline stages)
```

All three must pass. CI runs the same things, plus browser drivers.

## The security-critical files

Changes to any of these need a reviewer other than the author, reading the diff
line by line:

| File | Why |
|---|---|
| `packages/digidollar-js/src/hd.js` | key and seed generation |
| `packages/digidollar-js/src/rng-health.js` | the CSPRNG health gate |
| `packages/digidollar-js/src/txbuild.js` | transaction construction and signing |
| `apps/wallet/vendor.lock` | the integrity baseline for everything the browser runs |
| `package-lock.json` | which dependency versions are installed |
| `apps/wallet/vendor-integrity.js` | the checker itself |

**Never regenerate `vendor.lock` to make a failing check go away.** That check
failing means the code the browser executes changed. Regenerating the lock
without reading the diff is precisely how a supply-chain compromise gets
laundered into a release. It is the "re-lock attack" that
`npm run vendor:verify` exists to catch, by comparing the lock against the
tarballs npm actually published. Regenerate it only after a deliberate
dependency change, and say so in the commit message.

## Working across Windows and Linux

Development happens on Windows; CI and production run Linux. Known differences:

- **Line endings**: covered above. The single most common cause of a red build.
- **Test peers must swallow socket errors.** A test TCP peer that does not
  attach an `error` handler will occasionally fail its whole file on Linux with
  a stray `ECONNRESET` after the test ends, while passing on Windows. Node
  promotes that late event to an uncaught exception. If you add a fake server,
  add `sock.on('error', () => {})`.
- **Never assert on a fixed sleep.** Wait for the actual condition, with a
  timeout. A `setTimeout(120)` that is "obviously long enough" locally becomes a
  flaky failure under CI's parallel load. Poll the file, the DOM node, or the
  API response you actually depend on.
- **Executable bits do not survive a Windows commit.** Windows has no Unix
  execute bit, so a shell script added from Windows is recorded `100644` and a
  Linux runner refuses it with "Permission denied" before it runs. If you add a
  script meant to be executed, set the bit in git explicitly:
  `git update-index --chmod=+x scripts/your-script.sh`. Prefer invoking scripts
  as `bash scripts/x.sh` in CI so the mode cannot break the job at all.
- **Browser drivers** (`scripts/run-drivers.sh`) need Chrome and are
  platform-sensitive; a few are known to fail on some Windows checkouts. Run the
  unit suite as your gate and treat driver results as advisory locally.

## Testing conventions

- `node:test` only, no framework. Tests live beside the code they cover.
- A test's name should state the behaviour, not the function name.
- Consensus-touching changes (mint / transfer / redeem) need a regtest proof
  against a real DigiByte Core node, not just unit assertions. See
  `scripts/regtest-stand.sh` and the `DD_E2E_RPC` env-gated suites.
- Run e2e regtest files **one at a time**; several mining into one node
  concurrently will wedge it.

### Standing up the regtest stack

The regtest drivers (`verify-transfer`, `verify-redeem`, `verify-mint`,
`verify-send`) need the whole chain: DigiByte Core → ElectrumX → indexer →
faucet → wallet → headless Chrome. They cannot run in CI, so they are not in
the default `run-drivers.sh` set and nothing checks them for you. Run them
before any change to mint, transfer, or redeem.

```bash
DGB_BIN=/path/to/digibyted scripts/regtest-stand.sh --keep   # node on :18500
DAEMON_URL=http://dd:ddpass@127.0.0.1:18500 scripts/electrumx-regtest/run.sh
PORT=8789 DGB_HRP=dgbrt ELECTRUM_HOST=127.0.0.1 ELECTRUM_PORT=50001 node apps/indexer/server.js
```

Four things cost real time to rediscover, so they are written down here:

- **`DGB_HRP=dgbrt` is mandatory on regtest.** The indexer defaults to `dgbt`
  (testnet) and hard-rejects any address whose hrp differs. Because money
  fields are complete-or-absent, the symptom is not an error message but
  `totalCents` arriving as `undefined` at the caller.
- **ElectrumX refuses to run as root.** The Dockerfile drops to an
  unprivileged user; outside Docker, either do the same or set `ALLOW_ROOT=1`.
- **`plyvel` needs `python3-dev`,** not just `build-essential`. Without the
  CPython headers the only symptom is `Python.h: No such file or directory`
  buried in a pip subprocess.
- **Windows cannot host this stack.** `plyvel` has no Windows wheels. Use WSL2
  or Linux; the node itself is the only part that runs natively on Windows.

## What this project will not accept

- Anything that sends a private key, seed, or unencrypted keystore off-device.
- A new third-party origin in the CSP without a written reason.
- Mint shipped without redeem and transfer (no one-way traps).
- Silent truncation of money data. If a scan cannot complete, the response says
  so and **omits** the field. An empty array means "none", and the UI renders it
  as such. A partial list under a full name is how a user's vault vanishes.
- New runtime dependencies without discussion. The browser bundle carries
  audited crypto only.

## For AI agents

If you are an automated agent contributing here, these are the rules that most
often go wrong:

1. **Write files with LF endings.** You will otherwise break the integrity lock
   and the build, as explained above. Verify with `npm run vendor:verify`
   before you report success.
2. **Run the checks and report the real numbers.** `npm test` and
   `npm run vendor:verify`, both passing, quoted honestly. Do not describe a
   change as verified if you did not run it.
3. **Do not regenerate `vendor.lock` to clear an error.** Read what changed
   first. If you cannot explain the change, stop and say so.
4. **Do not weaken a check to make it pass.** If `assertHealthyRandom`, the
   vendor integrity check, or a money-visibility guard is in your way, the
   correct output is an explanation of why it fires, not a bypass.
5. **State what you did not verify.** Partial verification reported as complete
   is worse than no verification, because it ends the review.
6. If a task's premise appears false (a file that does not exist, a claim the
   code does not support), say so plainly instead of inventing something that
   fits.
