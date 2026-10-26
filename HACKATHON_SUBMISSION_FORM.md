# Fuin — sealed-bid auctions on Zcash — submission draft (portfolio; Zecathon's one entry is Shielded x402)

Not entered in Zecathon (one entry per team). Written Oct 20, 2026; updated Oct 21 (the proof tied
to the chain), Oct 22 (the reveal channel, disputes, bound terms, forfeits) and Oct 23 (no-sale
settlement, capacity over revealed bids, `scannedTo`, the seller's payout check, scaled fees, chunked
scans, canonical commitments, CI, and Sale 003 under the current rules). What changed, by date:
docs/CHANGELOG.md.

## Short overview
Sealed bids as equal-size shielded Zcash deposits whose memos are Poseidon commitments. A Groth16
MaxBid proof opens only the winning bid (a bidder who files a complaint publishes its own bid too).
Bidders reveal through the chain: a second shielded note whose memo is the opening sealed to the
auctioneer's key, so the window is enforced by block height and a dropped reveal is visible and
provable in a signed, on-chain-anchored complaint. One shielded settlement pays the seller and
refunds every other revealed deposit, each output checked by the recipient's own viewing key; a bid
nobody reveals goes to the seller, and a sale below the reserve refunds everyone. Anyone with the
auction's incoming viewing key reads the settlement height from the chain, scans the auction's blocks
and checks that the proof covers exactly those deposits. In Sales 002 and 003 each bidder was a
separate `sba-mcp` server process with only its own wallet, driven over MCP by the `reveal-run`
script (no language model chose a bid). Live on Zcash testnet.

## What is new
Sealed-bid ZK auctions exist (zkSNARKs' blind-bid ZEC auction, September 2026, settled through NEAR
Intents; Ethereum commit-reveal auctions). Fuin's differences: equal shielded deposits whose memos are
the proof's public inputs; reveals sealed inside shielded memos, so the chain timestamps them and a
dropped one is visible; signed complaints anchored on chain, and an audit with only the viewing key
(and the lightwalletd it reads) that shows the record is complete up to the auctioneer's scan.
Sources: packages/docs/README.md#prior-art.

## What is live (testnet)
Sale 003 (the current rules), auction `fuin-sale003-2026-10-22T21:24`, blocks 4,530,264–4,530,332:
its id hashes every term (the audit prints a bound `terms` line); bids 372e205c…, dc95f63d… (wins,
0.00135 TAZ), 37e5c2df…:1, a duplicate second payment 37e5c2df…:2 (refunded minus its output fee),
and 4462163e…, never revealed and forfeited to the seller (195,000 zat, memo `forfeit:<deposit>`);
reveals de23eaa8…, 6b695300…, 6e9e9cf9… accepted, 797e5467… wrong_commitment, a7688be1… late;
settlement 2aefb90d… (6 tagged outputs, all viewing-key checks match); the winner's complaint, filed
without a refund key and anchored at 3bc6631d… (block 4,530,338), is unfounded. The audit with the
seller's key confirms the seller got 135,000 + 195,000 zat. Record: deployments/testnet-sale003.json.

Sale 002 (reveal channel, before bound terms), auction `fuin-reveal-2026-10-21T18:43`, blocks
4,526,425–4,526,493: the same three script-driven `sba-mcp` bidders; reveals 332fbc3c…, 07ec9dcd…,
80428975… accepted, ca315a6c… wrong_commitment, 64de2707… late; a two-payment deposit 9bb4098e…
(valid + duplicate, both refunded); one deposit never revealed (19029d77…, listed unrevealed, kept by
the auction wallet under the rules then); settlement e84de386… (5 outputs, all viewing-key checks
match); the winner's complaint, anchored at f17193d5… (block 4,526,500), is unfounded and paid in
full. Record: deployments/testnet-reveal.json.

Sale 001 (before the reveal channel), auction `sba-testnet-2026-10-20T13:30`, blocks
4,522,258–4,522,278. 3 valid sealed bids (06d12181…, 3d104727…, d910ebad…). Rejected: wrong amount
29c23b7d…, memo mismatch 76b0b9bb…, duplicate c1b89ecd…, late c2e20a26…. The altered reveal was
refused. Settlement 89bf60fd… (block 4,522,291, 7 outputs, all viewing-key checks match).
Ironwood-only throughout. Record: deployments/testnet.json.

## Honest scope
- The auctioneer learns bids at the reveal and is trusted to settle. Sales 001 and 002 predate bound
  terms (the audit prints `! terms: legacy`): their close and reveal window come from the record.
- The audit trusts the lightwalletd it reads; payments are checked only with a recipient's key (the
  seller's, or a complaint's refund key), otherwise it ends "chain checks pass; payments not checked".
- No live sale has ended without a sale: the no-sale path is covered by unit tests with real proofs.
- Reveals cost one more shielded transaction per bidder; a complaint publishes the complainer's bid,
  and an opt-in refund key publishes every payment to that refund wallet. Sale 002's complaint was
  filed before that was opt-in and carries the winner's whole demo-wallet key; Sale 003's carries none.
- Same-block ties go to the lexically lower txid; at most 8 revealed bids compete.
- Nothing forces the auctioneer to settle; the rules are enforced by the service (Zcash has no
  contracts) and re-checkable from the chain with the published key.
- Single-party Groth16 setup (a ceremony needs outside contributors); threshold decryption of the
  reveal key is sketched in the docs, not built.

## Test coverage
85 passed, 0 failed, 2 skipped (verifier 6, circuits 10, service 52 passed and 2 skipped of 54, mcp 17; the service audit and
mcp tests read live testnet, so `pnpm test` needs network access and takes about 10 minutes on this
machine), and 100 end-to-end tests in Google Chrome (50 per viewport: landing and evidence page 23, saleroom 27). CI
(`.github/workflows/ci.yml`) runs `pnpm test` on the public repository. See TESTING.md.

## Links
- Repo: https://github.com/nickthelegend/zec-sealed-bid-auction (public).
- Landing: https://fuin-landing.vercel.app (saleroom at https://fuin-landing.vercel.app/saleroom/) and
  the saleroom on its own: https://fuin-dashboard.vercel.app (static, over the published records).
  Locally: `pnpm install && pnpm --filter @sba/dashboard dev`.
- Video: none current. The only recording, `zec-sealed-bid-audit.mp4` (16 s, asciinema, captions
  marked ###, shared separately), shows the audit of Sale 001 at `58c2393`, before the chain-scanning
  audit, the reveal channel and Sales 002 and 003. A 2-minute walkthrough is still to be recorded.
