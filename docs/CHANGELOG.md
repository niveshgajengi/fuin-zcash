# Changelog

What changed, by date, and why. Test counts live only in [TESTING.md](../TESTING.md), so they are
never stale here.

## 2026-10-23: rule fixes from review

- **No sale is settled.** When nothing valid is revealed, or the highest revealed bid is below the
  reserve, `decide` now returns a no-sale outcome instead of throwing: every revealed deposit is
  refunded minus its own output fee, unrevealed ones go to the seller, and for `below_reserve` a
  MaxBid proof with reserve 0 shows the top bid, which the audit checks is below the reserve. Before
  this, a sale below the reserve left every deposit in the auction wallet.
- **Capacity counts revealed bids.** The proof's 8 slots go to the first 8 *revealed* valid deposits.
  Before, the first 8 valid deposits took them whether or not anyone revealed them, so 8 junk deposits
  could freeze an auction. MCP `bid` now only warns at 8 valid deposits on chain.
- **Records say how far the auctioneer scanned** (`scannedTo`). Notes mined after that and before the
  settlement are late and cannot change the outcome; the audit reports them instead of failing an
  honest record that a third party paid in that gap.
- **The audit no longer says "all checks pass" without checking a payment.** With the seller's
  incoming viewing key (`SBA_SELLER_UIVK`) it checks that the winning bid and every forfeit reached
  the seller; without it the run ends "chain checks pass; payments not checked". Before, a record
  naming an unrelated transaction as its settlement passed.
- **The settlement fee scales.** Revealed non-bid and over-capacity deposits are refunded minus their
  own 5,000 zat output fee, and `decide` checks that the payouts plus the ZIP-317 fee fit before
  anything is sent.
- **Scans are split into 5,000-block windows,** so auctions open for more than about four days can be
  audited.
- **Commitments must be canonical** (no leading zero, below the BN254 modulus), so one commitment
  cannot pose as two deposits.
- **CI** runs `pnpm test` on GitHub (once the repository is public).
- **Wording:** the Sale 002 bidders were `sba-mcp` processes driven by the `reveal-run` script, not
  autonomous agents; a complaint publishes its bidder's own bid; the audit trusts the lightwalletd it
  reads; the trusted setup is single-party and no ceremony was run; a sketch of threshold decryption
  of the reveal key is in the protocol docs.

## 2026-10-22: the reveal channel, disputes, bound terms

- Reveals travel as 1-zat shielded notes whose memo is the opening sealed to the auction's reveal key;
  the audit checks the record's reveal log against the notes on chain.
- Signed complaints, anchored on chain in a dispute window; the audit gives a verdict.
- Each payment is its own deposit, including two payments in one transaction.
- Auction ids hash every term on the card (`bound`); Sales 001 and 002 predate this (`legacy`).
- Settlement memos name what each output pays; unrevealed deposits are forfeited to the seller.
- The audit reads the settlement's height from the chain.
- Sale 002 ran on testnet with three `sba-mcp` bidder processes driven by the `reveal-run` script.

## 2026-10-21: the proof is tied to the chain

- `checkResult`: the proven slots are exactly the valid deposits in chain order, spare slots are
  empty, and the winner is a real deposit (a phantom bid in a spare slot used to pass).
- `sba-verify scan`: the audit finds deposits by scanning the auction's blocks with its viewing key
  instead of trusting the record's list.
- Unrevealed deposits are declared in the outcome; MCP `bid` refuses a closed auction; the saleroom
  hashes the verification key it uses and runs the checks in the tab.

## 2026-10-20: Sale 001

- The MaxBid circuit, the service, `sba-verify` and the first live sale on Zcash testnet.
