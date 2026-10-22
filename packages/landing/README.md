# landing

`index.html`: one static page, the catalogue for Sale 003 (the current rules: bound terms, a forfeit
to the seller, a complaint with no key; bid and revealed through MCP by three `sba-mcp` processes
driven by the `reveal-run` script) with Sales 002 and 001 below it. Its saleroom links are relative (`saleroom/`): `pnpm build:site`
puts this page at `site/index.html` and the built saleroom at `site/saleroom/`, which is how GitHub
Pages serves them and how `e2e/stack.sh` tests them. The audit log on the page is copied from a live
run; `e2e/tests/landing.spec.ts` re-runs the command it shows and checks every line.
