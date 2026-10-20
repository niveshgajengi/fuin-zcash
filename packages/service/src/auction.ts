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
import { commitment, inputs, prove, SLOTS, verify, winnerOf, type Opening } from '@sba/circuits';

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

/** A received transaction as the auction sees it (from its wallet or from sba-verify). */
export interface IncomingDeposit {
  txid: string;
  height: number | null;
  value: bigint;
  memo: string;
}

export type DepositStatus = 'valid' | 'late' | 'pending' | 'wrong_amount' | 'memo_mismatch' | 'duplicate';

export interface ClassifiedDeposit extends IncomingDeposit {
  status: DepositStatus;
  commitment: string | null;
  reason?: string;
}

/**
 * Classifies deposits in chain order (height, then txid). Only `valid` deposits can win; the first
 * deposit with a given commitment is the bid and later copies are duplicates.
 */
export function classifyDeposits(cfg: AuctionConfig, deposits: IncomingDeposit[]): ClassifiedDeposit[] {
  const seen = new Set<string>();
  return [...deposits]
    .sort((a, b) => (a.height ?? Infinity) - (b.height ?? Infinity) || a.txid.localeCompare(b.txid))
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
  payouts: { address: string; amount: bigint; why: string }[];
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
  if (valid.length === 0) throw new Error('no valid revealed bid');
  if (valid.length > SLOTS) throw new Error(`more than ${SLOTS} valid bids: the circuit has ${SLOTS} slots`);
  const openings: Opening[] = valid.map((d) => ({ bid: byCommitment.get(d.commitment!)!.bid, salt: byCommitment.get(d.commitment!)!.salt }));
  const w = winnerOf(openings);
  if (openings[w].bid < cfg.reserveZat) throw new Error(`highest bid ${openings[w].bid} is below the reserve ${cfg.reserveZat}: no sale`);
  const input = await inputs(cfg.auctionId, cfg.reserveZat, openings, w);
  const { proof, publicSignals } = await prove(input);
  if (!(await verify(publicSignals, proof))) throw new Error('internal: the MaxBid proof does not verify');

  const winner = valid[w];
  const winnerReveal = byCommitment.get(winner.commitment!)!;
  const payouts: Outcome['payouts'] = [{ address: cfg.sellerAddress, amount: openings[w].bid, why: 'winning bid to the seller' }];
  const winnerChange = cfg.depositZat - openings[w].bid - SETTLEMENT_FEE_BUDGET_ZAT;
  if (winnerChange > 0n) payouts.push({ address: winnerReveal.refundAddress, amount: winnerChange, why: 'winner: deposit minus bid and settlement fee' });
  for (const d of deposits) {
    if (d === winner || d.commitment === null) continue;
    const r = byCommitment.get(d.commitment);
    if (!r) continue; // no reveal, no refund address
    if (d.status === 'pending') continue;
    payouts.push({ address: r.refundAddress, amount: d.value, why: `refund (${d.status === 'valid' ? 'losing bid' : d.status} deposit ${d.txid.slice(0, 8)})` });
  }
  return { winnerCommitment: winner.commitment!, winningBid: openings[w].bid, slots: input.commitments, proof, publicSignals, payouts };
}
