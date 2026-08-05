#!/usr/bin/env bash
# Run the headless-Chrome CDP drivers, correctly.
#
# Two rituals these drivers depend on, both learned the hard way:
#   1. A FRESH Chrome --user-data-dir per driver. IndexedDB carries the vault,
#      so a reused profile boots the next driver into 'locked' instead of
#      'no wallet' and it times out on its first wait.
#   2. No survivors between runs. A driver that dies leaves its fake-indexer
#      holding the port; the next run's own indexer then fails to bind
#      (stdio:'ignore', so silently) and the driver reads the PREVIOUS run's
#      funding as chain truth — which produces a confident false pass.
#
# Usage:
#   scripts/run-drivers.sh              # every driver in the default set
#   scripts/run-drivers.sh verify-ui verify-receive-ui
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
CDP_PORT=9224

find_chrome() {
  for c in \
    "${CHROME_BIN:-}" \
    google-chrome-stable google-chrome chromium chromium-browser \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}
CHROME="$(find_chrome)" || { echo "no Chrome/Chromium found (set CHROME_BIN)"; exit 2; }
echo "chrome: $CHROME"
node --version

# Drivers that stand up everything they need. The rest want a wallet server on
# 8791 and a fake indexer on 8799 (see each driver's header).
# verify-beta-posture joined the default set when it gained the DOM-level
# banner check for the user-raisable cap: a driver outside this list runs only
# when a human remembers, which is how every stale-test incident this repo has
# had got started.
SELF_CONTAINED=(verify-autolock-default verify-crosswire verify-wallet-mgmt verify-receive-index verify-receive-ui verify-send-amount verify-wallet-switch verify-oracle-refresh verify-beta-posture)
NEEDS_STACK=(verify-ui verify-receive-compat verify-txcap)

reap() {
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "remote-debugging-port=$CDP_PORT" >/dev/null 2>&1
    pkill -f "scripts/fake-indexer.mjs" >/dev/null 2>&1
    pkill -f "apps/wallet/server.js" >/dev/null 2>&1
  else
    # Git Bash on Windows ships no procps: reap by LISTENING PORT instead.
    # The stale headless Chrome squatting the CDP port is the killer — a new
    # Chrome cannot bind it, connectCdp() attaches to the OLD one, its reused
    # profile boots the vault into 'locked' instead of 'no wallet', and every
    # driver times out on its first wait. Ports only — never by process name,
    # which would also kill unrelated wallet servers (e.g. a dev preview).
    powershell -NoProfile -Command \
      "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @($CDP_PORT,8791,8799) -contains \$_.LocalPort } | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
  fi
  sleep 1
}

start_chrome() {
  local profile
  profile="$(mktemp -d)"
  "$CHROME" --headless=new --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$profile" --no-first-run --no-default-browser-check \
    --disable-gpu --no-sandbox about:blank >/tmp/chrome-ci.log 2>&1 &
  curl -sf --retry 40 --retry-delay 1 --retry-connrefused --max-time 3 \
    "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null
}

start_stack() {
  PORT=8799 node apps/wallet/scripts/fake-indexer.mjs >/tmp/fake-indexer-ci.log 2>&1 &
  PORT=8791 INDEXER_URL=http://127.0.0.1:8799 node apps/wallet/server.js >/tmp/wallet-ci.log 2>&1 &
  curl -sf --retry 30 --retry-delay 1 --retry-connrefused --max-time 3 \
    http://127.0.0.1:8791/api/config >/dev/null
}

explicit=1
requested=("$@")
if [ ${#requested[@]} -eq 0 ]; then
  explicit=0
  # The default set is filtered to what exists on THIS branch: a driver added
  # on a feature branch must not turn the default run red everywhere else.
  # A driver named explicitly is still an error when missing.
  requested=()
  for name in "${SELF_CONTAINED[@]}" "${NEEDS_STACK[@]}"; do
    [ -f "apps/wallet/scripts/${name}.mjs" ] && requested+=("$name")
  done
fi

failed=()
for name in "${requested[@]}"; do
  driver="apps/wallet/scripts/${name}.mjs"
  if [ ! -f "$driver" ]; then
    if [ "$explicit" = 1 ]; then echo "❌ $name — no such driver"; failed+=("$name"); fi
    continue
  fi
  echo "── $name"
  reap
  start_chrome || { echo "❌ $name — CDP never came up"; failed+=("$name"); continue; }
  for s in "${NEEDS_STACK[@]}"; do [ "$s" = "$name" ] && start_stack; done
  # drivers write screenshots to cwd; keep them out of the tree
  out="$(mktemp -d)"
  if (cd "$out" && node "$OLDPWD/$driver"); then echo "✅ $name"; else echo "❌ $name"; failed+=("$name"); fi
  rm -rf "$out"
done
reap

echo
if [ ${#failed[@]} -eq 0 ]; then
  echo "all drivers green (${#requested[@]})"
else
  echo "RED: ${failed[*]}"
  exit 1
fi
