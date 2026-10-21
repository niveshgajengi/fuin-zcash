# @sba/dashboard

The Fuin saleroom: Vite + React results page for the published auction (`deployments/testnet.json`).

- **Sale header:** the hammer price (the only bid ever published), a live clock since the settlement
  block's header time, and the open / close / hammer blocks with their UTC times from lightwalletd.
- **The lots:** every deposit as a catalogue card in chain order, filterable (sealed, opened, refused).
  Sealed bids show an envelope and no amount; the winner's envelope is open; refused deposits say why.
- **Verify in this tab:** hashes the verification key it fetched and compares it with the record,
  verifies the MaxBid Groth16 proof with snarkjs, and runs the same `checkResult` as the audit and
  the MCP server (Poseidon in the browser): the proof's slots are exactly the valid deposits, spare
  slots are empty, the winner is a real deposit. Two tamper buttons (claim 1 zat more, slip a phantom
  commitment into an empty slot) show which checks catch each.
- **Provenance:** what each recipient decrypted from the settlement with its own viewing key.
- **Audit:** how to re-read it from the chain, and the auction's incoming viewing key.

This page checks the record against itself; only `pnpm --filter @sba/service audit` re-reads the
deposits from the chain.

`pnpm --filter @sba/dashboard dev` → http://localhost:5178. Checked in a browser at 1280 and 375 px:
all four checks pass on the record; each tamper fails the expected checks; no horizontal scroll.
