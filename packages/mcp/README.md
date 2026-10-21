# @sba/mcp — `sba-mcp`

For agent bidders. Env: `SBA_AUCTION_FILE` (published auction JSON), `SBA_BIDDER_WALLET`
(zingo-cli data dir, for `bid`), `SBA_BIDDER_DIR` (where openings are kept). Missing values come
back as `Setup required: <VAR>`.

| Tool | What |
|---|---|
| `auction_status()` | every deposit, found by scanning the auction's blocks with its incoming viewing key, with its status, and any the published record leaves out; no bid is visible |
| `bid(bid_zat, refund_address)` | commits with a fresh salt and sends the fixed deposit with the commitment memo; refuses out-of-range bids and closed auctions (live chain tip) before sending; saves the opening |
| `verify_result()` | verifies the MaxBid proof and that it is about exactly the on-chain deposits: proven slots are the valid deposits in chain order (minus any declared unrevealed), spare slots are empty, the winner is a real deposit, and the record lists every deposit |

Tests: 5, a real MCP client against live testnet (no deposit sent by the tests).
