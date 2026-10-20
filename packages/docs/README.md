# Fuin — protocol and threat model

## Roles

- **Auctioneer:** holds the auction wallet (a shielded Zcash testnet address), publishes the auction
  card (id, address, incoming viewing key, deposit size, reserve, close height), collects reveals,
  proves the result and settles.
- **Bidders:** each has a shielded wallet.
- **Seller:** receives the winning bid.
- **Anyone:** can audit with the auction's incoming viewing key (UIVK) and the published proof.

## Steps

1. **Commit.** A bidder picks a bid `b` (zatoshi) and a random 248-bit salt `s`, and computes
   `C = Poseidon(auction_id, b, s)` over BN254.
2. **Deposit.** It sends exactly the auction's deposit (0.02 TAZ in the live run) to the auction
   address in a shielded transaction with memo `sba1:<auction_id>:<C>`. Every deposit is the same
   size, so neither the chain nor the auctioneer learns the bid from it.
3. **Close.** Deposits mined after the close height are late.
4. **Reveal.** After the close, each bidder privately sends `(b, s, refund address)` to the
   auctioneer. Knowing an opening of `C` is what authenticates the bidder.
5. **Prove.** The auctioneer orders the valid, revealed deposits by height (then txid) and proves
   with `MaxBid(8)` that the bid in slot `w` is the highest (earliest wins ties) and ≥ the reserve.
   Public: auction id, reserve, the commitments, `w`, and the winning bid. Private: every other bid
   and every salt.
6. **Settle.** One shielded transaction pays the seller the winning bid. It refunds every other
   revealed deposit in full: losing bids, duplicates, late and wrong-amount deposits. The winner gets
   its deposit back minus the bid and a fixed settlement-fee budget (60,000 zat).

## What each party learns

| Party | Learns | Does not learn |
|---|---|---|
| Public chain | that shielded transactions happened | amounts, memos, addresses (Ironwood-only, no transparent part) |
| Anyone with the auction UIVK | each deposit's amount (all equal) and commitment memo; the winning bid via the proof | any losing bid, any salt, who the bidders are |
| Auctioneer | every bid at reveal time, refund addresses | bids before the close (deposits are equal and memos are hashes) |
| A bidder | its own deposit and refund (with its own viewing key) | other bids |

The auctioneer is trusted to collect reveals honestly and to settle. If it withheld a reveal, that
bid could not be in the proof, so the bidder would hold the opening that proves a valid deposit was
left out. The project does not include a dispute flow for that, and this README does not claim one.

## Rules enforced by the service

Zcash has no smart contracts, so these are checked by the auction service. Every input the service
uses is reproducible from the chain with the published UIVK (`sba-verify`).

| Rule | Status |
|---|---|
| memo is not `sba1:<this auction>:<commitment>` | `memo_mismatch`: not a bid, not refunded (no reveal can claim it) |
| mined after the close height | `late`: refunded at settlement if revealed |
| amount ≠ deposit | `wrong_amount`: refunded if revealed |
| same commitment as an earlier deposit | `duplicate`: refunded if revealed |
| opening does not hash to any deposit's commitment | `altered`: refused |
| bid > deposit − fee budget | refused |
| highest valid bid < reserve | no sale |

## Trusted setup

`MaxBid` uses Groth16 with a **single-party local setup** (`packages/circuits/scripts/build.sh`).
Whoever ran it could forge proofs, so the proof convinces only to the extent that the setup is
trusted. A multi-party ceremony, or a transparent proof system, would remove that trust.

## Prior art

Sealed-bid auctions with zero-knowledge proofs are not new (for example the zkSNARK-based Zcash
auction designs discussed in the community, and many Ethereum commit-reveal auctions). What this
build does differently is run on Zcash's current shielded pool: equal-size shielded deposits whose
memos are the commitments, a public proof over exactly those memos, and settlement and refunds
checked with each recipient's incoming viewing key.
