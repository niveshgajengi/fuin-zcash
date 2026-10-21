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
4. **Reveal.** After the close, each bidder privately gives `(b, s, refund address)` to the
   auctioneer. Knowing an opening of `C` is what authenticates the bidder. No reveal channel is
   built: openings are handed over out of band, and in the live run one script played every bidder
   and the auctioneer.
5. **Prove.** The auctioneer orders the valid, revealed deposits by height (then txid) and proves
   with `MaxBid(8)` that the bid in slot `w` is the highest (earliest wins ties) and ≥ the reserve.
   Public: auction id, reserve, the commitments, `w`, and the winning bid. Private: every other bid
   and every salt. Valid deposits with no accepted reveal are left out of the proof and listed in
   the outcome as `unrevealed`.
6. **Tie the proof to the chain** (`checkResult`, run by the audit, the MCP server and the
   dashboard). The circuit accepts any eight commitments, so this check is what makes the proof about
   *this* auction: slots `0..n-1` are the revealed valid deposits in chain order, slots `n..7` are
   `Poseidon(auction_id, 0, 0)`, `w < n`, and only valid deposits can be listed as unrevealed. The
   audit finds the deposits by scanning the auction's blocks (`sba-verify scan`) with its UIVK, so
   it does not depend on the auctioneer's list.
7. **Settle.** One shielded transaction pays the seller the winning bid. It refunds every other
   revealed deposit in full: losing bids, duplicates, late and wrong-amount deposits. The winner gets
   its deposit back minus the bid and a fixed settlement-fee budget (60,000 zat).

## What each party learns

| Party | Learns | Does not learn |
|---|---|---|
| Public chain | that shielded transactions happened | amounts, memos, addresses (Ironwood-only, no transparent part) |
| Anyone with the auction UIVK | each deposit's amount (all equal) and commitment memo; the winning bid via the proof | any losing bid, any salt, who the bidders are |
| Auctioneer | every bid at reveal time, refund addresses | bids before the close (deposits are equal and memos are hashes) |
| A bidder | its own deposit and refund (with its own viewing key) | other bids |

The auctioneer is trusted to collect reveals honestly and to settle. It cannot put a phantom bid in
the proof, or leave a deposit out without listing it, without failing the audit. It can still
claim that a bidder never revealed. That deposit is then publicly listed as `unrevealed`, and the
bidder holds an opening that hashes to its memo, which is evidence the claim is false. The project
does not include a dispute flow, and this README does not claim one.

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
| valid deposit, no accepted reveal | `unrevealed`: left out of the proof, listed in the outcome, not refunded (no refund address) |
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
