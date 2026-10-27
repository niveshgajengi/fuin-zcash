#!/usr/bin/env bash
# Builds the static site exactly as it is hosted:
#   /                the Fuin app (packages/app), read-only over the published records (no node)
#   /saleroom/       the saleroom (packages/dashboard)
#   /evidence.html   the full catalogue of the published sales
#   /classic/        the earlier one-screen landing with its own saleroom and evidence page
#   pnpm build:site   ->  site/
# GitHub Pages publishes site/ (.github/workflows/pages.yml); e2e/stack.sh serves it locally.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
pnpm --filter @sba/dashboard build
pnpm --filter @sba/app build
rm -rf site
mkdir -p site/saleroom site/classic/saleroom
cp -R packages/app/dist/. site/
cp packages/landing/evidence.html site/
cp -R packages/landing/assets site/assets
cp -R packages/dashboard/dist/. site/saleroom/
cp packages/landing/index.html packages/landing/evidence.html site/classic/
cp -R packages/landing/assets site/classic/assets
cp -R packages/dashboard/dist/. site/classic/saleroom/
touch site/.nojekyll
echo "site/ ready: $(find site -type f | wc -l | tr -d ' ') files"
