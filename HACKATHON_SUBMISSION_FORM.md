# Fuin — sealed-bid auctions on Zcash — submission draft (portfolio; Zecathon's one entry is Shielded x402)

Not entered in Zecathon (one entry per team). Written Oct 20, 2026; updated Oct 21, 2026 after the
judge review in `docs/JUDGE-2026-10-21.md`.

## Short overview
Sealed bids as equal-size shielded Zcash deposits whose memos are Poseidon commitments. A Groth16
MaxBid proof opens only the winning bid, and one shielded settlement pays the seller and refunds every
other revealed deposit, each output checked by the recipient's own viewing key. Anyone with the
auction's incoming viewing key scans its blocks and checks that the proof covers exactly those
deposits. Live on Zcash testnet.

## What is live (testnet)
Auction `sba-testnet-2026-10-20T13:30`, blocks 4,522,258–4,522,278. 3 valid sealed bids (06d12181…,
3d104727…, d910ebad…). Rejected: wrong amount 29c23b7d…, memo mismatch 76b0b9bb…, duplicate c1b89ecd…,
late c2e20a26…. The altered reveal was refused. Settlement 89bf60fd… (block 4,522,291, 7 outputs, all
viewing-key checks match). Ironwood-only throughout. The proof and the auction's incoming viewing key
are in deployments/testnet.json.

## Honest scope
- The auctioneer learns bids at the reveal and is trusted to settle.
- There is no reveal channel: in the live run one script played every bidder and the auctioneer.
- The rules are enforced by the service (Zcash has no contracts), but they can be re-checked from the
  chain with the published key.
- Single-party Groth16 setup.
- Prior art exists.

## Test coverage
27 tests, 0 skipped (verifier 4, circuits 10, service 8, mcp 5; the service audit and mcp tests read
live testnet). See TESTING.md.

## Links
Repo: https://github.com/nickthelegend/zec-sealed-bid-auction (public before submission) · video:
`zec-sealed-bid-audit.mp4` (shared separately until hosted). It is a 16 s unedited asciinema
recording of a live audit of the run at `58c2393`, with captions marked ### and idle gaps shortened.
It predates the chain-scanning audit, so it shows the earlier audit output.
