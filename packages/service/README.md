# @sba/service (TypeScript)

The auctioneer's side, plus the scripts that ran and audit the live auction.

| File | What |
|---|---|
| `src/auction.ts` | rules: the auction id (`termsAuctionId`, a hash of every term on the card; `checkTerms` says bound, legacy or mismatch), memo `sba1:<id>:<Poseidon commitment>`, deposits classified in chain order (valid, late, wrong_amount, memo_mismatch incl. non-canonical commitments, duplicate, pending), the proof's 8 slots for the first 8 revealed valid deposits, reveals checked (altered, bid over deposit), the MaxBid proof, valid deposits never revealed (`unrevealed`), the settlement payouts (60,000 zat fee budget; non-bid and over-capacity refunds pay their own 5,000 zat output fee; `checkAffordable` checks the ZIP-317 fee fits; memos `seller`, `change:<deposit>`, `refund:<deposit>`, `forfeit:<deposit>`; unrevealed deposits to the seller), the no-sale settlement (nothing revealed, or the top bid below the reserve, proven with reserve 0), `checkOutcome` (proof + `checkResult`, or a no-sale), and the seller's payout check (`sellerOwed`, `checkSellerPayout`) |
| `src/reveal.ts` | the reveal channel: `sealReveal` (opening encrypted to the auction's X25519 reveal key, memo `sba1r:<id>:<deposit>:<sealed>`), `ingestReveals` (the auctioneer reads openings from reveal notes on chain: window, tampered, wrong commitment, duplicate, conflicting), `auditReveals` (what the viewing key alone can check) |
| `src/dispute.ts` | complaints: `signComplaint`, the on-chain anchor `sba1d:<id>:<sha256>`, `checkComplaint` (rejected / unfounded / upheld, naming the failure; pays count only outputs whose memo names the opening's deposits), `checkSharedRefundKeys` (legacy settlements: complaints sharing a refund key are summed) |
| `src/zingo.ts` | zingo-cli wrapper (testnet, `--waitsync`); never calls `recovery_info` |
| `src/verifier.ts` | bridge to `sba-verify`: decrypt with an incoming viewing key, scan a block range for every payment to that key (split into 5,000-block windows), chain tip, block header times, address ownership; `asDeposits` reads every payment in a transaction as its own deposit |
| `src/testnet-run.ts` | the first live auction (`pnpm --filter @sba/service testnet-run`), from before the reveal channel: one script held every opening |
| `src/audit.ts` | re-checks a published auction from the chain (`pnpm --filter @sba/service run audit [record] [complaint.json...]`): reads the settlement's height from the chain, checks the terms, scans the auction's blocks up to that height so a deposit or reveal left out of the record is caught, re-applies the rules, checks the reveal log and the outcome, and checks complaints; notes mined after the record's `scannedTo` are reported, not failed; with `SBA_SELLER_UIVK` it checks the seller's payout, otherwise it ends "chain checks pass; payments not checked" |

Env: `SBA_ZINGO_CLI`, `SBA_LWD_URL`, `SBA_VERIFY_BIN`, `SBA_SELLER_UIVK`, `SBA_AUDIT_UIVK` (see the root `.env.example`).
Tests (`pnpm test`, 54; the audit tests read live testnet and take about 7 minutes): the rules with
real Poseidon commitments and real proofs (`auction`, 20: classification, canonical commitments,
payouts and their memos, no sale below the reserve or with nothing revealed, ties by txid, capacity over
revealed bids and the 8-junk-deposit squatter, forfeits to the seller, the ZIP-317 fee, two payments in
one transaction, terms bound to the id, the seller's payout check), scan windows (`verifier`, 2), the
reveal channel with real ciphertexts (`reveal`, 8), complaints with real signatures (`dispute`, 12), and
the audit script against live testnet (`audit`, 12: Sales 001, 002 and 003 pass; hidden deposits,
understated heights, renamed auctions, hidden or relabelled reveals fail; a note after `scannedTo`
is a note; an unrelated settlement no longer ends "all checks pass"; with the local demo seller key
the seller's payouts are checked; the winners' complaints).
