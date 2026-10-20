# Testing zec-sealed-bid-auction

No mocks or stub RPCs. Proofs are real Groth16 proofs; chain reads go to lightwalletd
(testnet.zec.rocks) through `sba-verify`.

```sh
pnpm install && pnpm build && pnpm test
```

| Suite | What | Result |
|---|---|---|
| circuits | valid proof verifies and shows no losing bid; tampered winner / winning bid fails verification; no witness for a non-highest winner, a below-reserve bid, an altered opening, or a later slot claiming a tie | 6 passed |
| service | memo format; late, wrong-amount, memo-mismatch, other-auction, pending and duplicate deposits classified in chain order; altered and over-deposit reveals refused; winner, proof and payouts; no sale below the reserve | 5 passed |
| mcp | real MCP client, live testnet: statuses of the recorded deposits read with the auction viewing key; proof checked against the on-chain memos; bid refused before sending when out of range; Setup required messages | 4 passed |
| **total** | | **15 passed, 0 skipped** |

## Live testnet run (`pnpm --filter @sba/service testnet-run`)

Recorded in `deployments/testnet.json`; see the README tables. Each rule was exercised on-chain:
three valid bids, then a wrong amount, a memo mismatch, a duplicate and a late deposit, all
classified from the auction's incoming viewing key. An altered reveal was refused. One settlement
followed, with each of its 7 outputs checked by the recipient's own viewing key. The proof's
commitments matched the on-chain memos, and every transaction was Ironwood-only.

## Dashboard

Checked in a browser: the published proof verifies in the tab, the tampered claim (winning bid
+1 zat) fails, no horizontal overflow at 375 px.
