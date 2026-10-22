# Fuin — protocol and threat model

## Roles

- **Auctioneer:** holds the auction wallet (a shielded Zcash testnet address), publishes the auction
  card (id, address, incoming viewing key, deposit size, reserve, open and close heights, reveal key,
  reveal window, dispute window, seller), reads reveals from the chain, proves the result and settles.
  The id is a hash of every term on the card (`termsAuctionId`, 127 bits of SHA-256), and every
  deposit memo and the proof carry it, so no term can change after the bids: the audit recomputes it
  (`checkTerms`) and fails on a mismatch, and MCP `bid` refuses to send to a card whose id does not
  match. Sale 001 and Sale 002 predate this: their ids hash only the name (`legacy`), so their heights,
  reserve and windows are read from the record, and the audit says so.
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
5. **Prove.** The auctioneer orders the valid, revealed deposits by height, then by txid within a
   block, and proves with `MaxBid(8)` that the bid in slot `w` is the highest (the earlier slot wins
   ties) and ≥ the reserve. "Earlier" within one block means the lexically lower txid, not the
   transaction mined first: `sba-verify` does not report a transaction's position in its block. A
   bidder could grind its txid to win a tie with a bid in the same block, or to be "first" for a
   duplicate or conflicting decision; equal bids in the same block are the only case it changes.
   Public: auction id, reserve, the commitments, `w`, and the winning bid. Private: every other bid
   and every salt. Valid deposits with no accepted reveal are left out of the proof and listed in
   the outcome as `unrevealed`.
6. **Tie the proof to the chain** (`checkResult`, run by the audit, the MCP server and the
   dashboard). The circuit accepts any eight commitments, so this check is what makes the proof about
   *this* auction: slots `0..n-1` are the revealed valid deposits in chain order, slots `n..7` are
   `Poseidon(auction_id, 0, 0)`, `w < n`, and only valid deposits can be listed as unrevealed. The
   audit finds the deposits by scanning the auction's blocks (`sba-verify scan`) with its UIVK, so
   it does not depend on the auctioneer's list.
7. **Settle.** One shielded transaction pays the seller the winning bid. It refunds every losing bid
   in the proof in full, and every other revealed deposit (duplicates, late, wrong-amount deposits
   and revealed bids after the first 8, over capacity) minus its own 5,000 zat output fee, so that
   no number of them can push the ZIP-317 fee (5,000 zat per action, at least two) past what the
   deposits hold; `decide` checks the payouts plus the fee fit before anything is sent.
   The winner gets its deposit back minus the bid and a fixed settlement-fee budget (60,000 zat).
   Every unrevealed deposit goes to the seller (minus its 5,000 zat output fee). Each output's memo
   names what it pays: `sba1:<id>:seller`, `:change:<deposit>`, `:refund:<deposit>` or
   `:forfeit:<deposit>`, so a recipient, and a complaint, can tell its outputs apart. Sales 001 and
   002 used `sba1:<id>:settlement` on every output.
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
which is owed its change (deposit − bid − fee budget). What it was paid: only the settlement outputs
whose memo names one of those deposits (`refund:<deposit>`, `change:<deposit>`), read with the refund
key, so a payment for another deposit to the same address cannot make an underpaid one look paid. A
legacy settlement (every memo `sba1:<id>:settlement`, as in Sales 001 and 002) names no deposit: the
audit then adds up what every complaint using the same refund key is owed and compares it with that
key's total once (`checkSharedRefundKeys`). That catches a shortfall across complaints, but a deposit
whose bidder did not complain can still mask one.

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
in the proof, or leave a deposit or a reveal note out of its record, without failing the audit: the
audit scans up to the settlement's height as mined, read from the chain, not from the record. The
record says how far the auctioneer scanned (`scannedTo`, at or after the end of the reveal window);
the record must list every note up to there. A note mined after it and before the settlement is late
(a deposit after the close, a reveal after the window), so it cannot change the outcome: anyone can
pay the auction address in that gap, so the audit prints it as a note instead of failing an honest
record. (Sales 001 and 002 have no `scannedTo` and are held to completeness up to the settlement.) On an
auction whose id binds its terms it also cannot move the close or the reveal window, so it cannot call
an in-window reveal late. On the two legacy sales (ids that hash only the name) it could: their
windows come from the record, which the audit flags as `legacy`. If it rejects a valid reveal as tampered (only it can decrypt), or
underpays a refund, the bidder's complaint shows it, and the audit names the failure. It can still
refuse to settle at all; Zcash has no contract that could force it.

## Rules enforced by the service

Zcash has no smart contracts, so these are checked by the auction service. Every input the service
uses is reproducible from the chain with the published UIVK (`sba-verify`).

| Rule | Status |
|---|---|
| memo is not `sba1:<this auction>:<commitment>` | `memo_mismatch`: not a bid; it stays in the auction wallet (no reveal can claim it, and nothing the auctioneer decides makes a payment one) |
| mined after the close height | `late`: refunded at settlement if revealed, minus its own 5,000 zat output fee (as are wrong-amount, duplicate and over-capacity deposits; Sales 001 and 002 refunded them in full) |
| amount ≠ deposit | `wrong_amount`: refunded if revealed |
| same commitment as an earlier deposit | `duplicate`: refunded if revealed |
| a revealed valid deposit after the first 8 revealed valid ones in chain order (the proof has 8 slots) | over capacity: no slot, cannot win, refunded. Only revealed deposits take slots, so deposits nobody reveals (or nobody can open) cannot fill the auction; they are forfeited to the seller. MCP `bid` only warns (`capacity_note`) when 8 or more valid deposits are already on chain |
| opening does not hash to any deposit's commitment | `altered`: refused |
| bid > deposit − fee budget | refused |
| valid deposit, no accepted reveal | `unrevealed`: left out of the proof, listed in the outcome. It has no refund address, so the settlement **forfeits it to the seller** (memo `sba1:<id>:forfeit:<deposit>`, minus its 5,000 zat output fee), as it does any other unrevealed deposit. The auctioneer keeps nothing when a reveal fails, so it gains nothing by making one fail. Sales 001 and 002 predate this rule: Sale 002's unrevealed deposit stayed in the auction wallet |
| reveal memo is not `sba1r:<auction>:<deposit>:<sealed>` | `malformed` |
| reveal for another auction | `other_auction` |
| reveal mined at or before the close / after `revealCloseHeight` / not mined | `early` / `late` / `pending` |
| reveal names no deposit carrying a commitment | `unknown_deposit` |
| reveal does not decrypt with the reveal key (altered, moved to another deposit, sealed to another key) | `tampered` |
| reveal decrypts, but its opening hashes to another commitment (another bidder's deposit) | `wrong_commitment` |
| the same opening of a commitment again | `duplicate`: no effect (idempotent) |
| a different opening of an already-opened commitment | `conflicting`: the first one counts |
| no valid deposit revealed | **no sale** (`no_reveal`): no proof; every valid deposit is declared unrevealed (the audit checks that no accepted reveal is among them) and forfeited to the seller, minus its output fee; a revealed non-bid deposit (late, duplicate, wrong amount) is refunded minus its output fee |
| highest revealed valid bid < reserve | **no sale** (`below_reserve`): a MaxBid proof made with reserve 0 over the same slots shows which bid is highest, and the audit checks that bid is below the real reserve (so a no-sale cannot cancel a sale that met it); that bid becomes public, as a winning bid would. Every revealed deposit is refunded to its refund address minus its own 5,000 zat output fee (10,000 when the settlement has a single output, ZIP-317's two-action minimum), memo `sba1:<id>:refund:<deposit>`; unrevealed deposits are forfeited to the seller as above. The outcome is published with `noSale: { reason, detail }` |

## Trusted setup

`MaxBid` uses Groth16 with a **single-party local setup** (`packages/circuits/scripts/build.sh`).
Whoever ran it could forge proofs, so the proof convinces only to the extent that the setup is
trusted. A multi-party ceremony, or a transparent proof system, would remove that trust.

## Prior art

Sealed-bid auctions with zero-knowledge proofs are not new. The closest:

- **zkSNARKs' blind-bid ZEC auction** (September 2026): bids in ZEC, reported 16,971 bids, cleared at
  1.5 ZEC, settled through NEAR Intents (about $19M across 1,718 cross-chain swaps).
  Sources: [Crypto Briefing](https://cryptobriefing.com/zksnarks-auction-clears-zcash-blind-bids/),
  [NEAR Intents blog](https://intents.aurora.dev/blog/zcash-auction-cross-chain-swaps),
  [Nightash](https://nightash.org/en/news/near-intents-zec-auction-settlement-2026-09-14/). These
  figures come from those reports; Fuin did not check them on chain.
- **Ethereum commit-reveal auctions with ZK proofs:** a contract holds the commitments and deposits,
  bids are revealed to it (or proven in zero knowledge), and the contract enforces the deadlines.

What Fuin does differently:

1. **Equal shielded deposits whose memos are the proof's public inputs.** The MaxBid proof is about
   exactly the commitments in the auction's deposit memos, and `checkResult` ties every slot to a
   deposit on chain, so neither a phantom bid nor a dropped deposit passes.
2. **Reveals sealed inside shielded memos.** There is no contract to receive reveals, so the chain
   timestamps them instead: each reveal is a note whose memo is the opening sealed to the reveal key,
   mined inside the window or not, and a reveal the auctioneer drops is visible to anyone with the
   viewing key.
3. **Signed complaints anchored on chain, and an audit with only the viewing key.** A bidder's
   complaint is signed with a key only it holds and anchored in the dispute window, and the audit
   proves completeness with the incoming viewing key alone: no hidden deposit, no hidden reveal, a
   settlement height read from the chain.
