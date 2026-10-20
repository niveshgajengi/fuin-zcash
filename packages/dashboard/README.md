# @sba/dashboard

Vite + React results page for the published auction (`deployments/testnet.json`).

- Each deposit is drawn as a **sealed envelope** stamped with its commitment. Only the winner's opens,
  showing the winning bid; rejected deposits show why (wrong amount, memo mismatch, duplicate, late).
- **Verifies the MaxBid Groth16 proof in the tab** (snarkjs) with the circuit's verification key.
  "Try claiming a higher winning bid" changes one public signal and shows the proof failing.
- The settlement table: what each recipient decrypted with its own viewing key, against what was expected.
- How to audit it yourself, and the auction's incoming viewing key.

`pnpm --filter @sba/dashboard dev` → http://localhost:5178. Checked in a browser: the proof verifies,
the tampered claim fails, no horizontal overflow at 375 px.
