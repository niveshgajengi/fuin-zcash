# Fuin — sealed-bid auctions on Zcash — submission draft (portfolio; Zecathon's one entry is Shielded x402)

Not entered in Zecathon (one entry per team). Written Oct 20, 2026; updated Oct 21, 2026 after the
judge review in `docs/JUDGE-2026-10-21.md`, Oct 22, 2026 for the reveal channel, disputes and
multi-payment deposits, and Oct 22 again for the second judge round (bound terms, chain-read
settlement height, per-deposit settlement memos, opt-in refund keys, capacity, forfeits, the Sale 002
landing and saleroom, hosting).

## Short overview
Sealed bids as equal-size shielded Zcash deposits whose memos are Poseidon commitments. A Groth16
MaxBid proof opens only the winning bid. Bidders reveal through the chain: a second shielded note
whose memo is the opening sealed to the auctioneer's key, so the window is enforced by block height
and a dropped reveal is visible and provable in a signed, on-chain-anchored complaint. One shielded
settlement pays the seller and refunds every other revealed deposit, each output checked by the
recipient's own viewing key. Anyone with the auction's incoming viewing key reads the settlement height
from the chain, scans the auction's blocks and checks that the proof covers exactly those deposits.
In Sale 002 the three bidders were independent MCP agents (`sba-mcp`). Live on Zcash testnet.

## What is new
Sealed-bid ZK auctions exist (zkSNARKs' blind-bid ZEC auction, September 2026, settled through NEAR
Intents; Ethereum commit-reveal auctions). Fuin's differences: equal shielded deposits whose memos are
the proof's public inputs; reveals sealed inside shielded memos, so the chain timestamps them and a
dropped one is visible; signed complaints anchored on chain, and an audit with only the viewing key
that proves the record is complete. Sources: packages/docs/README.md#prior-art.

## What is live (testnet)
Sale 002 (reveal channel, MCP agent bidders), auction `fuin-reveal-2026-10-21T18:43`, blocks
4,526,425–4,526,493: three bidders as separate `sba-mcp` processes; reveals 332fbc3c…, 07ec9dcd…,
80428975… accepted, ca315a6c… (another bidder's deposit) wrong_commitment, 64de2707… late; a
two-payment deposit 9bb4098e… (valid + duplicate, both refunded); one deposit never revealed
(19029d77…, listed unrevealed); settlement e84de386… (5 outputs, all viewing-key checks match); the
winner's complaint, anchored at f17193d5… (block 4,526,500), is unfounded and paid in full. Record:
deployments/testnet-reveal.json.

Sale 001 (before the reveal channel), auction `sba-testnet-2026-10-20T13:30`, blocks
4,522,258–4,522,278. 3 valid sealed bids (06d12181…, 3d104727…, d910ebad…). Rejected: wrong amount
29c23b7d…, memo mismatch 76b0b9bb…, duplicate c1b89ecd…, late c2e20a26…. The altered reveal was
refused. Settlement 89bf60fd… (block 4,522,291, 7 outputs, all viewing-key checks match).
Ironwood-only throughout. Record: deployments/testnet.json.

## Honest scope
- The auctioneer learns bids at the reveal and is trusted to settle. Both live sales predate bound
  terms (the audit prints `! terms: legacy`): their close and reveal window come from the record.
- Sale 001 predates the reveal channel (one script held every opening); Sale 002 used it.
- Reveals cost one more shielded transaction per bidder; a complaint publishes the complainer's bid,
  and an opt-in refund key publishes every payment to that refund wallet. Sale 002's complaint was
  filed before that was opt-in and carries the winner's whole demo-wallet key.
- Sale 002's unrevealed deposit and an abandoned attempt's four payments (0.008 TAZ) stayed in the
  auction wallet; new settlements send unrevealed deposits to the seller.
- Same-block ties go to the lexically lower txid; at most 8 valid bids compete.
- Nothing forces the auctioneer to settle.
- The rules are enforced by the service (Zcash has no contracts), but they can be re-checked from the
  chain with the published key.
- Single-party Groth16 setup.

## Test coverage
69 unit and live tests, 0 skipped (verifier 6, circuits 10, service 38, mcp 15; the service audit and
mcp tests read live testnet), and 72 end-to-end tests in Google Chrome (36 per viewport: landing 17,
saleroom 19). See TESTING.md.

## Links
- Repo: https://github.com/nickthelegend/zec-sealed-bid-auction (not public yet: Nick creates it and
  pushes `main`).
- Landing: https://nickthelegend.github.io/zec-sealed-bid-auction/ and saleroom:
  https://nickthelegend.github.io/zec-sealed-bid-auction/saleroom/ (published by
  `.github/workflows/pages.yml` once the repo is public and Pages is set to GitHub Actions).
- Video: none current. The only recording, `zec-sealed-bid-audit.mp4` (16 s, asciinema, captions
  marked ###, shared separately), shows the audit of Sale 001 at `58c2393`, before the chain-scanning
  audit, the reveal channel and Sale 002. A 2-minute walkthrough is still to be recorded.
