pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// MaxBid(N): the bid committed in slot `winner` is the highest of all N committed bids (ties go to
// the earliest slot; slots are in chain order by height, then by txid within a block, so the lower
// txid wins a tie in the same block) and is at least `reserve`. Only `winning_bid` is
// public; every other bid and every salt stays private.
//
// commitment_i = Poseidon(auction_id, bid_i, salt_i). Unused slots hold Poseidon(auction_id, 0, 0).
template MaxBid(N) {
    signal input auction_id;
    signal input reserve;
    signal input commitments[N];
    signal input winner;
    signal input winning_bid;

    signal input bids[N];
    signal input salts[N];

    // 1. The private openings match the public commitments.
    component h[N];
    for (var i = 0; i < N; i++) {
        h[i] = Poseidon(3);
        h[i].inputs[0] <== auction_id;
        h[i].inputs[1] <== bids[i];
        h[i].inputs[2] <== salts[i];
        h[i].out === commitments[i];
    }

    // 2. Bids are 64-bit (zatoshi amounts), so the comparators below are sound.
    component range[N];
    for (var i = 0; i < N; i++) {
        range[i] = Num2Bits(64);
        range[i].in <== bids[i];
    }
    component rangeW = Num2Bits(64);
    rangeW.in <== winning_bid;
    component rangeR = Num2Bits(64);
    rangeR.in <== reserve;

    // 3. winning_bid is the bid in slot `winner` (exactly one slot selected).
    component sel[N];
    signal picked[N];
    signal acc[N + 1];
    var selected = 0;
    acc[0] <== 0;
    for (var i = 0; i < N; i++) {
        sel[i] = IsEqual();
        sel[i].in[0] <== i;
        sel[i].in[1] <== winner;
        picked[i] <== sel[i].out * bids[i];
        acc[i + 1] <== acc[i] + picked[i];
        selected += sel[i].out;
    }
    selected === 1;
    acc[N] === winning_bid;

    // 4. No bid is above the winning bid; earlier slots must be strictly below it (tie-break).
    component le[N];
    component lt[N];
    component before[N];
    for (var i = 0; i < N; i++) {
        le[i] = LessEqThan(64);
        le[i].in[0] <== bids[i];
        le[i].in[1] <== winning_bid;
        le[i].out === 1;

        lt[i] = LessThan(64);
        lt[i].in[0] <== bids[i];
        lt[i].in[1] <== winning_bid;
        before[i] = LessThan(8);
        before[i].in[0] <== i;
        before[i].in[1] <== winner;
        before[i].out * (1 - lt[i].out) === 0;
    }

    // 5. The winning bid meets the reserve.
    component meets = GreaterEqThan(64);
    meets.in[0] <== winning_bid;
    meets.in[1] <== reserve;
    meets.out === 1;
}

component main {public [auction_id, reserve, commitments, winner, winning_bid]} = MaxBid(8);
