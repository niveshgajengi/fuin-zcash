#!/usr/bin/env bash
# Builds the static site exactly as it is hosted: the landing at /, the saleroom at /saleroom/.
#   pnpm build:site   ->  site/{index.html,evidence.html}, site/saleroom/{index.html,assets/,verification_key.json}
# GitHub Pages publishes site/ (.github/workflows/pages.yml); e2e/stack.sh serves it locally.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
pnpm --filter @sba/dashboard build
rm -rf site
mkdir -p site/saleroom
cp packages/landing/index.html packages/landing/evidence.html site/
cp -R packages/dashboard/dist/. site/saleroom/
touch site/.nojekyll
echo "site/ ready: $(find site -type f | wc -l | tr -d ' ') files"
