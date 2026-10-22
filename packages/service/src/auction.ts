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
// No sale: nothing valid was revealed, or the highest revealed bid is below the reserve. Every
//          revealed deposit is refunded (minus its own output fee), unrevealed ones are forfeited to
//          the seller, and a MaxBid proof with reserve 0 shows the highest bid is below the reserve.
//
// Zcash has no contracts, so the rejections below are enforced by this service; anyone can check
// them with the auction's incoming viewing key (sba-verify) and the published proof.
import { createHash } from 'node:crypto';
import { checkResult, commitment, emptyCommitment, inputs, prove, SLOTS, verify, winnerOf, type Check, type Opening } from '@sba/circuits';

export const MEMO_PREFIX = 'sba1';
export const SETTLEMENT_FEE_BUDGET_ZAT = 60_000n;
/** The marginal ZIP-317 fee of one settlement output (one logical action). */
export const OUTPUT_FEE_ZAT = 5_000n;
/** A forfeited deposit pays the marginal ZIP-317 fee of its own settlement output. */
export const FORFEIT_OUTPUT_FEE_ZAT = OUTPUT_FEE_ZAT;

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

/**
 * Legacy id: 63 bits of sha256(name). Sale 001 and Sale 002 use it. It binds only the name, so the
 * heights, reserve and windows in their records are not bound to the bids (`checkTerms` says so).
 */
export function auctionIdFor(name: string): bigint {
  return BigInt('0x' + createHash('sha256').update(`sba-auction:${name}`).digest('hex').slice(0, 16)) >> 1n;
}

/** Everything an auction card promises bidders. */
export interface AuctionTerms {
  name: string;
  address: string;
  uivk: string;
  depositZat: string;
  reserveZat: string;
  openHeight: number;
  closeHeight: number;
  revealCloseHeight: number | null;
  disputeBlocks: number | null;
  revealKey: string | null;
  seller: string;
}

/** The terms of a published card (record.auction), with absent reveal-channel fields as null. */
export function termsOf(card: { name: string; address: string; uivk: string; depositZat: string; reserveZat: string; openHeight?: number; closeHeight: number; revealCloseHeight?: number; disputeBlocks?: number; revealKey?: string; seller: string }): AuctionTerms {
  if (typeof card.openHeight !== 'number') throw new Error('the card has no openHeight');
  return {
    name: card.name,
    address: card.address,
    uivk: card.uivk,
    depositZat: String(card.depositZat),
    reserveZat: String(card.reserveZat),
    openHeight: card.openHeight,
    closeHeight: card.closeHeight,
    revealCloseHeight: card.revealCloseHeight ?? null,
    disputeBlocks: card.disputeBlocks ?? null,
    revealKey: card.revealKey ?? null,
    seller: card.seller,
  };
}

const TERM_ORDER: (keyof AuctionTerms)[] = ['name', 'address', 'uivk', 'depositZat', 'reserveZat', 'openHeight', 'closeHeight', 'revealCloseHeight', 'disputeBlocks', 'revealKey', 'seller'];

/**
 * The id of an auction whose terms are bound to its bids: 127 bits of sha256 over a canonical
 * encoding of every term. Each deposit memo and the proof's public auction id carry it, so a record
 * whose close, reveal window, reserve or open height was changed after the bids no longer hashes to
 * the id on chain. 127 bits (not 63) so nobody can grind two term sets to one id.
 */
export function termsAuctionId(t: AuctionTerms): bigint {
  const canonical = JSON.stringify(['fuin-terms-v1', ...TERM_ORDER.map((k) => t[k])]);
  return BigInt('0x' + createHash('sha256').update(canonical).digest('hex').slice(0, 32)) >> 1n;
}

/** Does the card's auction id commit to its terms? `legacy`: it hashes only the name (Sales 001 and 002). */
export function checkTerms(card: Parameters<typeof termsOf>[0] & { auctionId: string }): { name: 'terms'; ok: boolean; status: 'bound' | 'legacy' | 'mismatch'; detail: string } {
  const id = BigInt(card.auctionId);
  const want = termsAuctionId(termsOf(card));
  if (id === want) return { name: 'terms', ok: true, status: 'bound', detail: `the auction id is the hash of every term (${TERM_ORDER.join(', ')}), so none of them can change after the bids` };
  if (id === auctionIdFor(card.name))
    return { name: 'terms', ok: true, status: 'legacy', detail: 'legacy: the auction id hashes only its name, so the open, close and reveal heights, the reserve, the deposit and the dispute window are read from the record and are not bound to the bids' };
  return { name: 'terms', ok: false, status: 'mismatch', detail: `the auction id ${id} is not the hash of these terms (that would be ${want}) nor of the name alone: a term was changed after the id was fixed` };
}

export function depositMemo(auctionId: bigint, commitmentDec: string): string {
  return `${MEMO_PREFIX}:${auctionId}:${commitmentDec}`;
}

export function parseMemo(memo: string): { auctionId: bigint; commitment: string } | null {
  const m = memo.trim().match(/^sba1:(\d{1,40}):(\d{1,80})$/);
  return m ? { auctionId: BigInt(m[1]), commitment: m[2] } : null;
}

/**
 * What a settlement output pays, named in its memo so its recipient (and a complaint) can tell which
 * deposit each output settles: `sba1:<auction>:seller`, `sba1:<auction>:change:<deposit>` (the
 * winner's change), `sba1:<auction>:refund:<deposit>`, `sba1:<auction>:forfeit:<deposit>` (an
 * unrevealed deposit, paid to the seller). Settlements before these memos used
 * `sba1:<auction>:settlement` for every output (`legacy`).
 */
export type PayoutKind = 'seller' | 'change' | 'refund' | 'forfeit';
export function payoutMemo(auctionId: bigint, kind: PayoutKind, deposit?: string): string {
  if (kind === 'seller') return `${MEMO_PREFIX}:${auctionId}:seller`;
  if (!deposit) throw new Error(`a ${kind} output names the deposit it pays`);
  return `${MEMO_PREFIX}:${auctionId}:${kind}:${deposit}`;
}
export function parsePayoutMemo(memo: string): { auctionId: bigint; kind: PayoutKind | 'legacy'; deposit: string | null } | null {
  const m = memo.trim().match(/^sba1:(\d{1,40}):(?:(seller|settlement)|(change|refund|forfeit):([0-9a-f]{64}(?::[os]?\d{1,4})?))$/);
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

/** `over_capacity` is no longer assigned when classifying (capacity counts revealed bids, see `competing`); kept so older records parse. */
export type DepositStatus = 'valid' | 'late' | 'pending' | 'wrong_amount' | 'memo_mismatch' | 'duplicate' | 'over_capacity';

/** A deposit's name: its txid, or `txid:<output>` when its transaction pays the auction more than once. */
export const depositRef = (d: { txid: string; output?: string }) => (d.output === undefined ? d.txid : `${d.txid}:${d.output}`);

export interface ClassifiedDeposit extends IncomingDeposit {
  ref: string;
  status: DepositStatus;
  commitment: string | null;
  reason?: string;
}

/**
 * Classifies deposits in chain order (height, then name: within one block, the lexically lower txid
 * comes first, not the transaction mined first). Only `valid` deposits can win; the first deposit
 * with a given commitment is the bid and later copies are duplicates. Each payment is its own
 * deposit, including a second payment in the same transaction. Capacity is not decided here: the
 * proof has SLOTS (8) slots, and they go to the first 8 valid deposits whose reveal was accepted
 * (see `competing`), so a deposit nobody reveals never takes a slot.
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

/**
 * Valid deposits already on chain. Advisory only: a new bid competes unless 8 of the deposits ahead
 * of it are revealed, which nobody can know before the reveal window.
 */
export function validAhead(deposits: ClassifiedDeposit[]): number {
  return deposits.filter((d) => d.status === 'valid').length;
}

/** The proof's slots: the first SLOTS revealed valid deposits in chain order compete; later revealed ones are over capacity. */
export function competing<T extends { status: string }>(revealedValid: T[]): { slots: T[]; overCapacity: T[] } {
  return { slots: revealedValid.slice(0, SLOTS), overCapacity: revealedValid.slice(SLOTS) };
}

/** The deposit carrying `commitment` (the valid one if there is one, else the first in chain order), or null. */
export function depositForCommitment(deposits: ClassifiedDeposit[], commitment: string): ClassifiedDeposit | null {
  return deposits.find((d) => d.commitment === commitment && d.status === 'valid') ?? deposits.find((d) => d.commitment === commitment) ?? null;
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

const shortRef = (ref: string) => (ref.length > 64 ? `${ref.slice(0, 8)}…${ref.slice(64)}` : ref.slice(0, 8));

/**
 * Why an auction ended without a sale. `no_reveal`: no valid deposit was revealed (nothing to prove).
 * `below_reserve`: the highest revealed bid is below the reserve; a MaxBid proof with reserve 0
 * shows which bid is highest and the audit checks that it is below the real reserve.
 */
export interface NoSale {
  reason: 'no_reveal' | 'below_reserve';
  detail: string;
}

export interface Outcome {
  /** Null when the auction sold. */
  noSale: NoSale | null;
  /** Null when there is no sale. */
  winnerCommitment: string | null;
  /** The winning bid; with no sale, the highest revealed bid (below the reserve), or 0 when nothing was revealed. */
  winningBid: bigint;
  slots: string[];
  /** Null only when nothing was revealed. */
  proof: object | null;
  publicSignals: string[] | null;
  /** Valid deposits with no accepted reveal: left out of the proof, published so it is visible. */
  unrevealed: string[];
  /** Each output of the settlement; `memo` names what it pays (see `payoutMemo`). */
  payouts: { address: string; amount: bigint; why: string; memo: string }[];
}

export interface OutcomeCheck {
  ok: boolean;
  checks: Check[];
  /** The winning deposit; null when there is no sale. */
  winnerTxid: string | null;
  winningBid: bigint;
  noSale: NoSale | null;
  /** The deposits whose commitments the proof covers, in slot order. */
  proven: string[];
}

/** What a published outcome carries (the record's `outcome`). */
export interface PublishedOutcome {
  publicSignals: string[] | null;
  proof: object | null;
  unrevealed?: string[];
  noSale?: NoSale | null;
}

/**
 * Checks a published outcome against classified deposits: the Groth16 proof verifies, and
 * checkResult ties it to exactly these deposits (no phantom slots, the winner is a real deposit,
 * only declared-unrevealed valid deposits are left out). A no-sale outcome holds only if nothing
 * valid was revealed (every valid deposit declared unrevealed, no proof), or if its proof, made with
 * reserve 0 over the same slots, shows the highest revealed bid is below the auction's reserve.
 */
export async function checkOutcome(cfg: AuctionConfig, deposits: ClassifiedDeposit[], o: PublishedOutcome): Promise<OutcomeCheck> {
  const unrevealed = o.unrevealed ?? [];
  const noSale = o.noSale ?? null;
  if (noSale?.reason === 'no_reveal') {
    const valid = deposits.filter((d) => d.status === 'valid').map((d) => d.ref);
    const stray = unrevealed.filter((t) => !valid.includes(t));
    const proven = valid.filter((t) => !unrevealed.includes(t));
    const checks: Check[] = [
      { name: 'unrevealed', ok: stray.length === 0, detail: stray.length ? `declared unrevealed but not a valid deposit: ${stray.join(', ')}` : `${unrevealed.length} valid deposit(s) declared unrevealed` },
      {
        name: 'no_sale',
        ok: proven.length === 0 && o.proof === null,
        detail:
          proven.length === 0 && o.proof === null
            ? `no sale: none of the ${valid.length} valid deposit(s) was revealed, so there is no bid to prove`
            : `the outcome says nothing was revealed, but ${proven.length ? `${proven.length} valid deposit(s) are not declared unrevealed` : 'it carries a proof'}`,
      },
    ];
    return { ok: checks.every((c) => c.ok), checks, winnerTxid: null, winningBid: 0n, noSale, proven };
  }
  if (!o.proof || !o.publicSignals) {
    const checks = [{ name: 'proof', ok: false, detail: 'the outcome has no proof' }];
    return { ok: false, checks, winnerTxid: null, winningBid: 0n, noSale, proven: [] };
  }
  const proofOk = await verify(o.publicSignals, o.proof).catch(() => false);
  const r = checkResult({
    auctionId: cfg.auctionId,
    // A no-sale proof is made with reserve 0 (the circuit then only proves which bid is highest).
    reserve: noSale ? 0n : cfg.reserveZat,
    deposits: deposits.map((d) => ({ ...d, txid: d.ref })),
    unrevealed,
    publicSignals: o.publicSignals,
    emptyCommitment: await emptyCommitment(cfg.auctionId),
  });
  const checks = [{ name: 'proof', ok: proofOk, detail: proofOk ? 'the Groth16 proof verifies with the MaxBid verification key' : 'the Groth16 proof does not verify' }, ...r.checks];
  if (noSale) {
    const below = r.winningBid < cfg.reserveZat;
    checks.push({
      name: 'no_sale',
      ok: below && noSale.reason === 'below_reserve',
      detail: below ? `no sale: the highest revealed bid, ${r.winningBid} zat, is below the reserve ${cfg.reserveZat}` : `the outcome says no sale, but the highest revealed bid, ${r.winningBid} zat, meets the reserve ${cfg.reserveZat}`,
    });
  }
  const ok = proofOk && checks.every((c) => c.ok);
  return { ok, checks, winnerTxid: noSale ? null : r.winnerTxid, winningBid: r.winningBid, noSale, proven: r.proven };
}

/** ZIP-317 fee of a shielded transaction: 5,000 zat per logical action, at least two. */
export function zip317Fee(spends: number, outputs: number): bigint {
  return OUTPUT_FEE_ZAT * BigInt(Math.max(2, spends, outputs));
}

/**
 * Can the auction wallet pay these outputs plus the ZIP-317 fee from the deposits it settles? The
 * settlement spends one note per settled deposit and adds a change output when anything is left
 * over. Throws a readable error before anything is broadcast.
 */
export function checkAffordable(deposits: ClassifiedDeposit[], payouts: { amount: bigint }[]): { fundsZat: bigint; paidZat: bigint; feeZat: bigint } {
  const settled = settledDeposits(deposits);
  const funds = settled.reduce((n, d) => n + d.value, 0n);
  const paid = payouts.reduce((n, p) => n + p.amount, 0n);
  const exact = zip317Fee(settled.length, payouts.length);
  const fee = funds - paid === exact ? exact : zip317Fee(settled.length, payouts.length + 1);
  if (funds - paid < fee)
    throw new Error(`the settlement cannot be paid: ${settled.length} deposits hold ${funds} zat, its ${payouts.length} outputs take ${paid} zat and the ZIP-317 fee is ${fee} zat (short by ${fee - (funds - paid)}); nothing was sent`);
  return { fundsZat: funds, paidZat: paid, feeZat: fee };
}

/** Deposits a settlement pays out (a refund, the winner's change or a forfeit): every mined deposit that carries a bid commitment. */
export const settledDeposits = (deposits: ClassifiedDeposit[]) => deposits.filter((d) => d.commitment !== null && d.status !== 'pending');

/**
 * What a no-sale settlement pays for a deposit: its value minus its own output fee, and minus a
 * second one when the settlement has a single output (ZIP-317 charges at least two actions).
 */
export function noSaleAmount(d: { value: bigint }, settledCount: number): bigint {
  const amount = d.value - OUTPUT_FEE_ZAT - (settledCount < 2 ? OUTPUT_FEE_ZAT : 0n);
  return amount > 0n ? amount : 0n;
}

/**
 * Picks the winner among valid, revealed deposits (MaxBid proof over them in deposit order) and
 * builds the settlement payouts: seller, winner change, full refunds of losing bids in the proof,
 * refunds minus their own 5,000 zat output fee for every other revealed deposit (duplicates, late,
 * wrong-amount deposits, and revealed bids after the first 8, which are over capacity), and every unrevealed
 * deposit forfeited to the seller. With no sale (nothing valid revealed, or the highest bid below the
 * reserve) every revealed deposit is refunded minus its own output fee and unrevealed ones are
 * forfeited; `noSale` says why.
 */
export async function decide(cfg: AuctionConfig, deposits: ClassifiedDeposit[], reveals: Reveal[]): Promise<Outcome> {
  const byCommitment = new Map<string, Reveal>();
  for (const r of reveals) {
    const check = await checkReveal(cfg, deposits, r);
    if (check.ok) byCommitment.set(check.commitment, r);
  }
  // Deposits are in chain order (classifyDeposits); the first 8 revealed valid ones take the slots.
  const { slots: valid, overCapacity } = competing(deposits.filter((d) => d.status === 'valid' && byCommitment.has(d.commitment!)));
  const over = new Set(overCapacity.map((d) => d.ref));
  const unrevealed = deposits.filter((d) => d.status === 'valid' && !byCommitment.has(d.commitment!)).map((d) => d.ref);
  if (valid.length === 0) {
    const noSale: NoSale = { reason: 'no_reveal', detail: 'no valid deposit was revealed' };
    const payouts = noSalePayouts(cfg, deposits, byCommitment);
    checkAffordable(deposits, payouts);
    return { noSale, winnerCommitment: null, winningBid: 0n, slots: [], proof: null, publicSignals: null, unrevealed, payouts };
  }
  const openings: Opening[] = valid.map((d) => ({ bid: byCommitment.get(d.commitment!)!.bid, salt: byCommitment.get(d.commitment!)!.salt }));
  const w = winnerOf(openings);
  if (openings[w].bid < cfg.reserveZat) {
    // Prove which bid is highest with reserve 0; the audit checks that bid is below the real reserve.
    const input = await inputs(cfg.auctionId, 0n, openings, w);
    const { proof, publicSignals } = await prove(input);
    const noSale: NoSale = { reason: 'below_reserve', detail: `the highest revealed bid, ${openings[w].bid} zat, is below the reserve ${cfg.reserveZat}` };
    const self = await checkOutcome(cfg, deposits, { publicSignals, proof, unrevealed, noSale });
    if (!self.ok) throw new Error(`internal: the no-sale outcome fails its own check: ${self.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`);
    const payouts = noSalePayouts(cfg, deposits, byCommitment);
    checkAffordable(deposits, payouts);
    return { noSale, winnerCommitment: null, winningBid: openings[w].bid, slots: input.commitments, proof, publicSignals, unrevealed, payouts };
  }
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
    const kind = over.has(d.ref) ? 'over-capacity bid' : d.status === 'valid' ? 'losing bid' : d.status;
    // A losing bid in the proof is refunded in full; anything else (a non-bid or an over-capacity bid)
    // pays its own output's fee, so no number of them can make the settlement unaffordable.
    const amount = d.status === 'valid' && !over.has(d.ref) ? d.value : d.value - OUTPUT_FEE_ZAT;
    if (amount <= 0n) continue;
    payouts.push({ address: r.refundAddress, amount, why: `refund (${kind} deposit ${shortRef(d.ref)})${amount < d.value ? `, minus its ${OUTPUT_FEE_ZAT} zat output fee` : ''}`, memo: payoutMemo(cfg.auctionId, 'refund', d.ref) });
  }
  payouts.push(...forfeits(cfg, deposits, byCommitment));
  checkAffordable(deposits, payouts);
  return { noSale: null, winnerCommitment: winner.commitment!, winningBid: openings[w].bid, slots: input.commitments, proof, publicSignals, unrevealed, payouts };
}

// A deposit nobody revealed has no refund address. It goes to the seller, not to the auctioneer, so
// the auctioneer gains nothing by making a reveal fail. (Memo mismatches are not bids: they stay.)
function forfeits(cfg: AuctionConfig, deposits: ClassifiedDeposit[], byCommitment: Map<string, Reveal>, amountOf = (d: ClassifiedDeposit) => d.value - FORFEIT_OUTPUT_FEE_ZAT): Outcome['payouts'] {
  const out: Outcome['payouts'] = [];
  for (const d of settledDeposits(deposits)) {
    if (byCommitment.has(d.commitment!)) continue;
    const amount = amountOf(d);
    if (amount > 0n) out.push({ address: cfg.sellerAddress, amount, why: `forfeit (unrevealed ${d.status === 'valid' ? 'bid' : d.status} deposit ${shortRef(d.ref)}) to the seller, minus its ${d.value - amount} zat output fee`, memo: payoutMemo(cfg.auctionId, 'forfeit', d.ref) });
  }
  return out;
}

/** No sale: every revealed deposit back to its refund address and every unrevealed one to the seller, each minus its own output fee. */
function noSalePayouts(cfg: AuctionConfig, deposits: ClassifiedDeposit[], byCommitment: Map<string, Reveal>): Outcome['payouts'] {
  const settled = settledDeposits(deposits);
  const payouts: Outcome['payouts'] = [];
  for (const d of settled) {
    const r = byCommitment.get(d.commitment!);
    const amount = noSaleAmount(d, settled.length);
    if (!r || amount === 0n) continue;
    payouts.push({ address: r.refundAddress, amount, why: `refund, no sale (${d.status === 'valid' ? 'bid' : d.status} deposit ${shortRef(d.ref)}), minus its ${d.value - amount} zat output fee`, memo: payoutMemo(cfg.auctionId, 'refund', d.ref) });
  }
  payouts.push(...forfeits(cfg, deposits, byCommitment, (d) => noSaleAmount(d, settled.length)));
  return payouts;
}

/**
 * What the seller is owed by a settlement: the winning bid (`seller` output, none with no sale) and,
 * under the current rules, one `forfeit:<deposit>` output per settled deposit nobody revealed. Legacy
 * sales (Sales 001 and 002, before forfeits and tagged memos) owe the winning bid only.
 */
export function sellerOwed(
  deposits: ClassifiedDeposit[],
  o: { winningBid: bigint; noSale: boolean; revealedCommitments: Set<string>; legacy: boolean },
): { seller: bigint; forfeits: { deposit: string; zat: bigint }[] } {
  const seller = o.noSale ? 0n : o.winningBid;
  if (o.legacy) return { seller, forfeits: [] };
  const settled = settledDeposits(deposits);
  const forfeits = settled
    .filter((d) => !o.revealedCommitments.has(d.commitment!))
    .map((d) => ({ deposit: d.ref, zat: o.noSale ? noSaleAmount(d, settled.length) : d.value - FORFEIT_OUTPUT_FEE_ZAT }))
    .filter((f) => f.zat > 0n);
  return { seller, forfeits };
}

/**
 * Checks what the seller's incoming viewing key decrypts in the settlement against `sellerOwed`.
 * Tagged memos: the `seller` output must equal the winning bid and each forfeit must be paid under its
 * own memo. Legacy memos (`sba1:<id>:settlement`) name nothing, so their total must equal what is owed.
 */
export function checkSellerPayout(auctionId: bigint, outputs: { valueZat: bigint; memo: string }[], owed: ReturnType<typeof sellerOwed>): { ok: boolean; lines: { ok: boolean; line: string }[] } {
  const mine = outputs.map((o) => ({ ...o, tag: parsePayoutMemo(o.memo) })).filter((o) => o.tag && o.tag.auctionId === auctionId);
  const total = (xs: { valueZat: bigint }[]) => xs.reduce((n, x) => n + x.valueZat, 0n);
  const owedTotal = owed.seller + owed.forfeits.reduce((n, f) => n + f.zat, 0n);
  const lines: { ok: boolean; line: string }[] = [];
  if (mine.length > 0 && mine.every((o) => o.tag!.kind === 'legacy')) {
    const got = total(mine);
    lines.push({ ok: got === owedTotal, line: `seller received ${got} zat, owed ${owedTotal} (legacy settlement memos: compared in total)` });
  } else {
    const sellerGot = total(mine.filter((o) => o.tag!.kind === 'seller'));
    if (owed.seller > 0n || sellerGot > 0n) lines.push({ ok: sellerGot === owed.seller, line: `seller received ${sellerGot} zat, owed ${owed.seller} (the winning bid)` });
    for (const f of owed.forfeits) {
      const got = total(mine.filter((o) => o.tag!.kind === 'forfeit' && o.tag!.deposit === f.deposit));
      lines.push({ ok: got === f.zat, line: `forfeit of ${f.deposit.slice(0, 10)}: seller received ${got} zat, owed ${f.zat}` });
    }
    if (lines.length === 0) lines.push({ ok: true, line: 'the seller is owed nothing and received nothing' });
  }
  return { ok: lines.every((l) => l.ok), lines };
}
