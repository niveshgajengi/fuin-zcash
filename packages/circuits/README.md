# circuits — `MaxBid(8)`

Circom 2.2 / Groth16 (BN254) circuit. Public: `auction_id`, `reserve`, the 8 bid commitments,
`winner` (slot index) and `winning_bid`. Private: every bid and salt. It proves:

1. each private opening hashes to its public commitment: `Poseidon(auction_id, bid, salt)`;
2. bids are 64-bit;
3. `winning_bid` is the bid in slot `winner`;
4. no bid is above `winning_bid`, and earlier slots (earlier deposits) are strictly below it, so ties go to the earliest deposit;
5. `winning_bid >= reserve`.

So anyone can check the declared winner against the public commitments without learning any losing
bid. 6,800 constraints. Unused slots carry `Poseidon(auction_id, 0, 0)`.

`scripts/build.sh` compiles the circuit and runs a **single-party local trusted setup** (powers of
tau 2^14 with a random contribution, then a circuit-specific contribution). The committed
`build/maxbid_final.zkey` and `build/verification_key.json` (sha256 `d2a3dfcc…7c0fca2`) come from that
run. Whoever ran the setup could forge proofs; a multi-party ceremony would remove that, and the
docs say so.

`pnpm test`: 6 tests with real proofs: valid proof verifies and shows no losing bid; tampered
winner / winning bid fails verification; no witness for a non-highest winner, a below-reserve bid,
an altered opening, or a later slot claiming a tie.
