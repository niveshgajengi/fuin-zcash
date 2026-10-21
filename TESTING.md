# Testing Fuin (zec-sealed-bid-auction)

No mocks or stub RPCs. Proofs are real Groth16 proofs; chain reads go to lightwalletd
(testnet.zec.rocks) through `sba-verify`.

```sh
pnpm install && pnpm build && pnpm test
```

`pnpm test` builds `sba-verify` and the circuits and service packages first, so it passes on a fresh
clone. Last run: 22 Oct 2026, this machine.

| Suite | Network | What | Result |
|---|---|---|---|
| verifier (Rust) | none | memo decoding (text, empty, binary flagged), txid parsing, scan range bounds; a real Ironwood bundle built in-process that pays the auction key twice and another key once (both payments read, each with its own action index); `owns` with in-process keys | 6 passed |
| circuits `maxbid` | local | valid proof verifies and shows no losing bid; tampered winner / winning bid fails verification; no witness for a non-highest winner, a below-reserve bid, an altered opening, or a later slot claiming a tie | 6 passed |
| circuits `result` | local | `checkResult`: the honest result passes; a phantom winning bid in a spare slot verifies as a proof but is rejected (the old prefix-only check passed it); a left-out deposit fails unless declared unrevealed, and only valid deposits can be declared; another auction or reserve fails | 4 passed |
| service `auction` | local | memo format; late, wrong-amount, memo-mismatch, other-auction, pending and duplicate deposits classified in chain order; altered and over-deposit reveals refused; winner, proof and payouts; no sale below the reserve; a valid deposit with no reveal is declared unrevealed and the outcome still passes, hiding it fails; a transaction paying the auction twice is two deposits (two bids both compete; a second payment of the same commitment is a refunded duplicate) | 8 passed |
| service `reveal` | local | real X25519/ChaCha20-Poly1305 reveals: fit one memo, carry no bid, salt or address in the clear, open only with the reveal key or the bidder's ephemeral secret; reveals ingested from on-chain-shaped notes decide the auction; **a reveal for another bidder's commitment is rejected** (`wrong_commitment`; moved ciphertext is `tampered`); **a tampered ciphertext is rejected** (and one sealed to another key); **a late reveal is rejected** (and early, pending; the last window block counts); **a duplicate reveal is idempotent** (same outcome, a conflicting opening cannot replace the first); malformed, other-auction and unknown-deposit reveals; `auditReveals` catches a hidden, relabelled or contradictory reveal log | 8 passed |
| service `dispute` | local | real Ed25519 complaints over real sealed reveals: honest loser and winner get "unfounded, paid in full"; upheld when a valid reveal is called tampered and its deposit declared unrevealed (both named), or when the refund address got less than owed (amount named); rejected when forged, altered after signing, opened with the wrong secret, naming another deposit, unanchored or anchored outside the window; a late reveal's complaint is unfounded | 7 passed |
| service `audit` | live testnet | Sale 001: the audit scans blocks 4,522,258–4,522,291 and passes; a record hiding the late deposit fails with `NOT LISTED`. Sale 002: passes, reading the two-payment transaction as `valid` + `duplicate` and the 5 reveal notes as listed; a record hiding the wrong-commitment reveal, or calling the late reveal tampered, fails; the winner's on-chain-anchored complaint is unfounded (paid 5,000 of 5,000) and upheld, naming the shortfall, against a record that names another transaction as the settlement | 5 passed |
| mcp | live testnet | real MCP client: tools listed; `auction_status` finds the recorded deposits by scanning, none missing from the record; `verify_result` holds on the record; `bid` refuses out-of-range bids and names missing settings; `bid` refuses the closed live auction before any wallet call; `reveal` refuses an auction with no channel, before the close and after the window; `complain` refuses an auction with no dispute window and after the window; `verify_result` holds on Sale 002 and `auction_status` reads its two-payment transaction per payment | 8 passed |
| **total** | | | **52 passed, 0 skipped** |

## Live testnet run, Sale 001 (`pnpm --filter @sba/service testnet-run`)

Recorded in `deployments/testnet.json`; see the README tables. Each rule was exercised on-chain:
three valid bids, then a wrong amount, a memo mismatch, a duplicate and a late deposit, all
classified from the auction's incoming viewing key. An altered reveal was refused. One settlement
followed, with each of its 7 outputs checked by the recipient's own viewing key. Every transaction
was Ironwood-only. The run was recorded at `58c2393`; the record later gained `openHeight`,
`outcome.unrevealed` (`[]`) and `blockTimes`, read from the chain, which the scanning audit needs.

## Live testnet run, Sale 002 (`pnpm --filter @sba/mcp reveal-run`)

Recorded in `deployments/testnet-reveal.json`; see the README tables. Each bidder ran as its own
`sba-mcp` process (own wallet, own openings folder) and bid and revealed through the MCP tools. The
auctioneer read every opening from the sealed reveal notes on chain. Exercised on chain: a
transaction paying the auction twice (valid + duplicate, both refunded), a reveal pointed at another
bidder's deposit (`wrong_commitment`), a late reveal, a never-revealed deposit (`unrevealed`), and
the winner's complaint (unfounded). Settlement: 5 outputs, each matched by its recipient's key; every
transaction Ironwood-only. A first attempt was abandoned when lightwalletd transmission failures
held its deposits past its close; its four payments show up in Sale 002 as memo mismatches.

## Audit (`pnpm --filter @sba/service audit [record] [complaint.json ...]`)

Scans the auction's blocks (open height to settlement) with only the auction's incoming viewing key,
so the deposit list comes from the chain, not from the record. Fails if a deposit on chain is not in
the record or the other way round. Re-classifies every deposit, verifies the MaxBid proof and runs
`checkResult`, and checks every transaction is Ironwood-only. With `SBA_AUDIT_UIVK` set to a
recipient's key it also decrypts that recipient's settlement outputs. Prints `all checks pass` or
the failures. On an auction with the reveal channel it also scans for reveal notes and checks the
record's reveal log (every note listed; every status the chain decides is right; no accepted reveal's
deposit declared unrevealed). Each complaint file is checked against the chain (anchor in the dispute
window, the reveal it opens, its signature, the record, and the settlement read with the refund
address's key); an upheld complaint is a failure that names what went wrong.

## Dashboard and landing (browser)

Checked on 21 Oct 2026 with headless Chrome at 1280 and 375 px. On 22 Oct the Sale 002 section was
checked at 1280 px (headless Chrome) and 375 px (browser pane): no horizontal scroll on the dashboard or
the landing. Neither page scrolls horizontally.
In the dashboard, all four in-tab checks pass on the record (vk sha256 matches, proof verifies,
slots are exactly the deposits, winner is a deposit). "Claim 1 zat more" fails the proof check.
"Slip in a phantom bid" fails both the proof and the slot check. The lot filters work. There were no
console errors. Screenshots: `grokbot/shots/fuin/`.
