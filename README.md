# zec-sealed-bid-auction

> Sealed-Bid Auction (Zcash) — portfolio

**Status: scaffold only — nothing built or deployed yet.** Spec: `grokbot/specs/zec-sealed-bid-auction.md`. Intended repo: `nickthelegend/zec-sealed-bid-auction` (not created).

## Packages
| Package | Role |
|---|---|
| [`packages/circuits`](./packages/circuits) | Circom Groth16 `MaxBid` circuit: given Poseidon commitments C_i (public) and openings (private, auctioneer), proves the declared winner commitment holds the max bid and bid ≥ reserve — losing bids never revealed |
| [`packages/service`](./packages/service) | Rust auctioneer: UIVK scan of deposits (memo = commitment), close, collect reveals, generate MaxBid proof, shielded settle + refunds |
| [`packages/sdk`](./packages/sdk) | TS/Rust bidder SDK: commitment, deposit, reveal |
| [`packages/mcp`](./packages/mcp) | MCP server: agent bidders (`list_auctions`, `bid`, `reveal`) — agentic procurement angle |
| [`packages/dashboard`](./packages/dashboard) | Create/bid/results; results page verifies the MaxBid proof in-browser (snarkjs) |
| [`packages/examples`](./packages/examples) | 3-bidder testnet e2e |
| [`packages/docs`](./packages/docs) | Protocol, what the auctioneer still learns, prior art (zkSNARKs ZEC auction) |
| [`packages/landing`](./packages/landing) | Landing |

## Live testnet deployment
_None yet._ Auction UA + public UIVK for the demo auction; table of deposit/settle/refund txids (Ironwood-only) and the MaxBid verification key hash.

## Run the whole thing
_To be written once packages exist._

## Tests — real testnet, no mocked clients
| Package | Network | What | Result |
|---|---|---|---|
| circuits | local | valid proof verifies; wrong winner / below reserve can't produce a witness | not run yet |
| service | live testnet | late, duplicate, altered, memo-mismatch bids rejected | not run yet |
| e2e | live testnet | 3 bidders, winner payout + 2 refunds, checked by viewing key | not run yet |
| dashboard | browser | proof verifies in-tab; tampered proof fails | not run yet |

MIT — Copyright (c) 2026 Nivesh Gajengi.
