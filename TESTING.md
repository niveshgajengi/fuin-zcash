# Testing Fuin (zec-sealed-bid-auction)

No mocks or stub RPCs. Proofs are real Groth16 proofs; chain reads go to lightwalletd
(testnet.zec.rocks) through `sba-verify`.

```sh
pnpm install && pnpm build && pnpm test
```

`pnpm test` builds `sba-verify` and the circuits and service packages first, so it passes on a fresh
clone. Last run: 21 Oct 2026, this machine.

| Suite | Network | What | Result |
|---|---|---|---|
| verifier (Rust) | none | memo decoding (text, empty, binary flagged), txid parsing, scan range bounds | 4 passed |
| circuits `maxbid` | local | valid proof verifies and shows no losing bid; tampered winner / winning bid fails verification; no witness for a non-highest winner, a below-reserve bid, an altered opening, or a later slot claiming a tie | 6 passed |
| circuits `result` | local | `checkResult`: the honest result passes; a phantom winning bid in a spare slot verifies as a proof but is rejected (the old prefix-only check passed it); a left-out deposit fails unless declared unrevealed, and only valid deposits can be declared; another auction or reserve fails | 4 passed |
| service `auction` | local | memo format; late, wrong-amount, memo-mismatch, other-auction, pending and duplicate deposits classified in chain order; altered and over-deposit reveals refused; winner, proof and payouts; no sale below the reserve; a valid deposit with no reveal is declared unrevealed and the outcome still passes, hiding it fails | 6 passed |
| service `audit` | live testnet | the audit scans blocks 4,522,258–4,522,291 and passes on the published record; a record that hides the late deposit (owed a refund) fails with `NOT LISTED` (the old audit passed it) | 2 passed |
| mcp | live testnet | real MCP client: tools listed; `auction_status` finds the recorded deposits by scanning, none missing from the record; `verify_result` holds on the record; `bid` refuses out-of-range bids and names missing settings; `bid` refuses the closed live auction before any wallet call | 5 passed |
| **total** | | | **27 passed, 0 skipped** |

## Live testnet run (`pnpm --filter @sba/service testnet-run`)

Recorded in `deployments/testnet.json`; see the README tables. Each rule was exercised on-chain:
three valid bids, then a wrong amount, a memo mismatch, a duplicate and a late deposit, all
classified from the auction's incoming viewing key. An altered reveal was refused. One settlement
followed, with each of its 7 outputs checked by the recipient's own viewing key. Every transaction
was Ironwood-only. The run was recorded at `58c2393`; the record later gained `openHeight`,
`outcome.unrevealed` (`[]`) and `blockTimes`, read from the chain, which the scanning audit needs.

## Audit (`pnpm --filter @sba/service audit`)

Scans the auction's blocks (open height to settlement) with only the auction's incoming viewing key,
so the deposit list comes from the chain, not from the record. Fails if a deposit on chain is not in
the record or the other way round. Re-classifies every deposit, verifies the MaxBid proof and runs
`checkResult`, and checks every transaction is Ironwood-only. With `SBA_AUDIT_UIVK` set to a
recipient's key it also decrypts that recipient's settlement outputs. Prints `all checks pass` or
the failures.

## Dashboard and landing (browser)

Checked on 21 Oct 2026 with headless Chrome at 1280 and 375 px. Neither page scrolls horizontally.
In the dashboard, all four in-tab checks pass on the record (vk sha256 matches, proof verifies,
slots are exactly the deposits, winner is a deposit). "Claim 1 zat more" fails the proof check.
"Slip in a phantom bid" fails both the proof and the slot check. The lot filters work. There were no
console errors. Screenshots: `grokbot/shots/fuin/`.
