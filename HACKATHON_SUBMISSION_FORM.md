# Fuin — sealed-bid auctions on Zcash — submission draft (portfolio; Zecathon's one entry is Shielded x402)

Not entered in Zecathon (one entry per team). Written Oct 20, 2026; updated Oct 21, 2026 after the
judge review in `docs/JUDGE-2026-10-21.md`, and Oct 22, 2026 for the reveal channel, disputes and
multi-payment deposits.

## Short overview
Sealed bids as equal-size shielded Zcash deposits whose memos are Poseidon commitments. A Groth16
MaxBid proof opens only the winning bid. Bidders reveal through the chain: a second shielded note
whose memo is the opening sealed to the auctioneer's key, so the window is enforced by block height
and a dropped reveal is visible and provable in a signed, on-chain-anchored complaint. One shielded
settlement pays the seller and refunds every
other revealed deposit, each output checked by the recipient's own viewing key. Anyone with the
auction's incoming viewing key scans its blocks and checks that the proof covers exactly those
deposits. Live on Zcash testnet.

## What is live (testnet)
Auction `sba-testnet-2026-10-20T13:30`, blocks 4,522,258–4,522,278. 3 valid sealed bids (06d12181…,
3d104727…, d910ebad…). Rejected: wrong amount 29c23b7d…, memo mismatch 76b0b9bb…, duplicate c1b89ecd…,
late c2e20a26…. The altered reveal was refused. Settlement 89bf60fd… (block 4,522,291, 7 outputs, all
viewing-key checks match). Ironwood-only throughout. The proof and the auction's incoming viewing key
are in deployments/testnet.json.

Sale 002 (reveal channel), auction `fuin-reveal-2026-10-21T18:43`, blocks 4,526,425–4,526,493: three
bidders as separate MCP processes; reveals 332fbc3c…, 07ec9dcd…, 80428975… accepted, ca315a6c…
(another bidder's deposit) wrong_commitment, 64de2707… late; a two-payment deposit 9bb4098e… (valid +
duplicate, both refunded); one deposit never revealed (19029d77…, listed unrevealed); settlement
e84de386… (5 outputs, all viewing-key checks match); the winner's complaint, anchored at f17193d5…,
is unfounded. Record: deployments/testnet-reveal.json.

## Honest scope
- The auctioneer learns bids at the reveal and is trusted to settle.
- Sale 001 predates the reveal channel (one script held every opening); Sale 002 used it.
- Reveals cost one more shielded transaction per bidder; a complaint publishes the complainer's bid.
- Nothing forces the auctioneer to settle.
- The rules are enforced by the service (Zcash has no contracts), but they can be re-checked from the
  chain with the published key.
- Single-party Groth16 setup.
- Prior art exists.

## Test coverage
52 tests, 0 skipped (verifier 6, circuits 10, service 28, mcp 8; the service audit and mcp tests read
live testnet). See TESTING.md.

## Links
Repo: https://github.com/nickthelegend/zec-sealed-bid-auction (public before submission) · video:
`zec-sealed-bid-audit.mp4` (shared separately until hosted). It is a 16 s unedited asciinema
recording of a live audit of the run at `58c2393`, with captions marked ### and idle gaps shortened.
It predates the chain-scanning audit and the reveal channel, so it shows the earlier audit output.
