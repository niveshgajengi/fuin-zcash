# @sba/dashboard

The Fuin saleroom: Vite + React results page for both published auctions. Sale 002
(`deployments/testnet-reveal.json`, the reveal channel) opens by default; the tabs, or `?sale=001`,
switch the whole page to Sale 001 (`deployments/testnet.json`).

- **Sale header:** the hammer price (the only bid ever published), a live clock since the settlement
  block's header time, and the open / close / hammer blocks with their UTC times from lightwalletd.
- **The lots:** every deposit as a catalogue card in chain order, filterable (sealed, opened, refused).
  Sealed bids show an envelope and no amount; the winner's envelope is open; refused deposits say why.
- **Verify in this tab (either sale):** hashes the verification key it fetched and compares it with the record,
  verifies the MaxBid Groth16 proof with snarkjs, and runs the same `checkResult` as the audit and
  the MCP server (Poseidon in the browser): the proof's slots are exactly the valid deposits, spare
  slots are empty, the winner is a real deposit. Two tamper buttons (claim 1 zat more, slip a phantom
  commitment into an empty slot) show which checks catch each.
- **Provenance:** what each recipient decrypted from the settlement with its own viewing key.
- **Sale 002 · the reveal channel:** every reveal note on chain with its block, the deposit it opens
  and its status (accepted, wrong deposit, late), the reveal window, the two-payment deposit, the
  deposits never revealed, and the recipient checks. It shows no opening: the notes are sealed. The
  winner's complaint: its digest computed in the tab (the e2e suite checks it equals the anchor memo
  on chain), the anchor transaction, the audit's verdict, and the wallet-wide key it disclosed.
- **Audit:** how to re-read it from the chain (including reveal logs and complaints), and the
  auction's incoming viewing key.

This page checks the record against itself; only `pnpm --filter @sba/service run audit` re-reads the
deposits from the chain.

`pnpm --filter @sba/dashboard dev` → http://localhost:5178. The build uses `base: './'` and fetches
`verification_key.json` next to the page, so it works under a subpath (`/saleroom/` in `pnpm
build:site` and on GitHub Pages). `e2e/tests/saleroom.spec.ts` (19 tests per viewport, Google Chrome,
1280 and 375 px) checks all of it on both sales.
