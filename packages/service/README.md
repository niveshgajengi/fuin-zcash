# @sba/service (TypeScript)

The auctioneer's side, plus the scripts that ran and audit the live auction.

| File | What |
|---|---|
| `src/auction.ts` | rules: auction id, memo `sba1:<id>:<Poseidon commitment>`, deposits classified in chain order (valid, late, wrong_amount, memo_mismatch, duplicate, pending), reveals checked (altered, bid over deposit), the MaxBid proof and the settlement payouts (60,000 zat fee budget) |
| `src/zingo.ts` | zingo-cli wrapper (testnet, `--waitsync`); never calls `recovery_info` |
| `src/verifier.ts` | bridge to `sba-verify` (decrypt with an incoming viewing key) |
| `src/testnet-run.ts` | the resumable live auction (`pnpm --filter @sba/service testnet-run`) |
| `src/audit.ts` | re-checks a published auction from the chain (`pnpm --filter @sba/service audit`) |

Env: `SBA_ZINGO_CLI`, `SBA_LWD_URL`, `SBA_VERIFY_BIN`, `SBA_AUDIT_UIVK` (see the root `.env.example`).
Tests (`pnpm test`, 5): the rules above with real Poseidon commitments and real proofs.
