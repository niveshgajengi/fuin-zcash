// Sealed-bid auction on Zcash testnet.
//
// Bid:     commitment = Poseidon(auction_id, bid_zat, salt); a shielded deposit of exactly
//          `depositZat` to the auction address with memo `sba1:<auction_id>:<commitment>`.
//          Every deposit is the same size, so the deposit itself says nothing about the bid.
// Close:   deposits mined after `closeHeight` are late.
// Reveal:  each bidder privately gives (bid, salt, refund address); knowing the opening is the
//          authentication. An opening must hash to the commitment of a valid deposit.
// Settle:  MaxBid proof over the valid commitments (deposit order), then ONE shielded transaction:
//          seller gets the winning bid, every other revealed deposit is refunded in full, and the
//          winner gets the deposit back minus the bid and the settlement fee.
//
// Zcash has no contracts, so the rejections below are enforced by this service; anyone can check
// them with the auction's incoming viewing key (sba-verify) and the published proof.
import { createHash } from 'node:crypto';
import { checkResult, commitment, emptyCommitment, inputs, prove, SLOTS, verify, winnerOf, type Check, type Opening } from '@sba/circuits';

export const MEMO_PREFIX = 'sba1';
export const SETTLEMENT_FEE_BUDGET_ZAT = 60_000n;

export interface AuctionConfig {
  name: string;
  auctionId: bigint;
  /** Unified address that receives deposits. */
  address: string;
  /** Incoming viewing key of the auction address: published so anyone can audit deposits. */
  uivk: string;
  depositZat: bigint;
  reserveZat: bigint;
  closeHeight: number;
  sellerAddress: string;
}

/** 63-bit id from sha256(name), so it fits the circuit field and a memo comfortably. */
export function auctionIdFor(name: string): bigint {
  return BigInt('0x' + createHash('sha256').update(`sba-auction:${name}`).digest('hex').slice(0, 16)) >> 1n;
}

export function depositMemo(auctionId: bigint, commitmentDec: string): string {
  return `${MEMO_PREFIX}:${auctionId}:${commitmentDec}`;
}

export function parseMemo(memo: string): { auctionId: bigint; commitment: string } | null {
  const m = memo.trim().match(/^sba1:(\d{1,20}):(\d{1,80})$/);
  return m ? { auctionId: BigInt(m[1]), commitment: m[2] } : null;
}

/**
 * What a settlement output pays, named in its memo so its recipient (and a complaint) can tell which
 * deposit each output settles: `sba1:<auction>:seller`, `sba1:<auction>:change:<deposit>` (the
 * winner's change), `sba1:<auction>:refund:<deposit>`. Settlements before these memos used
 * `sba1:<auction>:settlement` for every output (`legacy`).
 */
export type PayoutKind = 'seller' | 'change' | 'refund';
export function payoutMemo(auctionId: bigint, kind: PayoutKind, deposit?: string): string {
  if (kind === 'seller') return `${MEMO_PREFIX}:${auctionId}:seller`;
  if (!deposit) throw new Error(`a ${kind} output names the deposit it pays`);
  return `${MEMO_PREFIX}:${auctionId}:${kind}:${deposit}`;
}
export function parsePayoutMemo(memo: string): { auctionId: bigint; kind: PayoutKind | 'legacy'; deposit: string | null } | null {
  const m = memo.trim().match(/^sba1:(\d{1,20}):(?:(seller|settlement)|(change|refund):([0-9a-f]{64}(?::[os]?\d{1,4})?))$/);
  if (!m) return null;
  if (m[2]) return { auctionId: BigInt(m[1]), kind: m[2] === 'seller' ? 'seller' : 'legacy', deposit: null };
  return { auctionId: BigInt(m[1]), kind: m[3] as PayoutKind, deposit: m[4] };
}

/** One payment to the auction as it sees it (from sba-verify). */
export interface IncomingDeposit {
  txid: string;
  /** Which output, when the transaction pays the auction more than once (see `asDeposits`). */
  output?: string;
  height: number | null;
  value: bigint;
  memo: string;
}

export type DepositStatus = 'valid' | 'late' | 'pending' | 'wrong_amount' | 'memo_mismatch' | 'duplicate';

/** A deposit's name: its txid, or `txid:<output>` when its transaction pays the auction more than once. */
export const depositRef = (d: { txid: string; output?: string }) => (d.output === undefined ? d.txid : `${d.txid}:${d.output}`);

export interface ClassifiedDeposit extends IncomingDeposit {
  ref: string;
  status: DepositStatus;
  commitment: string | null;
  reason?: string;
}

/**
 * Classifies deposits in chain order (height, then name). Only `valid` deposits can win; the first
 * deposit with a given commitment is the bid and later copies are duplicates. Each payment is its
 * own deposit, including a second payment in the same transaction.
 */
export function classifyDeposits(cfg: AuctionConfig, deposits: IncomingDeposit[]): ClassifiedDeposit[] {
  const seen = new Set<string>();
  return deposits
    .map((d) => ({ ...d, ref: depositRef(d) }))
    .sort((a, b) => (a.height ?? Infinity) - (b.height ?? Infinity) || a.ref.localeCompare(b.ref))
    .map((d): ClassifiedDeposit => {
      const parsed = parseMemo(d.memo);
      if (!parsed || parsed.auctionId !== cfg.auctionId) {
        return { ...d, status: 'memo_mismatch', commitment: null, reason: parsed ? `memo is for auction ${parsed.auctionId}` : 'memo is not sba1:<auction>:<commitment>' };
      }
      if (d.height === null) return { ...d, status: 'pending', commitment: parsed.commitment, reason: 'not mined yet' };
      if (d.height > cfg.closeHeight) return { ...d, status: 'late', commitment: parsed.commitment, reason: `mined at ${d.height}, after close ${cfg.closeHeight}` };
      if (d.value !== cfg.depositZat) return { ...d, status: 'wrong_amount', commitment: parsed.commitment, reason: `${d.value} zat, deposit is ${cfg.depositZat}` };
      if (seen.has(parsed.commitment)) return { ...d, status: 'duplicate', commitment: parsed.commitment, reason: 'commitment already used by an earlier deposit' };
      seen.add(parsed.commitment);
      return { ...d, status: 'valid', commitment: parsed.commitment };
    });
}

export interface Reveal {
  bid: bigint;
  salt: bigint;
  refundAddress: string;
}

export type RevealResult =
  | { ok: true; commitment: string; deposits: ClassifiedDeposit[] }
  | { ok: false; reason: 'altered' | 'bid_over_deposit'; detail: string };

/** Checks a reveal against the deposits. An opening matching no deposit is `altered`. */
export async function checkReveal(cfg: AuctionConfig, deposits: ClassifiedDeposit[], r: Reveal): Promise<RevealResult> {
  const c = await commitment(cfg.auctionId, r.bid, r.salt);
  const mine = deposits.filter((d) => d.commitment === c);
  if (mine.length === 0) return { ok: false, reason: 'altered', detail: 'the opening matches no deposit commitment for this auction' };
  if (r.bid > cfg.depositZat - SETTLEMENT_FEE_BUDGET_ZAT) {
    return { ok: false, reason: 'bid_over_deposit', detail: `bid ${r.bid} exceeds deposit ${cfg.depositZat} minus the fee budget` };
  }
  return { ok: true, commitment: c, deposits: mine };
}

export interface Outcome {
  winnerCommitment: string;
  winningBid: bigint;
  slots: string[];
  proof: object;
  publicSignals: string[];
  /** Valid deposits with no accepted reveal: left out of the proof, published so it is visible. */
  unrevealed: string[];
  /** Each output of the settlement; `memo` names what it pays (see `payoutMemo`). */
  payouts: { address: string; amount: bigint; why: string; memo: string }[];
}

export interface OutcomeCheck {
  ok: boolean;
  checks: Check[];
  winnerTxid: string | null;
  winningBid: bigint;
}

/**
 * Checks a published outcome against classified deposits: the Groth16 proof verifies, and
 * checkResult ties it to exactly these deposits (no phantom slots, the winner is a real deposit,
 * only declared-unrevealed valid deposits are left out).
 */
export async function checkOutcome(
  cfg: AuctionConfig,
  deposits: ClassifiedDeposit[],
  o: { publicSignals: string[]; proof: object; unrevealed?: string[] },
): Promise<OutcomeCheck> {
  const proofOk = await verify(o.publicSignals, o.proof).catch(() => false);
  const r = checkResult({
    auctionId: cfg.auctionId,
    reserve: cfg.reserveZat,
    deposits: deposits.map((d) => ({ ...d, txid: d.ref })),
    unrevealed: o.unrevealed ?? [],
    publicSignals: o.publicSignals,
    emptyCommitment: await emptyCommitment(cfg.auctionId),
  });
  const checks = [{ name: 'proof', ok: proofOk, detail: proofOk ? 'the Groth16 proof verifies with the MaxBid verification key' : 'the Groth16 proof does not verify' }, ...r.checks];
  return { ok: proofOk && r.ok, checks, winnerTxid: r.winnerTxid, winningBid: r.winningBid };
}

/**
 * Picks the winner among valid, revealed deposits (MaxBid proof over them in deposit order) and
 * builds the settlement payouts: seller, winner change, and full refunds for every other revealed
 * deposit (losers, duplicates, late and wrong-amount deposits).
 */
export async function decide(cfg: AuctionConfig, deposits: ClassifiedDeposit[], reveals: Reveal[]): Promise<Outcome> {
  const byCommitment = new Map<string, Reveal>();
  for (const r of reveals) {
    const check = await checkReveal(cfg, deposits, r);
    if (check.ok) byCommitment.set(check.commitment, r);
  }
  const valid = deposits.filter((d) => d.status === 'valid' && byCommitment.has(d.commitment!));
  const unrevealed = deposits.filter((d) => d.status === 'valid' && !byCommitment.has(d.commitment!)).map((d) => d.ref);
  if (valid.length === 0) throw new Error('no valid revealed bid');
  if (valid.length > SLOTS) throw new Error(`more than ${SLOTS} valid bids: the circuit has ${SLOTS} slots`);
  const openings: Opening[] = valid.map((d) => ({ bid: byCommitment.get(d.commitment!)!.bid, salt: byCommitment.get(d.commitment!)!.salt }));
  const w = winnerOf(openings);
  if (openings[w].bid < cfg.reserveZat) throw new Error(`highest bid ${openings[w].bid} is below the reserve ${cfg.reserveZat}: no sale`);
  const input = await inputs(cfg.auctionId, cfg.reserveZat, openings, w);
  const { proof, publicSignals } = await prove(input);
  const self = await checkOutcome(cfg, deposits, { publicSignals, proof, unrevealed });
  if (!self.ok) throw new Error(`internal: the outcome fails its own check: ${self.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`);

  const winner = valid[w];
  const winnerReveal = byCommitment.get(winner.commitment!)!;
  const payouts: Outcome['payouts'] = [{ address: cfg.sellerAddress, amount: openings[w].bid, why: 'winning bid to the seller', memo: payoutMemo(cfg.auctionId, 'seller') }];
  const winnerChange = cfg.depositZat - openings[w].bid - SETTLEMENT_FEE_BUDGET_ZAT;
  if (winnerChange > 0n) payouts.push({ address: winnerReveal.refundAddress, amount: winnerChange, why: 'winner: deposit minus bid and settlement fee', memo: payoutMemo(cfg.auctionId, 'change', winner.ref) });
  for (const d of deposits) {
    if (d === winner || d.commitment === null) continue;
    const r = byCommitment.get(d.commitment);
    if (!r) continue; // no reveal, no refund address: listed in `unrevealed` if it was a valid bid
    if (d.status === 'pending') continue;
    payouts.push({ address: r.refundAddress, amount: d.value, why: `refund (${d.status === 'valid' ? 'losing bid' : d.status} deposit ${d.ref.length > 64 ? `${d.ref.slice(0, 8)}…${d.ref.slice(64)}` : d.ref.slice(0, 8)})`, memo: payoutMemo(cfg.auctionId, 'refund', d.ref) });
  }
  return { winnerCommitment: winner.commitment!, winningBid: openings[w].bid, slots: input.commitments, proof, publicSignals, unrevealed, payouts };
}
