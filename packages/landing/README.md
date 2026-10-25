# landing

Two static pages, served side by side:

- `index.html`: the one-screen landing. The sealed-envelope reveal of Sale 003 (the proof opens only the
  winning bid), three steps, three numbers and what is live versus Setup required.
- `evidence.html`: the full catalogue, the landing before Oct 25. Sale 003 (the current rules: bound terms,
  a forfeit to the seller, a complaint with no key; bid and revealed through MCP by three `sba-mcp`
  processes driven by the `reveal-run` script) with Sales 002 and 001 below it, reveals, provenance,
  conditions of sale and the condition report.

Their saleroom links are relative (`saleroom/`): `pnpm build:site` puts both pages in `site/` and the built
saleroom at `site/saleroom/`, which is how GitHub Pages and Vercel serve them and how `e2e/stack.sh` tests
them. The audit log on the evidence page is copied from a live run; `e2e/tests/landing.spec.ts` re-runs the
command it shows and checks every line.
