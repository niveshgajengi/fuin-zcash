# Sealed-Bid Auction on Zcash — submission draft (portfolio; Zecathon's one entry is Shielded x402)

Not entered in Zecathon (one entry per team). Written Oct 20, 2026.

## Short overview
Sealed bids as equal-size shielded Zcash deposits whose memos are Poseidon commitments; a Groth16
MaxBid proof opens only the winning bid; one shielded settlement pays the seller and refunds everyone
else, each output checked by the recipient's own viewing key. Live on Zcash testnet.

## What is live (testnet)
Auction `sba-testnet-2026-10-20T13:30`: 3 valid sealed bids (06d12181…, 3d104727…, d910ebad…);
rejected: wrong amount 29c23b7d…, memo mismatch 76b0b9bb…, duplicate c1b89ecd…, late c2e20a26…;
altered reveal refused; settlement 89bf60fd… (7 outputs, all viewing-key checks match);
Ironwood-only throughout. Proof and auction incoming viewing key in deployments/testnet.json.

## Honest scope
Auctioneer learns bids at reveal and is trusted to settle; rules are enforced by the service
(Zcash has no contracts) but re-checkable with the published key; single-party Groth16 setup;
prior art exists.

## Test coverage
15 tests (circuits 6, service 5, mcp 4). See TESTING.md.

## Links
Repo: https://github.com/nickthelegend/zec-sealed-bid-auction (Nick creates it) · video: `grokbot/videos/zec-sealed-bid-audit.mp4` (16 s, unedited asciinema recording of a live audit of the run at `58c2393`; captions marked ###; idle gaps shortened).
