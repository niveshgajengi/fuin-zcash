#!/usr/bin/env bash
# Starts the Fuin stack the way a user runs it, bound to 127.0.0.1, and records every PID in .run/pids.
#   ./stack.sh        build the dashboard, serve the landing (4180) and the saleroom (4178)
#   ./stack.sh stop   kill exactly the PIDs this script started
# There is no chain to start: both sales are on Zcash testnet and both pages read the published
# records in deployments/. The live chain is re-read by `pnpm --filter @sba/service audit`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
run="$here/.run"
mkdir -p "$run"

if [ "${1:-}" = "stop" ]; then
  [ -f "$run/pids" ] || { echo "no stack running"; exit 0; }
  while read -r name pid; do
    if kill "$pid" 2>/dev/null; then echo "stopped $name ($pid)"; fi
  done < "$run/pids"
  rm -f "$run/pids"
  exit 0
fi

[ -f "$run/pids" ] && { echo "stack already running (see $run/pids); ./stack.sh stop first" >&2; exit 1; }

(cd "$root" && pnpm --filter @sba/dashboard build >"$run/dashboard-build.log" 2>&1) || { echo "dashboard build failed: $run/dashboard-build.log" >&2; exit 1; }

python3 -m http.server 4180 --bind 127.0.0.1 -d "$root/packages/landing" >"$run/landing.log" 2>&1 &
echo "landing $!" >>"$run/pids"
(cd "$root/packages/dashboard" && exec ./node_modules/.bin/vite preview --host 127.0.0.1 --port 4178 --strictPort) >"$run/dashboard.log" 2>&1 &
echo "dashboard $!" >>"$run/pids"

for url in http://127.0.0.1:4180/ http://127.0.0.1:4178/; do
  for _ in $(seq 1 50); do curl -fsS -o /dev/null "$url" 2>/dev/null && break; sleep 0.2; done
  curl -fsS -o /dev/null "$url" || { echo "not up: $url" >&2; exit 1; }
done
cat "$run/pids"
