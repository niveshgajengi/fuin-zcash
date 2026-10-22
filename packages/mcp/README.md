# @sba/mcp — `sba-mcp`

The bidder's MCP server, for any MCP client (in Sales 002 and 003 the `reveal-run` script drove three of them). Env: `SBA_AUCTION_FILE` (published auction JSON), `SBA_BIDDER_WALLET`
(zingo-cli data dir, for `bid`), `SBA_BIDDER_DIR` (where openings are kept), and optionally
`SBA_REFUND_WALLET` (a refunds-only wallet whose viewing key `complain` may publish; bid with a refund
address from it). Missing values come back as `Setup required: <VAR>`.

| Tool | What |
|---|---|
| `auction_status()` | every deposit, found by scanning the auction's blocks with its incoming viewing key, with its status, and any the published record leaves out; no bid is visible |
| `bid(bid_zat, refund_address)` | commits with a fresh salt and sends the fixed deposit with the commitment memo. Before any wallet call it refuses out-of-range bids, a refund address longer than a reveal holds (150 characters: an Orchard-only unified address; one with a Sapling or transparent receiver is 182 or 217 and could never be revealed or refunded), closed auctions (live chain tip), and cards whose id is not the hash of their terms. When 8 or more valid deposits are already on chain it still sends, with an advisory `capacity_note`: the proof's 8 slots go to the first 8 *revealed* valid deposits, so deposits nobody reveals take no slot. It saves the opening and a fresh complaint key (mode 0600) **before** sending; if the send fails the file stays, marked "send failed, may still be mined" |
| `reveal()` | in the reveal window, sends each saved opening to the auction address as a 1-zat note whose memo is sealed to the auction's reveal key; keeps the reveal's ephemeral secret; an opening whose send reported no txid is looked up on chain by its commitment (and left unrevealed if no deposit carries it); refuses before the close or after the window, before any wallet call |
| `complain({ include_refund_key? })` | in the dispute window, writes a signed complaint for each revealed opening (its reveal secret) and anchors its digest on chain; the audit gives the verdict. Publishes this bidder's own opening. By default no viewing key is published, so the audit does not check the payment. With `include_refund_key` it adds the incoming viewing key of `SBA_REFUND_WALLET`, which makes every payment to that wallet, past and future, readable by anyone; the bidding wallet is refused |
| `verify_result()` | verifies the MaxBid proof and that it is about exactly the on-chain deposits (scanned up to the settlement's height as mined, which must match the record): proven slots are the valid deposits in chain order (minus any declared unrevealed), spare slots are empty, the winner is a real deposit, and the record lists every deposit up to its `scannedTo` (later ones are reported in `deposits_after_the_record`, not failed); a no-sale result holds only when nothing valid was revealed or its reserve-0 proof shows the top bid is below the reserve |

`SBA_SALE=<nnn> pnpm --filter @sba/mcp reveal-run` runs a live auction in which each bidder is its own
`sba-mcp` process with only its own wallet and openings folder, driven over MCP by the script (it sets
the bid amounts; no language model chooses a bid), and the auctioneer learns the openings only from the
reveal notes on chain. Records: `deployments/testnet-reveal.json` (Sale 002, the default `SBA_SALE`)
and `deployments/testnet-sale003.json` (Sale 003, which also files the winner's complaint without a
refund key).

Tests: 17, a real MCP client against live testnet (no transaction is sent by the tests; two point
`SBA_ZINGO_CLI` at a path that does not exist to show what a failed send leaves behind).
