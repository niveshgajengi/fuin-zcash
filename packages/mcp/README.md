# @sba/mcp — `sba-mcp`

For agent bidders. Env: `SBA_AUCTION_FILE` (published auction JSON), `SBA_BIDDER_WALLET`
(zingo-cli data dir, for `bid`), `SBA_BIDDER_DIR` (where openings are kept), and optionally
`SBA_REFUND_WALLET` (a refunds-only wallet whose viewing key `complain` may publish; bid with a refund
address from it). Missing values come back as `Setup required: <VAR>`.

| Tool | What |
|---|---|
| `auction_status()` | every deposit, found by scanning the auction's blocks with its incoming viewing key, with its status, and any the published record leaves out; no bid is visible |
| `bid(bid_zat, refund_address)` | commits with a fresh salt and sends the fixed deposit with the commitment memo. Before any wallet call it refuses out-of-range bids, a refund address longer than a reveal holds (150 characters: an Orchard-only unified address; one with a Sapling or transparent receiver is 182 or 217 and could never be revealed or refunded), closed auctions (live chain tip) and cards whose id is not the hash of their terms. It saves the opening and a fresh complaint key (mode 0600) **before** sending; if the send fails the file stays, marked "send failed, may still be mined" |
| `reveal()` | in the reveal window, sends each saved opening to the auction address as a 1-zat note whose memo is sealed to the auction's reveal key; keeps the reveal's ephemeral secret; an opening whose send reported no txid is looked up on chain by its commitment (and left unrevealed if no deposit carries it); refuses before the close or after the window, before any wallet call |
| `complain({ include_refund_key? })` | in the dispute window, writes a signed complaint for each revealed opening (its reveal secret) and anchors its digest on chain; the audit gives the verdict. Publishes this bidder's own opening. By default no viewing key is published, so the audit does not check the payment. With `include_refund_key` it adds the incoming viewing key of `SBA_REFUND_WALLET`, which makes every payment to that wallet, past and future, readable by anyone; the bidding wallet is refused |
| `verify_result()` | verifies the MaxBid proof and that it is about exactly the on-chain deposits: proven slots are the valid deposits in chain order (minus any declared unrevealed), spare slots are empty, the winner is a real deposit, and the record lists every deposit |

`pnpm --filter @sba/mcp reveal-run` runs a live auction in which each bidder is its own `sba-mcp`
process with only its own wallet and openings folder, and the auctioneer learns the openings only from
the reveal notes on chain (record: `deployments/testnet-reveal.json`).

Tests: 7, a real MCP client against live testnet (no transaction is sent by the tests).
