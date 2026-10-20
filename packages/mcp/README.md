# @sba/mcp — `sba-mcp`

For agent bidders. Env: `SBA_AUCTION_FILE` (published auction JSON), `SBA_BIDDER_WALLET`
(zingo-cli data dir, for `bid`), `SBA_BIDDER_DIR` (where openings are kept). Missing values come
back as `Setup required: <VAR>`.

| Tool | What |
|---|---|
| `auction_status()` | deposits read live with the auction's incoming viewing key, with their status; no bid is visible |
| `bid(bid_zat, refund_address)` | commits with a fresh salt and sends the fixed deposit with the commitment memo; refuses out-of-range bids before sending; saves the opening |
| `verify_result()` | verifies the MaxBid proof and that its commitments are exactly the valid on-chain memos |

Tests: 4, a real MCP client against live testnet (no deposit sent by the tests).
