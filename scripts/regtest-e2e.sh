#!/usr/bin/env bash
# Stand up the full regtest stack and run the e2e drivers against it.
#
# CI and humans run THIS SAME SCRIPT on purpose. The consensus drivers rotted
# undetected for five days because nothing ran them, and a CI-only copy of the
# recipe would simply rot somewhere new. One path, one set of assumptions.
#
# Usage:
#   scripts/regtest-e2e.sh                    # every regtest driver
#   scripts/regtest-e2e.sh verify-redeem      # just these
#
# Environment:
#   DGB_BIN    digibyted binary        (default: /opt/digibyte/bin/digibyted)
#   EX_PYTHON  python holding electrumx + plyvel
#                                      (default: /opt/ex-venv/bin/python)
#   KEEP_UP    non-empty leaves the stack running for the next invocation
#
# Prerequisites and the traps that cost real time are in CONTRIBUTING.md.
# Linux only: plyvel has no Windows wheels. WSL2 is fine.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DGB_BIN="${DGB_BIN:-/opt/digibyte/bin/digibyted}"
EX_PYTHON="${EX_PYTHON:-/opt/ex-venv/bin/python}"
LOGS="${LOGS:-/tmp/dgb-e2e-logs}"
RPCPORT=18500
mkdir -p "$LOGS"

# Every driver that drives a real chain. Filtered to what exists on this branch
# so a driver added on a feature branch cannot turn main red.
ALL_DRIVERS=(
  verify-mint verify-send verify-transfer verify-redeem
  verify-balance verify-positions verify-p2wpkh-change
  verify-fold-shapes verify-walkthrough
)

say() { echo "── $*"; }
die() { echo "!! $*" >&2; exit 1; }

wait_port() { # wait_port <port> <label> <timeout-s>
  local p=$1 label=$2 t=${3:-60} i=0
  while [ "$i" -lt "$t" ]; do
    (echo > "/dev/tcp/127.0.0.1/$p") >/dev/null 2>&1 && { say "$label up on :$p"; return 0; }
    sleep 1; i=$((i+1))
  done
  echo "!! $label never came up on :$p"; return 1
}

reap_chrome() { pkill -f 'remote-debugging-port=9224' 2>/dev/null; sleep 1; }
reap_services() {
  for p in 'apps/indexer/server.js' 'apps/faucet/server.js' 'apps/wallet/server.js' 'launcher.py'; do
    pkill -f "$p" 2>/dev/null
  done
  reap_chrome
}
cleanup() {
  reap_chrome
  [ -n "${KEEP_UP:-}" ] && { say "stack left running (KEEP_UP set)"; return; }
  reap_services
}
trap cleanup EXIT

[ -x "$DGB_BIN" ]   || die "no digibyted at $DGB_BIN (set DGB_BIN)"
[ -x "$EX_PYTHON" ] || die "no electrumx python at $EX_PYTHON (set EX_PYTHON)"
command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 \
  || die "no Chrome/Chromium on PATH"

# ------------------------------------------------------------------ node
node_alive() {
  curl -s --max-time 3 --user dd:ddpass -X POST "http://127.0.0.1:$RPCPORT/" \
    -H 'content-type: text/plain' \
    -d '{"jsonrpc":"1.0","id":"p","method":"getblockchaininfo","params":[]}' 2>/dev/null \
    | grep -q '"regtest"'
}
# A PRISTINE chain by default, because several drivers are only correct on one.
# verify-positions restores the fixed BIP39 test vector ("abandon…about") and
# asserts `balance < collateral` as a proxy for "locked collateral is not
# counted as spendable". Re-run against a chain that already holds its earlier
# funding and redeemed collateral, that balance climbs past the threshold and
# the check fails without anything being wrong. CI always gets a fresh chain,
# so a runner that silently reuses one is not reproducing CI.
# REUSE_CHAIN=1 skips the ~651-block rebuild for fast local iteration, at the
# cost of exactly that coupling.
if [ -n "${REUSE_CHAIN:-}" ] && node_alive; then
  say "REUSE_CHAIN set: keeping the existing chain (drivers may see prior state)"
else
  if node_alive; then
    say "tearing down the previous chain for a clean run"
    curl -s --max-time 5 --user dd:ddpass -X POST "http://127.0.0.1:$RPCPORT/" \
      -H 'content-type: text/plain' \
      -d '{"jsonrpc":"1.0","id":"s","method":"stop","params":[]}' >/dev/null 2>&1
    sleep 3
    pkill -f 'digibyted -regtest' 2>/dev/null
    sleep 2
  fi
  say "starting regtest stand (mines 651 blocks, activates DigiDollar, mock oracle)"
  reap_services
  DGB_BIN="$DGB_BIN" bash "$REPO/scripts/regtest-stand.sh" --keep > "$LOGS/stand.log" 2>&1 \
    || { tail -30 "$LOGS/stand.log"; die "regtest stand failed"; }
  grep -E 'DigiDollar ACTIVE|EXACT MATCH' "$LOGS/stand.log" || true
fi
wait_port $RPCPORT "node rpc" 30 || die "node rpc unreachable"

# ------------------------------------------------------------- electrumx
say "starting ElectrumX"
pkill -f 'launcher.py' 2>/dev/null; sleep 1
rm -rf "$LOGS/exdb" && mkdir -p "$LOGS/exdb"
# ALLOW_ROOT because CI runners and WSL both run as root and the repo is not
# world-readable there; the listener is loopback-only either way.
( cd "$REPO/scripts/electrumx-regtest" && \
  DAEMON_URL="http://dd:ddpass@127.0.0.1:$RPCPORT" \
  COIN=DigiByte NET=regtest DB_ENGINE=leveldb DB_DIRECTORY="$LOGS/exdb" \
  SERVICES=tcp://127.0.0.1:50001 COST_SOFT_LIMIT=0 COST_HARD_LIMIT=0 ALLOW_ROOT=1 \
  nohup "$EX_PYTHON" launcher.py > "$LOGS/electrumx.log" 2>&1 & )
wait_port 50001 "electrumx" 120 || { tail -25 "$LOGS/electrumx.log"; die "electrumx failed"; }
sleep 4  # let it finish indexing before the first scan

# -------------------------------------------------------- node services
cd "$REPO"
say "starting indexer / faucet / wallet"
for p in 'apps/indexer/server.js' 'apps/faucet/server.js' 'apps/wallet/server.js'; do
  pkill -f "$p" 2>/dev/null
done
sleep 1

# DGB_HRP=dgbrt is REQUIRED here. The indexer defaults to 'dgbt' (testnet) and
# rejects any address whose hrp differs; because money fields are
# complete-or-absent, the symptom is an undefined amount at the caller rather
# than an error, which reads like a null-pointer bug and is not one.
PORT=8789 DGB_HRP=dgbrt ELECTRUM_HOST=127.0.0.1 ELECTRUM_PORT=50001 \
  nohup node apps/indexer/server.js > "$LOGS/indexer.log" 2>&1 &
wait_port 8789 "indexer" 30 || { tail -20 "$LOGS/indexer.log"; die "indexer failed"; }

PORT=8791 DGB_RPC_URL="http://127.0.0.1:$RPCPORT" DGB_RPC_USER=dd DGB_RPC_PASS=ddpass \
FAUCET_URL=http://127.0.0.1:8790 INDEXER_URL=http://127.0.0.1:8789 \
  nohup node apps/wallet/server.js > "$LOGS/wallet.log" 2>&1 &
wait_port 8791 "wallet" 30 || { tail -20 "$LOGS/wallet.log"; die "wallet failed"; }

# ------------------------------------------------------------- drivers
requested=("$@")
if [ ${#requested[@]} -eq 0 ]; then
  requested=()
  for d in "${ALL_DRIVERS[@]}"; do
    [ -f "$REPO/apps/wallet/scripts/$d.mjs" ] && requested+=("$d")
  done
fi

passed=(); failed=()
for name in "${requested[@]}"; do
  driver="$REPO/apps/wallet/scripts/$name.mjs"
  [ -f "$driver" ] || { echo "❌ $name — no such driver"; failed+=("$name"); continue; }
  echo; say "$name"

  # A FRESH FAUCET per driver, for the same reason as the Chrome profile below.
  # The faucet enforces a 24h per-claimer cooldown, so the first driver to
  # claim silently starves every later one: verify-send passed and then
  # verify-balance and verify-walkthrough both timed out on "faucet dispensed".
  # Note FAUCET_COOLDOWN_HOURS=0 does NOT disable it — the server reads
  # `Number(env) || 24`, so a zero falls back to 24. A per-driver claims file is
  # the reliable isolation.
  pkill -f 'apps/faucet/server.js' 2>/dev/null; sleep 1
  PORT=8790 DGB_RPC_URL="http://127.0.0.1:$RPCPORT" DGB_RPC_USER=dd DGB_RPC_PASS=ddpass \
  DGB_RPC_WALLET=stand FAUCET_DATA_FILE="$LOGS/faucet-$name.json" \
    nohup node apps/faucet/server.js > "$LOGS/faucet.log" 2>&1 &
  wait_port 8790 "faucet" 30 || { tail -20 "$LOGS/faucet.log"; failed+=("$name"); continue; }

  # A FRESH Chrome profile per driver is mandatory: IndexedDB carries the
  # vault, so a reused profile boots the next driver into 'locked' instead of
  # 'no wallet' and it times out on its first wait.
  reap_chrome
  PROFILE=$(mktemp -d)
  google-chrome --headless=new --remote-debugging-port=9224 --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check --disable-gpu --no-sandbox about:blank \
    > "$LOGS/chrome-$name.log" 2>&1 &
  wait_port 9224 "chrome cdp" 60 || { failed+=("$name"); continue; }

  if ( cd "$REPO/apps/wallet/scripts" && node "$driver" ); then
    echo "✅ $name"; passed+=("$name")
  else
    echo "❌ $name"; failed+=("$name")
  fi
  rm -rf "$PROFILE"
done

echo
echo "════════ regtest e2e ════════"
echo "passed (${#passed[@]}): ${passed[*]:-none}"
echo "failed (${#failed[@]}): ${failed[*]:-none}"

if [ ${#failed[@]} -ne 0 ]; then
  echo
  for f in "$LOGS/electrumx.log" "$LOGS/indexer.log" "$LOGS/wallet.log" "$LOGS/faucet.log"; do
    echo "── $f"; tail -25 "$f" 2>/dev/null || echo "(none)"
  done
  exit 1
fi
echo "all regtest drivers green"
