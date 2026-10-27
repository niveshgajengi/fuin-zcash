#!/usr/bin/env bash
# Starts the Fuin node (the local API behind the app) with the settings in .env, if there is one.
#   pnpm fuin     ->  http://127.0.0.1:5179/api ; then: pnpm --filter @sba/app dev  ->  http://localhost:5180
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$root/.env" ]; then set -a; . "$root/.env"; set +a; fi
exec "$root/packages/node/node_modules/.bin/tsx" "$root/packages/node/src/server.ts"
