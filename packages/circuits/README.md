# circuits — `MaxBid(8)`

Circom 2.2 / Groth16 (BN254) circuit. Public: `auction_id`, `reserve`, the 8 bid commitments,
`winner` (slot index) and `winning_bid`. Private: every bid and salt. It proves:

1. each private opening hashes to its public commitment: `Poseidon(auction_id, bid, salt)`;
2. bids are 64-bit;
3. `winning_bid` is the bid in slot `winner`;
4. no bid is above `winning_bid`, and earlier slots are strictly below it, so ties go to the earliest slot. Slots follow chain order: block height, then txid within a block (not the transaction's position in the block), so of two equal bids mined in one block the lexically lower txid wins;
5. `winning_bid >= reserve`.

So anyone can check the declared winner against the public commitments without learning any losing
bid. 6,800 constraints. Unused slots carry `Poseidon(auction_id, 0, 0)`.

`scripts/build.sh` compiles the circuit and runs a **single-party local trusted setup** (powers of
tau 2^14 with a random contribution, then a circuit-specific contribution). The committed
`build/maxbid_final.zkey` and `build/verification_key.json` (sha256 `d2a3dfcc…7c0fca2`) come from that
run. Whoever ran the setup could forge proofs; a multi-party ceremony would remove that, and the
docs say so.

`src/result.ts` (`checkResult`, browser-safe) ties a proof to an auction's deposits: the circuit takes any
eight commitments, so a verifying proof alone does not say which deposits it covers. The proven slots
must be the valid deposits in chain order (minus any declared unrevealed), spare slots must be the empty
commitment, and the winner must be one of the proven deposits. The audit, the MCP server and the
dashboard all use it.

`pnpm test`: 10 tests with real proofs. `maxbid.test.ts` (6): valid proof verifies and shows no losing bid; tampered
winner / winning bid fails verification; no witness for a non-highest winner, a below-reserve bid,
an altered opening, or a later slot claiming a tie. `result.test.ts` (4): the honest result passes; a
phantom winning bid in a spare slot verifies but is rejected; a left-out deposit fails unless declared
unrevealed; another auction or reserve fails.
