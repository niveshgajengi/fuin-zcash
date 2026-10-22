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
// key, after checking that key owns that address). Settlement memos name the deposit each output pays
// (`sba1:<id>:refund:<deposit>`), so only outputs for this opening's deposits count; a legacy
// settlement (`sba1:<id>:settlement` on every output) is checked per refund key across complaints.
import { createHash, sign as edSign, verify as edVerify } from 'node:crypto';
import { commitment } from '@sba/circuits';
import { depositRef, noSaleAmount, parsePayoutMemo, SETTLEMENT_FEE_BUDGET_ZAT, settledDeposits, type AuctionConfig, type ClassifiedDeposit } from './auction.js';
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
  /** What the published record says; `settlement.height` is the height the settlement was mined at, read from the chain. */
  record: { reveals: RevealLogEntry[]; unrevealed: string[]; winnerDeposit: string | null; winningBid: bigint; settlement: { txid: string; height: number }; noSale?: boolean };
  /** What the settlement paid the refund address, read with `refundViewingKey`; null when no key was given. */
  refund: RefundView | null;
}

/** Every settlement output the refund viewing key decrypts, with its memo. */
export interface RefundView {
  keyOwnsAddress: boolean;
  outputs: { valueZat: bigint; memo: string }[];
}

/**
 * How the payment was checked. `tagged`: the settlement's memos name the deposit each output pays, so
 * only outputs for this opening's deposits count. `legacy`: its memos are all `sba1:<id>:settlement`,
 * so the key's total is compared with what every complaint using that key is owed (`checkSharedRefundKeys`).
 */
export interface PaymentCheck {
  kind: 'tagged' | 'legacy';
  receivedZat: bigint;
  owed: { deposit: string; zat: bigint; part: string }[];
}

export interface ComplaintResult {
  verdict: Verdict;
  /** Why it was rejected, or what the auctioneer did wrong (upheld), or why it is unfounded. */
  reasons: string[];
  /** The opening the complaint made public, when it opened the reveal. */
  opening: SealedOpening | null;
  owedZat: bigint | null;
  /** Set when the payment was read with an owning refund key. */
  payment?: PaymentCheck;
  /** The settlement the payment was read from. */
  settlementTxid?: string;
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

  // What the settlement owes this opening: the winner's change, or every deposit with this commitment
  // back (with no sale, minus each refund's own output fee).
  const owedBy: PaymentCheck['owed'] = [];
  const settledCount = settledDeposits(ctx.deposits).length;
  for (const d of mine) {
    if (ctx.record.noSale) {
      const z = noSaleAmount(d, settledCount);
      if (z > 0n) owedBy.push({ deposit: d.ref, zat: z, part: `${z} no-sale refund of ${short(d.ref)}` });
    } else if (d.ref === ctx.record.winnerDeposit) {
      const change = cfg.depositZat - ctx.record.winningBid - SETTLEMENT_FEE_BUDGET_ZAT;
      if (change > 0n) owedBy.push({ deposit: d.ref, zat: change, part: `${change} winner change for ${short(d.ref)}` });
    } else owedBy.push({ deposit: d.ref, zat: d.value, part: `${d.value} refund of ${short(d.ref)}` });
  }
  const owed = owedBy.reduce((n, x) => n + x.zat, 0n);
  const parts = owedBy.map((x) => x.part);
  const settlementTag = ctx.record.settlement.txid.slice(0, 10);
  const notes: string[] = [];
  let payment: PaymentCheck | undefined;
  if (!ctx.refund) notes.push('payment not checked: the complaint gives no refund viewing key');
  else if (!ctx.refund.keyOwnsAddress) notes.push('payment not checked: the refund viewing key does not own the refund address in the reveal');
  else {
    // Only outputs of this auction's settlement count; a tagged one counts only if it names one of this opening's deposits.
    const outs = ctx.refund.outputs.map((o) => ({ ...o, tag: parsePayoutMemo(o.memo) })).filter((o) => o.tag && o.tag.auctionId === cfg.auctionId);
    const legacy = outs.length > 0 && outs.every((o) => o.tag!.kind === 'legacy');
    if (legacy) {
      const total = outs.reduce((n, o) => n + o.valueZat, 0n);
      payment = { kind: 'legacy', receivedZat: total, owed: owedBy };
      if (total < owed) findings.push(`the refund address received ${total} zat in settlement ${settlementTag}, owed ${owed} (${parts.join(' + ')})`);
      else notes.push(`legacy settlement memos do not say which deposit an output pays: the refund key received ${total} zat in settlement ${settlementTag}, this opening is owed ${owed}; the audit sums every complaint with this key`);
    } else {
      const refs = new Set(mine.map((d) => d.ref));
      const forMine = outs.filter((o) => (o.tag!.kind === 'refund' || o.tag!.kind === 'change') && refs.has(o.tag!.deposit!));
      const received = forMine.reduce((n, o) => n + o.valueZat, 0n);
      const other = ctx.refund.outputs.reduce((n, o) => n + o.valueZat, 0n) - received;
      payment = { kind: 'tagged', receivedZat: received, owed: owedBy };
      const shortfall = owedBy.filter((x) => forMine.filter((o) => o.tag!.deposit === x.deposit).reduce((n, o) => n + o.valueZat, 0n) < x.zat);
      if (received < owed || shortfall.length)
        findings.push(`the refund address received ${received} zat in settlement ${settlementTag}, owed ${owed} (${parts.join(' + ')})${other > 0n ? `; it also received ${other} zat for other deposits, which do not count` : ''}`);
      else notes.push(`paid in full: the refund address received ${received} zat in settlement ${settlementTag}, owed ${owed}${other > 0n ? ` (and ${other} zat for other deposits)` : ''}`);
    }
  }

  const done = (v: Verdict, reasons: string[]): ComplaintResult => ({ ...result(v, reasons, owed), ...(payment ? { payment, settlementTxid: ctx.record.settlement.txid } : {}) });
  return findings.length ? done('upheld', [...findings, ...notes]) : done('unfounded', [`${at} was honoured`, ...notes]);
}

/**
 * Legacy settlements (every memo `sba1:<id>:settlement`) do not say which deposit an output pays, so
 * one paid deposit could hide an unpaid one on the same refund address. This sums what every
 * complaint using the same refund key is owed (each deposit once) and compares it with what that key
 * received in the settlement, once per key.
 */
export function checkSharedRefundKeys(items: { name: string; key: string | null; result: ComplaintResult }[], settlementTxid: string): { names: string[]; ok: boolean; line: string }[] {
  const byKey = new Map<string, { names: string[]; received: bigint; owed: Map<string, { zat: bigint; part: string }> }>();
  for (const { name, key, result } of items) {
    if (!key || result.verdict === 'rejected' || result.payment?.kind !== 'legacy') continue;
    const g = byKey.get(key) ?? { names: [] as string[], received: result.payment.receivedZat, owed: new Map<string, { zat: bigint; part: string }>() };
    g.names.push(name);
    for (const o of result.payment.owed) g.owed.set(o.deposit, { zat: o.zat, part: o.part });
    byKey.set(key, g);
  }
  return [...byKey.values()].map((g) => {
    const owed = [...g.owed.values()].reduce((n, o) => n + o.zat, 0n);
    const across = `${g.names.length > 1 ? 'complaints' : 'complaint'} ${g.names.join(', ')}`;
    const at = `settlement ${settlementTxid.slice(0, 10)}`;
    return g.received < owed
      ? { names: g.names, ok: false, line: `the refund address received ${g.received} zat in ${at}, owed ${owed} (${[...g.owed.values()].map((o) => o.part).join(' + ')}) across ${across}` }
      : { names: g.names, ok: true, line: `paid in full: the refund address received ${g.received} zat in ${at}, owed ${owed} across ${across} (legacy settlement memos: summed per refund key)` };
  });
}
