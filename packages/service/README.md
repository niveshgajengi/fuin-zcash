# @sba/service (TypeScript)

The auctioneer's side, plus the scripts that ran and audit the live auction.

| File | What |
|---|---|
| `src/auction.ts` | rules: the auction id (`termsAuctionId`, a hash of every term on the card; `checkTerms` says bound, legacy or mismatch), memo `sba1:<id>:<Poseidon commitment>`, deposits classified in chain order (valid, late, wrong_amount, memo_mismatch, duplicate, pending, over_capacity after 8 valid), reveals checked (altered, bid over deposit), the MaxBid proof, valid deposits never revealed (`unrevealed`), the settlement payouts (60,000 zat fee budget; memos `seller`, `change:<deposit>`, `refund:<deposit>`, `forfeit:<deposit>`; unrevealed deposits to the seller), and `checkOutcome` (proof + `checkResult`) |
| `src/reveal.ts` | the reveal channel: `sealReveal` (opening encrypted to the auction's X25519 reveal key, memo `sba1r:<id>:<deposit>:<sealed>`), `ingestReveals` (the auctioneer reads openings from reveal notes on chain: window, tampered, wrong commitment, duplicate, conflicting), `auditReveals` (what the viewing key alone can check) |
| `src/dispute.ts` | complaints: `signComplaint`, the on-chain anchor `sba1d:<id>:<sha256>`, `checkComplaint` (rejected / unfounded / upheld, naming the failure; pays count only outputs whose memo names the opening's deposits), `checkSharedRefundKeys` (legacy settlements: complaints sharing a refund key are summed) |
| `src/zingo.ts` | zingo-cli wrapper (testnet, `--waitsync`); never calls `recovery_info` |
| `src/verifier.ts` | bridge to `sba-verify`: decrypt with an incoming viewing key, scan a block range for every payment to that key, chain tip, block header times, address ownership; `asDeposits` reads every payment in a transaction as its own deposit |
| `src/testnet-run.ts` | the first live auction (`pnpm --filter @sba/service testnet-run`), from before the reveal channel: one script held every opening |
| `src/audit.ts` | re-checks a published auction from the chain (`pnpm --filter @sba/service run audit [record] [complaint.json...]`): reads the settlement's height from the chain, checks the terms, scans the auction's blocks up to that height so a deposit or reveal left out of the record is caught, re-applies the rules, checks the reveal log and the outcome, and checks complaints |

Env: `SBA_ZINGO_CLI`, `SBA_LWD_URL`, `SBA_VERIFY_BIN`, `SBA_AUDIT_UIVK` (see the root `.env.example`).
Tests (`pnpm test`, 38): the rules with real Poseidon commitments and real proofs (13: classification,
payouts and their memos, ties by txid, the 8-bid capacity, forfeits to the seller, two payments in one
transaction, terms bound to the id), the reveal channel with real ciphertexts (8), complaints with real
signatures (10, incl. one paid deposit masking an unpaid one, legacy memos summed per refund key, a
complaint without a refund key), and the audit script against live testnet (7: Sale 001 passes, a record
hiding a deposit fails, one understating the settlement height fails; Sale 002 passes, a renamed
auction fails the terms check, a hidden or relabelled reveal fails, and the winner's complaint is
unfounded on the real record and fails against records naming other settlements).
