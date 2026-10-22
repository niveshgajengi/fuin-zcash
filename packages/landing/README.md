# landing

`index.html`: one static page, the catalogue for Sale 002 (the reveal channel, bid by three MCP
agents) with Sale 001 below it. Its saleroom links are relative (`saleroom/`): `pnpm build:site`
puts this page at `site/index.html` and the built saleroom at `site/saleroom/`, which is how GitHub
Pages serves them and how `e2e/stack.sh` tests them. The audit log on the page is copied from a live
run; `e2e/tests/landing.spec.ts` re-runs the command it shows and checks every line.
