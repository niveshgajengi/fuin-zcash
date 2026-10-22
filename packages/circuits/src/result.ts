// Is a published MaxBid result about exactly this auction's deposits?
//
// The circuit accepts any eight public commitments, so a valid proof alone says nothing about which
// deposits it covers. This check ties it to the chain: the proven slots are the valid deposits in
// chain order (minus the ones the auctioneer declares unrevealed), every other slot is the empty
// commitment, and the winner is one of the proven deposits. Without it an auctioneer could put an
// invented bid with no deposit behind it in a spare slot and prove that it wins.
// No Node imports: the dashboard runs this in the browser.

export const SLOTS = 8;

/** Public signal order: auction_id, reserve, commitments[8], winner, winning_bid. */
export function readPublic(publicSignals: string[]) {
  return {
    auctionId: BigInt(publicSignals[0]),
    reserve: BigInt(publicSignals[1]),
    commitments: publicSignals.slice(2, 2 + SLOTS),
    winner: Number(publicSignals[2 + SLOTS]),
    winningBid: BigInt(publicSignals[3 + SLOTS]),
  };
}

export interface ResultDeposit {
  txid: string;
  height: number | null;
  status: string;
  /** The commitment in the deposit's memo, or null when the memo is not a bid. */
  commitment: string | null;
}

export interface ResultInput {
  auctionId: bigint;
  reserve: bigint;
  /** Every deposit to the auction, classified (valid, late, duplicate, ...). Any order. */
  deposits: ResultDeposit[];
  /** Valid deposits the auctioneer declares were never revealed (so are not in the proof). */
  unrevealed: string[];
  publicSignals: string[];
  /** Poseidon(auction_id, 0, 0). */
  emptyCommitment: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ResultCheck {
  ok: boolean;
  checks: Check[];
  /** The deposit the proof names as the winner, or null if it names none. */
  winnerTxid: string | null;
  winningBid: bigint;
  /** Txids of the deposits whose commitments the proof covers, in slot order. */
  proven: string[];
}

// Chain order: height, then the deposit's name (txid) within a block. Not the order of transactions in
// the block: sba-verify does not report it, so the lexically lower txid is "earlier" in the same block.
const byChainOrder = (a: ResultDeposit, b: ResultDeposit) =>
  (a.height ?? Infinity) - (b.height ?? Infinity) || a.txid.localeCompare(b.txid);

export function checkResult(input: ResultInput): ResultCheck {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  if (input.publicSignals.length !== SLOTS + 4) {
    add('signals', false, `expected ${SLOTS + 4} public signals, got ${input.publicSignals.length}`);
    return { ok: false, checks, winnerTxid: null, winningBid: 0n, proven: [] };
  }
  const pub = readPublic(input.publicSignals);
  add(
    'auction',
    pub.auctionId === input.auctionId && pub.reserve === input.reserve,
    `proof is for auction ${pub.auctionId} with reserve ${pub.reserve}; this auction is ${input.auctionId} with reserve ${input.reserve}`,
  );

  const valid = input.deposits.filter((d) => d.status === 'valid').sort(byChainOrder);
  const validIds = new Set(valid.map((d) => d.txid));
  const strayUnrevealed = input.unrevealed.filter((t) => !validIds.has(t));
  add(
    'unrevealed',
    strayUnrevealed.length === 0,
    strayUnrevealed.length === 0
      ? `${input.unrevealed.length} valid deposit(s) declared unrevealed`
      : `declared unrevealed but not a valid deposit: ${strayUnrevealed.join(', ')}`,
  );

  const declared = new Set(input.unrevealed);
  const proven = valid.filter((d) => !declared.has(d.txid));
  const n = proven.length;
  const slotErrors: string[] = [];
  if (n === 0) slotErrors.push('no revealed valid deposit');
  if (n > SLOTS) slotErrors.push(`${n} revealed valid deposits, the circuit has ${SLOTS} slots`);
  for (let i = 0; i < SLOTS; i++) {
    const want = i < n ? proven[i].commitment : input.emptyCommitment;
    if (pub.commitments[i] !== want) {
      slotErrors.push(i < n ? `slot ${i} is not deposit ${proven[i].txid.slice(0, 10)}'s memo` : `slot ${i} should be empty, Poseidon(auction, 0, 0), but is not`);
    }
  }
  add(
    'slots',
    slotErrors.length === 0,
    slotErrors.length === 0 ? `slots 0-${n - 1} are the ${n} revealed valid deposits in chain order; slots ${n}-${SLOTS - 1} are empty` : slotErrors.join('; '),
  );

  const winner = Number.isInteger(pub.winner) && pub.winner >= 0 && pub.winner < n ? proven[pub.winner] : null;
  add('winner', winner !== null, winner ? `slot ${pub.winner} is deposit ${winner.txid.slice(0, 10)}` : `slot ${pub.winner} is not a deposit`);

  return {
    ok: checks.every((c) => c.ok),
    checks,
    winnerTxid: winner?.txid ?? null,
    winningBid: pub.winningBid,
    proven: proven.map((d) => d.txid),
  };
}
