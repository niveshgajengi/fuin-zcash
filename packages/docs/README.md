# Fuin — protocol and threat model

## Roles

- **Auctioneer:** holds the auction wallet (a shielded Zcash testnet address), publishes the auction
  card (id, address, incoming viewing key, deposit size, reserve, close height, reveal key, reveal
  window, dispute window), reads reveals from the chain, proves the result and settles.
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
4. **Reveal.** After the close and up to `revealCloseHeight`, each bidder sends a second shielded
   note (1 zat) to the auction address. Its memo is
   `sba1r:<auction_id>:<deposit>:<sealed opening>`, where the sealed opening is
   `(b, s, refund address, complaint key)` encrypted to the auction's published X25519 reveal key
   (ECIES: a fresh ephemeral key per reveal, HKDF-SHA256, ChaCha20-Poly1305, the
   `sba1r:<auction>:<deposit>` header as associated data, a fixed 224-byte plaintext so the length
   leaks nothing). The auctioneer scans the auction's blocks and decrypts reveals with its reveal
   secret (`ingestReveals`); it never reads a bidder's files. A reveal is accepted only if it is
   mined inside the window, decrypts, and its opening hashes to the commitment of the deposit it
   names. Knowing that opening is what authenticates the bidder. See "Why reveal by memo" below.
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
8. **Dispute.** Until `disputeBlocks` after the settlement, a bidder whose valid reveal was ignored,
   or who was paid less than it is owed, files a complaint (below). The audit checks it against
   the chain and names the failure.

A deposit transaction can pay the auction more than once. Each payment is its own deposit, named by
its txid when the transaction pays the auction once and `txid:<index>` (the Ironwood action index)
when it pays it several times. Notes whose memo starts with `sba1r:` or `sba1d:` are channel
messages, not deposits.

## Why reveal by memo, not an HTTP endpoint

Both keep the property that matters: losing bids are never published. In both, the opening is
encrypted to the auctioneer's reveal key, and only the winning bid becomes public, through the
proof. The memo channel was chosen because the chain does three things an endpoint cannot:

- **It timestamps the reveal.** The window is enforced by block height. With an endpoint, the
  window is the auctioneer's clock, and "it arrived late" cannot be checked.
- **It makes dropping a reveal visible.** Anyone with the auction's incoming viewing key sees every
  reveal note and which deposit it names (never what it says), so the record has to list each one
  with a status. The audit fails if one is missing, if a status that follows from public facts
  (window, auction, memo shape, named deposit) is wrong, or if a deposit with an accepted reveal is
  declared unrevealed. With an endpoint, the auctioneer can deny receiving anything.
- **It gives the bidder evidence.** The bidder keeps the reveal's ephemeral secret. Publishing it
  opens that one on-chain reveal for everyone, which proves what was sent and when. That is the
  basis of the dispute flow.

The cost is one more shielded transaction per bidder (about 10,000 zat in fees plus the 1-zat note,
which the auction keeps), and the viewing key now shows which deposits were revealed and when. The
outcome's `unrevealed` list publishes the same fact. The incoming viewing key is public, which is
why the opening is encrypted again inside the shielded memo: shielding alone would expose it to
every auditor.

## Disputes

A complaint (`checkComplaint`, MCP tool `complain`) is a JSON file holding the auction id, the
deposit, the reveal note, the reveal's ephemeral secret, optionally a refund viewing key, and an
Ed25519 signature by the complaint key the bidder put inside that reveal.

The refund viewing key is opt-in (`complain({ include_refund_key: true })`). It is the incoming
viewing key of a whole wallet, not of one address: anyone holding it reads every payment that wallet
ever receives, past and future. So the MCP server takes it only from `SBA_REFUND_WALLET`, a separate
wallet that should receive nothing but this auction's refunds, and refuses when that is the bidding
wallet. Without it the audit still checks that the complaint is authentic, anchored in the window and
whether the reveal was honoured; it just does not check the payment.
The auctioneer saw only the public half of that key, so it cannot forge a complaint. The
complaint's SHA-256 is anchored on chain by a 1-zat note to the auction address with memo
`sba1d:<auction_id>:<digest>`, mined within `disputeBlocks` after the settlement.

The audit (`audit <record> <complaint.json>...`) gives one of three verdicts:

| Verdict | When |
|---|---|
| `rejected` | not anchored in the dispute window; the secret does not open the named reveal; the reveal names another deposit; not signed by the key inside the reveal, or altered after signing |
| `unfounded` | authentic, but the reveal itself was early, late, or did not open the deposit, or the record and settlement honoured it (with a refund key: "paid in full") |
| `upheld` (audit fails) | the reveal was valid and the record rejects it, leaves it out, or declares its deposit unrevealed; or the refund address, read with its own viewing key (checked with `sba-verify owns`), received less than it is owed |

What it owes: every deposit carrying the opened commitment back in full, except the winning deposit,
which is owed its change (deposit − bid − fee budget).

Filing a complaint publishes the bidder's own opening, including its bid. That is the price of
proving censorship, and the bidder chooses to pay it.

Sale 002's one complaint (bidder2, the winner) was filed before the key was opt-in: it carries the
incoming viewing key of bidder2's whole demo wallet, which was also used in Sale 001. Anyone can read
every testnet payment to that wallet with it. That file stays as it is, because its digest is the one
anchored on chain.

## What each party learns

| Party | Learns | Does not learn |
|---|---|---|
| Public chain | that shielded transactions happened | amounts, memos, addresses (Ironwood-only, no transparent part) |
| Anyone with the auction UIVK | each deposit's amount (all equal) and commitment memo; which deposit each reveal note names and its block; the winning bid via the proof | any losing bid, any salt, any refund address, who the bidders are |
| Auctioneer | every bid at reveal time, refund addresses | bids before the close (deposits are equal and memos are hashes); a bidder's complaint key secret |
| Everyone, after a complaint | that bidder's opening: its bid, salt and refund address (it published its reveal secret) | anyone else's |
| Everyone, after a complaint with a refund key | every incoming payment to that refund wallet, past and future (the key is the wallet's incoming viewing key) | payments to the bidder's other wallets |
| A bidder | its own deposit and refund (with its own viewing key) | other bids |

The auctioneer is trusted to settle and learns every bid at the reveal. It cannot put a phantom bid
in the proof, leave a deposit out without listing it, hide a reveal note, or call an in-window reveal
late, without failing the audit. If it rejects a valid reveal as tampered (only it can decrypt), or
underpays a refund, the bidder's complaint shows it, and the audit names the failure. It can still
refuse to settle at all; Zcash has no contract that could force it.

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
| reveal memo is not `sba1r:<auction>:<deposit>:<sealed>` | `malformed` |
| reveal for another auction | `other_auction` |
| reveal mined at or before the close / after `revealCloseHeight` / not mined | `early` / `late` / `pending` |
| reveal names no deposit carrying a commitment | `unknown_deposit` |
| reveal does not decrypt with the reveal key (altered, moved to another deposit, sealed to another key) | `tampered` |
| reveal decrypts, but its opening hashes to another commitment (another bidder's deposit) | `wrong_commitment` |
| the same opening of a commitment again | `duplicate`: no effect (idempotent) |
| a different opening of an already-opened commitment | `conflicting`: the first one counts |
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
