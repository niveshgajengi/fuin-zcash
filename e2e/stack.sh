#!/usr/bin/env bash
# Builds the site exactly as it is hosted (scripts/build-site.sh: the landing at /, the built saleroom at
# /saleroom/) and serves it on 127.0.0.1:${FUIN_PORT:-4180}, recording the server's PID in .run/pids.
#   ./stack.sh        build and serve
#   ./stack.sh stop   kill exactly the PIDs this script started
# A port in use belongs to someone else: this script refuses it (set FUIN_PORT) and never stops a process
# it did not start. If the build or a readiness check fails, it stops what it started before exiting.
# There is no chain to start: both sales are on Zcash testnet and both pages read the published
# records in deployments/. The live chain is re-read by `pnpm --filter @sba/service run audit`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
run="$here/.run"
port="${FUIN_PORT:-4180}"
mkdir -p "$run"

stop_ours() {
  [ -f "$run/pids" ] || return 0
  while read -r name pid; do
    if kill "$pid" 2>/dev/null; then echo "stopped $name ($pid)"; fi
  done < "$run/pids"
  rm -f "$run/pids"
}

if [ "${1:-}" = "stop" ]; then
  [ -f "$run/pids" ] || { echo "no stack running"; exit 0; }
  stop_ours
  exit 0
fi

[ -f "$run/pids" ] && { echo "stack already running (see $run/pids); ./stack.sh stop first" >&2; exit 1; }
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $port is already in use by another process; set FUIN_PORT to a free port" >&2
  exit 1
fi

# From here on, any failure stops what this script started.
trap 'status=$?; if [ $status -ne 0 ]; then stop_ours; fi' EXIT

(cd "$root" && ./scripts/build-site.sh >"$run/site-build.log" 2>&1) || { echo "site build failed: $run/site-build.log" >&2; exit 1; }

python3 -m http.server "$port" --bind 127.0.0.1 -d "$root/site" >"$run/site.log" 2>&1 &
echo "site $!" >>"$run/pids"

for url in "http://127.0.0.1:$port/" "http://127.0.0.1:$port/saleroom/" "http://127.0.0.1:$port/saleroom/verification_key.json"; do
  for _ in $(seq 1 50); do curl -fsS -o /dev/null "$url" 2>/dev/null && break; sleep 0.2; done
  curl -fsS -o /dev/null "$url" || { echo "not up: $url (see $run/site.log)" >&2; exit 1; }
done
trap - EXIT
echo "landing   http://127.0.0.1:$port/"
echo "saleroom  http://127.0.0.1:$port/saleroom/"
cat "$run/pids"
