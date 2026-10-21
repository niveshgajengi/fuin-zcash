// Disputes. After the settlement, a bidder whose reveal was ignored, or who was not paid what it is
// owed, files a signed complaint. The complaint publishes the reveal's ephemeral secret, so anyone
// can decrypt that one on-chain reveal with the auction's public reveal key and see exactly what the
// bidder sent and when. It is signed with the complaint key the bidder put inside that reveal, so
// only the bidder who sent it can file it (the auctioneer saw the public half, never the secret).
// Its SHA-256 is anchored on chain in a memo to the auction address (`sba1d:<auction>:<digest>`)
// inside the dispute window, which timestamps it.
//
// Filing a complaint makes the bidder's own opening public (its bid, salt and refund address): that
// is the price of proving censorship, and the bidder chooses to pay it.
//
// The audit checks a complaint against the chain: the reveal note, its height against the reveal
// window, the deposit's commitment, the record's treatment of that reveal, the outcome's unrevealed
// list, and what the settlement paid the refund address (read with the refund address's own viewing
// key, after checking that key owns that address).
import { createHash, sign as edSign, verify as edVerify } from 'node:crypto';
import { commitment } from '@sba/circuits';
import { depositRef, SETTLEMENT_FEE_BUDGET_ZAT, type AuctionConfig, type ClassifiedDeposit } from './auction.js';
import { edPrivate, edPublic, openRevealWithEsk, parseRevealMemo, publicRevealStatus, type RevealLogEntry, type RevealMessage, type RevealWindow, type SealedOpening } from './reveal.js';

export const COMPLAINT_PREFIX = 'sba1d';
export const COMPLAINT_KIND = 'fuin-complaint-v1';

export interface Complaint {
  kind: typeof COMPLAINT_KIND;
  auctionId: string;
  /** The deposit the reveal opened. */
  deposit: string;
  /** The reveal note (txid, or txid:<output>). */
  reveal: string;
  /** The reveal's ephemeral secret (hex): publishing it opens that reveal for everyone. */
  revealSecret: string;
  /** Incoming viewing key of the refund address, so the audit can read what the settlement paid it. */
  refundViewingKey: string | null;
  /** Ed25519 (hex) by the complaint key inside the reveal, over `complaintBody`. */
  signature: string;
}

const body = (c: Omit<Complaint, 'signature'>) =>
  Buffer.from(JSON.stringify([c.kind, c.auctionId, c.deposit, c.reveal, c.revealSecret, c.refundViewingKey]));

export function signComplaint(c: Omit<Complaint, 'signature' | 'kind'>, complaintSecret: string): Complaint {
  const unsigned = { kind: COMPLAINT_KIND, ...c } as const;
  return { ...unsigned, signature: edSign(null, body(unsigned), edPrivate(Buffer.from(complaintSecret, 'hex'))).toString('hex') };
}

export const complaintDigest = (c: Complaint) => createHash('sha256').update(body(c)).update(c.signature).digest('hex');
/** The memo that anchors a complaint on chain (sent to the auction address in the dispute window). */
export const complaintAnchor = (c: Complaint) => `${COMPLAINT_PREFIX}:${c.auctionId}:${complaintDigest(c)}`;

export type Verdict = 'rejected' | 'unfounded' | 'upheld';

export interface ComplaintContext {
  cfg: AuctionConfig & RevealWindow & { revealKey: string; disputeBlocks: number };
  /** Every deposit, from the chain scan. */
  deposits: ClassifiedDeposit[];
  /** Every reveal note, from the chain scan. */
  reveals: RevealMessage[];
  /** Every complaint anchor note (sba1d), from the chain scan after the settlement. */
  anchors: RevealMessage[];
  /** What the published record says. */
  record: { reveals: RevealLogEntry[]; unrevealed: string[]; winnerDeposit: string | null; winningBid: bigint; settlement: { txid: string; height: number } };
  /** What the settlement paid the refund address, read with `refundViewingKey`; null when no key was given. */
  refund: { keyOwnsAddress: boolean; receivedZat: bigint } | null;
}

export interface ComplaintResult {
  verdict: Verdict;
  /** Why it was rejected, or what the auctioneer did wrong (upheld), or why it is unfounded. */
  reasons: string[];
  /** The opening the complaint made public, when it opened the reveal. */
  opening: SealedOpening | null;
  owedZat: bigint | null;
}

const short = (ref: string) => (ref.length > 64 ? `${ref.slice(0, 10)}…${ref.slice(64)}` : ref.slice(0, 10));
const byChain = (a: { height: number | null; ref: string }, b: { height: number | null; ref: string }) => (a.height ?? Infinity) - (b.height ?? Infinity) || a.ref.localeCompare(b.ref);

/**
 * Checks one complaint. `rejected`: it does not prove anything (not anchored in the window, the
 * secret does not open the named reveal, or it is not signed by the key inside that reveal).
 * `unfounded`: it is authentic, but the auctioneer treated the reveal correctly and paid in full (or
 * the reveal was itself invalid). `upheld`: the reveal was valid and the record or the settlement
 * did not honour it; each reason names the failure.
 */
export async function checkComplaint(c: Complaint, ctx: ComplaintContext): Promise<ComplaintResult> {
  const { cfg } = ctx;
  const reject = (why: string): ComplaintResult => ({ verdict: 'rejected', reasons: [why], opening: null, owedZat: null });
  if (c.kind !== COMPLAINT_KIND || c.auctionId !== cfg.auctionId.toString()) return reject(`not a complaint about auction ${cfg.auctionId}`);

  const from = ctx.record.settlement.height + 1;
  const to = ctx.record.settlement.height + cfg.disputeBlocks;
  const anchor = complaintAnchor(c);
  const anchored = ctx.anchors.filter((m) => m.memo === anchor).sort((a, b) => (a.height ?? Infinity) - (b.height ?? Infinity));
  const inWindow = anchored.find((m) => m.height !== null && m.height >= from && m.height <= to);
  if (!inWindow) {
    return reject(anchored.length ? `anchored at block ${anchored[0].height ?? 'mempool'}, outside the dispute window ${from}-${to}` : `not anchored on chain: no ${COMPLAINT_PREFIX} memo with its digest pays the auction`);
  }

  const note = ctx.reveals.find((m) => depositRef(m) === c.reveal);
  if (!note) return reject(`no reveal note ${short(c.reveal)} pays the auction`);
  const parsed = parseRevealMemo(note.memo);
  if (!parsed || parsed.deposit !== c.deposit) return reject(`reveal ${short(c.reveal)} does not name deposit ${short(c.deposit)}`);
  let opening: SealedOpening;
  try {
    opening = openRevealWithEsk(cfg.revealKey, c.revealSecret, parsed);
  } catch (e) {
    return reject(`the published reveal secret does not open reveal ${short(c.reveal)}: ${(e as Error).message}`);
  }
  const { signature, ...unsigned } = c;
  const sigOk = /^[0-9a-f]{128}$/.test(signature) && edVerify(null, body(unsigned), edPublic(Buffer.from(opening.complaintKey, 'hex')), Buffer.from(signature, 'hex'));
  if (!sigOk) return reject(`not signed by the complaint key inside reveal ${short(c.reveal)}`);

  const result = (verdict: Verdict, reasons: string[], owedZat: bigint | null = null): ComplaintResult => ({ verdict, reasons, opening, owedZat });
  const pub = publicRevealStatus(cfg, ctx.deposits, note);
  if (pub.status !== null) return result('unfounded', [`the reveal is ${pub.status} (${pub.reason}), so the auctioneer was right to ignore it`]);
  const deposit = ctx.deposits.find((d) => d.ref === c.deposit)!;
  const c0 = await commitment(cfg.auctionId, opening.bid, opening.salt);
  if (c0 !== deposit.commitment) return result('unfounded', [`the opening does not hash to deposit ${short(c.deposit)}'s commitment`]);
  if (opening.bid > cfg.depositZat - SETTLEMENT_FEE_BUDGET_ZAT) return result('unfounded', ['the bid exceeds the deposit minus the fee budget']);

  // The reveal was valid. Did the record honour it?
  const findings: string[] = [];
  const at = `reveal ${short(c.reveal)} (block ${note.height})`;
  const rec = ctx.record.reveals.find((r) => r.ref === c.reveal);
  if (!rec) findings.push(`${at} is valid but the record leaves it out`);
  else if (['tampered', 'wrong_commitment', 'bid_over_deposit'].includes(rec.status)) findings.push(`${at} is valid (it opens with the published secret and hashes to deposit ${short(c.deposit)}) but the record rejects it as ${rec.status}`);
  else if (rec.status === 'conflicting') {
    const sameCommitment = new Set(ctx.deposits.filter((d) => d.commitment === c0).map((d) => d.ref));
    const earlier = ctx.record.reveals.filter((r) => r.status === 'accepted' && r.deposit && sameCommitment.has(r.deposit)).some((r) => byChain(r, { height: note.height, ref: c.reveal }) < 0);
    if (!earlier) findings.push(`${at} is the first valid opening of its commitment, but the record calls it conflicting`);
  }
  const mine = ctx.deposits.filter((d) => d.commitment === c0 && d.status !== 'memo_mismatch' && d.status !== 'pending');
  for (const d of mine) if (d.status === 'valid' && ctx.record.unrevealed.includes(d.ref)) findings.push(`deposit ${short(d.ref)} was revealed by ${at}, inside the window, but the outcome declares it unrevealed`);

  // What the settlement owes this opening: the winner's change, or every deposit with this commitment back.
  let owed = 0n;
  const parts: string[] = [];
  for (const d of mine) {
    if (d.ref === ctx.record.winnerDeposit) {
      const change = cfg.depositZat - ctx.record.winningBid - SETTLEMENT_FEE_BUDGET_ZAT;
      if (change > 0n) {
        owed += change;
        parts.push(`${change} winner change for ${short(d.ref)}`);
      }
    } else {
      owed += d.value;
      parts.push(`${d.value} refund of ${short(d.ref)}`);
    }
  }
  const notes: string[] = [];
  if (!ctx.refund) notes.push('payment not checked: the complaint gives no refund viewing key');
  else if (!ctx.refund.keyOwnsAddress) notes.push('payment not checked: the refund viewing key does not own the refund address in the reveal');
  else if (ctx.refund.receivedZat < owed) findings.push(`the refund address received ${ctx.refund.receivedZat} zat in settlement ${ctx.record.settlement.txid.slice(0, 10)}, owed ${owed} (${parts.join(' + ')})`);
  else notes.push(`paid in full: the refund address received ${ctx.refund.receivedZat} zat in settlement ${ctx.record.settlement.txid.slice(0, 10)}, owed ${owed}`);

  return findings.length ? result('upheld', [...findings, ...notes], owed) : result('unfounded', [`${at} was honoured`, ...notes], owed);
}
