# @sba/service (TypeScript)

The auctioneer's side, plus the scripts that ran and audit the live auction.

| File | What |
|---|---|
| `src/auction.ts` | rules: auction id, memo `sba1:<id>:<Poseidon commitment>`, deposits classified in chain order (valid, late, wrong_amount, memo_mismatch, duplicate, pending), reveals checked (altered, bid over deposit), the MaxBid proof, valid deposits never revealed (`unrevealed`), the settlement payouts (60,000 zat fee budget), and `checkOutcome` (proof + `checkResult`) |
| `src/zingo.ts` | zingo-cli wrapper (testnet, `--waitsync`); never calls `recovery_info` |
| `src/verifier.ts` | bridge to `sba-verify`: decrypt with an incoming viewing key, scan a block range for every payment to that key, chain tip, block header times |
| `src/testnet-run.ts` | the resumable live auction (`pnpm --filter @sba/service testnet-run`) |
| `src/audit.ts` | re-checks a published auction from the chain (`pnpm --filter @sba/service audit`): scans the auction's blocks so a deposit left out of the record is caught, re-applies the rules, and checks the outcome |

Env: `SBA_ZINGO_CLI`, `SBA_LWD_URL`, `SBA_VERIFY_BIN`, `SBA_AUDIT_UIVK` (see the root `.env.example`).
Tests (`pnpm test`, 8): the rules above with real Poseidon commitments and real proofs (6), and the audit script against live testnet (2: the published auction passes; a record hiding the late deposit fails).
