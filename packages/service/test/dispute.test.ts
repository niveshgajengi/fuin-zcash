// Disputes, in-process: real sealed reveals, real Ed25519 signatures, real Poseidon commitments and
// MaxBid proofs. The chain view (reveal notes, anchors, what a refund key decrypts) is passed as the
// data the audit reads with sba-verify; the live audit test runs a complaint against testnet.
import { describe, expect, it } from 'vitest';
import { commitment } from '@sba/circuits';
import { auctionIdFor, checkOutcome, classifyDeposits, decide, depositMemo, type AuctionConfig } from '../src/auction.js';
import { checkComplaint, checkSharedRefundKeys, complaintAnchor, signComplaint, type Complaint, type ComplaintContext } from '../src/dispute.js';
import { complaintKeyPair, ingestReveals, revealKeyPair, sealReveal, type RevealMessage } from '../src/reveal.js';

const keys = revealKeyPair();
const cfg = {
  name: 'dispute-unit',
  auctionId: auctionIdFor('dispute-unit'),
  address: 'utest1auction',
  uivk: 'uivk',
  depositZat: 2_000_000n,
  reserveZat: 500_000n,
  closeHeight: 100,
  revealCloseHeight: 110,
  sellerAddress: 'utest1seller',
  revealKey: keys.public,
  disputeBlocks: 20,
} satisfies ComplaintContext['cfg'] & AuctionConfig;
const T = (c: string) => c.repeat(64);
const SETTLED = { txid: T('5'), height: 120 };

async function auction() {
  const people = [
    { name: 'alice', txid: T('a'), height: 90, bid: 1_200_000n, salt: 11n, revealAt: 101 },
    { name: 'bob', txid: T('b'), height: 91, bid: 1_750_000n, salt: 22n, revealAt: 102 },
    { name: 'carol', txid: T('c'), height: 92, bid: 900_000n, salt: 33n, revealAt: 111 }, // late reveal
    { name: 'dan', txid: T('d'), height: 93, bid: 1_000_000n, salt: 44n, revealAt: 103, refundTo: 'alice' }, // alice's second bid: same refund address
  ];
  const bidders = await Promise.all(
    people.map(async (p) => {
      const ck = complaintKeyPair();
      const opening = { bid: p.bid, salt: p.salt, refundAddress: `utest1refund${'refundTo' in p ? p.refundTo : p.name}`, complaintKey: ck.public };
      const sealed = sealReveal(cfg.auctionId, keys.public, p.txid, opening);
      const note: RevealMessage = { txid: T(String(people.indexOf(p) + 1)), height: p.revealAt, memo: sealed.memo };
      return { ...p, ck, opening, esk: sealed.esk, note, deposit: { txid: p.txid, height: p.height, value: cfg.depositZat, memo: depositMemo(cfg.auctionId, await commitment(cfg.auctionId, p.bid, p.salt)) } };
    }),
  );
  const deposits = classifyDeposits(cfg, bidders.map((b) => b.deposit));
  const notes = bidders.map((b) => b.note);
  const { reveals, log } = await ingestReveals(cfg, keys.secret, deposits, notes);
  const o = await decide(cfg, deposits, reveals);
  const check = await checkOutcome(cfg, deposits, o);
  const by = Object.fromEntries(bidders.map((b) => [b.name, b]));
  const complaint = (name: string, over: Partial<Complaint> = {}) =>
    signComplaint({ auctionId: cfg.auctionId.toString(), deposit: by[name].txid, reveal: by[name].note.txid, revealSecret: by[name].esk, refundViewingKey: 'uivktest1refund', ...over }, by[name].ck.secret);
  const ctx = (c: Complaint, over: Partial<ComplaintContext> = {}, record: Partial<ComplaintContext['record']> = {}): ComplaintContext => ({
    cfg,
    deposits,
    reveals: notes,
    anchors: [{ txid: T('9'), height: 125, memo: complaintAnchor(c) }],
    record: { reveals: log, unrevealed: o.unrevealed, winnerDeposit: check.winnerTxid, winningBid: o.winningBid, settlement: SETTLED, ...record },
    refund: null,
    ...over,
  });
  return { by, log, o, complaint, ctx };
}

describe('checkComplaint', () => {
  it('an honest auction: a refunded loser and the paid winner both get "unfounded, paid in full"', async () => {
    const { o, complaint, ctx } = await auction();
    expect(o.winningBid).toBe(1_750_000n);
    const alice = complaint('alice');
    const paid = o.payouts.map((p) => ({ address: p.address, valueZat: p.amount, memo: p.memo }));
    const view = (address: string) => ({ keyOwnsAddress: true, outputs: paid.filter((p) => p.address === address) });
    expect(await checkComplaint(alice, ctx(alice, { refund: view('utest1refundalice') }))).toMatchObject({ verdict: 'unfounded', owedZat: 2_000_000n, reasons: [expect.stringMatching(/honoured/), expect.stringMatching(/paid in full/)] });
    const bob = complaint('bob');
    expect(await checkComplaint(bob, ctx(bob, { refund: view('utest1refundbob') }))).toMatchObject({ verdict: 'unfounded', owedZat: 190_000n });
  });

  it('upheld: a valid reveal the record calls tampered, and its deposit declared unrevealed, are both named', async () => {
    const { by, log, complaint, ctx } = await auction();
    const c = complaint('alice');
    const r = await checkComplaint(c, ctx(c, {}, { reveals: log.map((l) => (l.txid === by.alice.note.txid ? { ...l, status: 'tampered' as const } : l)), unrevealed: [by.alice.txid] }));
    expect(r.verdict).toBe('upheld');
    expect(r.reasons.join('\n')).toMatch(/is valid \(it opens with the published secret and hashes to deposit aaaaaaaaaa\) but the record rejects it as tampered/);
    expect(r.reasons.join('\n')).toMatch(/deposit aaaaaaaaaa was revealed by reveal 1111111111 \(block 101\), inside the window, but the outcome declares it unrevealed/);
    // The complaint published the opening: anyone now sees what alice sent.
    expect(r.opening).toMatchObject({ bid: 1_200_000n, refundAddress: 'utest1refundalice' });
  });

  it('upheld: the settlement paid the refund address less than it owes', async () => {
    const { complaint, ctx } = await auction();
    const c = complaint('alice');
    const r = await checkComplaint(c, ctx(c, { refund: { keyOwnsAddress: true, outputs: [] } }));
    expect(r.verdict).toBe('upheld');
    expect(r.reasons[0]).toBe('the refund address received 0 zat in settlement 5555555555, owed 2000000 (2000000 refund of aaaaaaaaaa)');
    // A key that does not own the refund address proves nothing about the payment.
    expect(await checkComplaint(c, ctx(c, { refund: { keyOwnsAddress: false, outputs: [] } }))).toMatchObject({ verdict: 'unfounded', reasons: [expect.any(String), expect.stringMatching(/does not own the refund address/)] });
  });

  it('rejected: signed by any key but the one inside the reveal, or altered after signing', async () => {
    const { by, complaint, ctx } = await auction();
    const forged = signComplaint({ auctionId: cfg.auctionId.toString(), deposit: by.alice.txid, reveal: by.alice.note.txid, revealSecret: by.alice.esk, refundViewingKey: null }, complaintKeyPair().secret);
    expect(await checkComplaint(forged, ctx(forged))).toMatchObject({ verdict: 'rejected', reasons: [expect.stringMatching(/not signed by the complaint key inside reveal/)] });
    const altered = { ...complaint('alice'), refundViewingKey: 'uivktest1someoneelse' };
    expect((await checkComplaint(altered, ctx(altered))).reasons[0]).toMatch(/not signed by the complaint key/);
  });

  it("rejected: a secret that does not open the named reveal, or a reveal that names another deposit", async () => {
    const { by, complaint, ctx } = await auction();
    const wrongSecret = complaint('alice', { revealSecret: by.bob.esk });
    expect((await checkComplaint(wrongSecret, ctx(wrongSecret))).reasons[0]).toMatch(/does not open reveal/);
    const otherDeposit = complaint('alice', { deposit: by.bob.txid });
    expect((await checkComplaint(otherDeposit, ctx(otherDeposit))).reasons[0]).toMatch(/does not name deposit/);
  });

  it('rejected: not anchored on chain, or anchored outside the dispute window', async () => {
    const { complaint, ctx } = await auction();
    const c = complaint('alice');
    expect((await checkComplaint(c, ctx(c, { anchors: [] }))).reasons[0]).toMatch(/not anchored on chain/);
    const late = ctx(c, { anchors: [{ txid: T('9'), height: SETTLED.height + cfg.disputeBlocks + 1, memo: complaintAnchor(c) }] });
    expect((await checkComplaint(c, late)).reasons[0]).toBe(`anchored at block 141, outside the dispute window 121-140`);
    const early = ctx(c, { anchors: [{ txid: T('9'), height: SETTLED.height, memo: complaintAnchor(c) }] });
    expect((await checkComplaint(c, early)).verdict).toBe('rejected');
  });

  it('unfounded: a reveal sent after the window was rightly ignored, even though the deposit is unrevealed', async () => {
    const { by, o, complaint, ctx } = await auction();
    expect(o.unrevealed).toEqual([by.carol.txid]);
    const c = complaint('carol');
    expect(await checkComplaint(c, ctx(c, { refund: { keyOwnsAddress: true, outputs: [] } }))).toMatchObject({ verdict: 'unfounded', reasons: [expect.stringMatching(/the reveal is late .* right to ignore it/)] });
  });

  it('settlement memos name what each output pays, so one paid deposit cannot mask an unpaid one on the same refund address', async () => {
    const { by, o, complaint, ctx } = await auction();
    // alice bid twice (alice, dan) with one refund address; the settlement pays only alice's refund.
    const aliceRefund = o.payouts.find((p) => p.memo === `sba1:${cfg.auctionId}:refund:${by.alice.txid}`)!;
    expect(o.payouts.find((p) => p.memo === `sba1:${cfg.auctionId}:refund:${by.dan.txid}`)).toMatchObject({ address: 'utest1refundalice', amount: 2_000_000n });
    const refund = { keyOwnsAddress: true, outputs: [{ valueZat: aliceRefund.amount, memo: aliceRefund.memo }] };
    const a = complaint('alice');
    expect(await checkComplaint(a, ctx(a, { refund }))).toMatchObject({ verdict: 'unfounded', reasons: [expect.any(String), expect.stringMatching(/^paid in full: the refund address received 2000000 zat in settlement \w+, owed 2000000/)] });
    const d = complaint('dan');
    const r = await checkComplaint(d, ctx(d, { refund }));
    expect(r.verdict).toBe('upheld');
    expect(r.reasons[0]).toBe(`the refund address received 0 zat in settlement 5555555555, owed 2000000 (2000000 refund of dddddddddd); it also received 2000000 zat for other deposits, which do not count`);
  });

  it('legacy settlement memos (`sba1:<id>:settlement`) name nothing: every complaint with the same refund key is summed, and a shortfall is upheld', async () => {
    const { o, complaint, ctx } = await auction();
    // Old-style settlement: one 2,000,000 zat output to alice's address, memo `settlement`, where alice and dan are owed 4,000,000.
    const refund = { keyOwnsAddress: true, outputs: [{ valueZat: 2_000_000n, memo: `sba1:${cfg.auctionId}:settlement` }] };
    const a = complaint('alice');
    const d = complaint('dan');
    const ra = await checkComplaint(a, ctx(a, { refund }));
    const rd = await checkComplaint(d, ctx(d, { refund }));
    // One at a time, each looks paid (2,000,000 received, 2,000,000 owed): that is the masking.
    for (const r of [ra, rd]) expect(r.reasons.join('\n')).toMatch(/legacy settlement memos do not say which deposit an output pays/);
    const shared = checkSharedRefundKeys([
      { name: 'alice.complaint.json', key: a.refundViewingKey, result: ra },
      { name: 'dan.complaint.json', key: d.refundViewingKey, result: rd },
    ], o.payouts.length ? '5'.repeat(64) : '');
    expect(shared).toEqual([
      { names: ['alice.complaint.json', 'dan.complaint.json'], ok: false, line: 'the refund address received 2000000 zat in settlement 5555555555, owed 4000000 (2000000 refund of aaaaaaaaaa + 2000000 refund of dddddddddd) across complaints alice.complaint.json, dan.complaint.json' },
    ]);
    // Paid in full when the key received both refunds.
    const both = { keyOwnsAddress: true, outputs: [refund.outputs[0], refund.outputs[0]] };
    const ok = checkSharedRefundKeys([
      { name: 'alice.complaint.json', key: a.refundViewingKey, result: await checkComplaint(a, ctx(a, { refund: both })) },
      { name: 'dan.complaint.json', key: d.refundViewingKey, result: await checkComplaint(d, ctx(d, { refund: both })) },
    ], '5'.repeat(64));
    expect(ok[0]).toMatchObject({ ok: true, line: expect.stringMatching(/^paid in full: the refund address received 4000000 zat in settlement 5555555555, owed 4000000/) });
  });

  it('a complaint without a refund viewing key is still verified: authentic, anchored and honoured, payment not checked', async () => {
    const { by, log, complaint, ctx } = await auction();
    const c = complaint('alice', { refundViewingKey: null });
    expect(await checkComplaint(c, ctx(c))).toMatchObject({ verdict: 'unfounded', reasons: [expect.stringMatching(/^reveal 1111111111 \(block 101\) was honoured$/), 'payment not checked: the complaint gives no refund viewing key'] });
    // ...and a valid reveal the record calls tampered is upheld without one.
    const r = await checkComplaint(c, ctx(c, {}, { reveals: log.map((l) => (l.txid === by.alice.note.txid ? { ...l, status: 'tampered' as const } : l)) }));
    expect(r.verdict).toBe('upheld');
    expect(r.reasons).toContain('payment not checked: the complaint gives no refund viewing key');
    // Unanchored (or altered) it is still rejected.
    expect((await checkComplaint(c, ctx(c, { anchors: [] }))).verdict).toBe('rejected');
  });
});
