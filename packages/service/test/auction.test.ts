// The auction rules, with real Poseidon commitments and real Groth16 proofs. No chain access here:
// the same functions classify the live testnet deposits in testnet-run.ts.
import { describe, expect, it } from 'vitest';
import { commitment, readPublic, verify } from '@sba/circuits';
import { asDeposits, type DecryptedTx } from '../src/verifier.js';
import { auctionIdFor, checkOutcome, checkReveal, classifyDeposits, decide, depositMemo, parseMemo, SETTLEMENT_FEE_BUDGET_ZAT, type AuctionConfig, type IncomingDeposit } from '../src/auction.js';

const cfg: AuctionConfig = {
  name: 'unit',
  auctionId: auctionIdFor('unit'),
  address: 'utest1auction',
  uivk: 'uivk',
  depositZat: 2_000_000n,
  reserveZat: 500_000n,
  closeHeight: 100,
  sellerAddress: 'utest1seller',
};
const dep = async (txid: string, height: number | null, bid: bigint, salt: bigint, value = cfg.depositZat): Promise<IncomingDeposit> => ({
  txid,
  height,
  value,
  memo: depositMemo(cfg.auctionId, await commitment(cfg.auctionId, bid, salt)),
});

describe('memo format', () => {
  it('round-trips and rejects anything else', () => {
    expect(parseMemo(depositMemo(42n, '123'))).toEqual({ auctionId: 42n, commitment: '123' });
    expect(parseMemo('hello auction')).toBeNull();
    expect(parseMemo('sba1:42:123:extra')).toBeNull();
  });
});

describe('classifyDeposits', () => {
  it('flags late, wrong-amount, memo-mismatch, other-auction, pending and duplicate deposits, in chain order', async () => {
    const a = await dep('aa', 90, 1_000_000n, 1n);
    const dupe = { ...a, txid: 'ab', height: 95 };
    const deposits: IncomingDeposit[] = [
      dupe,
      a,
      await dep('b', 101, 1_100_000n, 2n),
      await dep('c', 91, 1_200_000n, 3n, 500_000n),
      { txid: 'd', height: 92, value: cfg.depositZat, memo: 'hello' },
      { txid: 'e', height: 92, value: cfg.depositZat, memo: depositMemo(cfg.auctionId + 1n, '5') },
      await dep('f', null, 1_300_000n, 4n),
    ];
    const byTx = Object.fromEntries(classifyDeposits(cfg, deposits).map((d) => [d.txid, d.status]));
    expect(byTx).toEqual({ aa: 'valid', ab: 'duplicate', b: 'late', c: 'wrong_amount', d: 'memo_mismatch', e: 'memo_mismatch', f: 'pending' });
  });
});

describe('reveals and settlement', () => {
  it('an altered opening or a bid above the deposit is refused', async () => {
    const d = classifyDeposits(cfg, [await dep('x', 50, 1_000_000n, 9n)]);
    expect((await checkReveal(cfg, d, { bid: 1_000_000n, salt: 9n, refundAddress: 'r' })).ok).toBe(true);
    expect(await checkReveal(cfg, d, { bid: 1_000_001n, salt: 9n, refundAddress: 'r' })).toMatchObject({ ok: false, reason: 'altered' });
    const big = classifyDeposits(cfg, [await dep('y', 50, 1_990_000n, 9n)]);
    expect(await checkReveal(cfg, big, { bid: 1_990_000n, salt: 9n, refundAddress: 'r' })).toMatchObject({ ok: false, reason: 'bid_over_deposit' });
  });

  it('picks the highest valid bid with a verifying proof and refunds everyone else in full', async () => {
    const deposits = classifyDeposits(cfg, [
      await dep('t1', 10, 1_200_000n, 11n),
      await dep('t2', 11, 1_750_000n, 22n),
      await dep('t3', 12, 900_000n, 33n),
      await dep('t4', 120, 1_900_000n, 44n), // late
    ]);
    const o = await decide(cfg, deposits, [
      { bid: 1_200_000n, salt: 11n, refundAddress: 'b1' },
      { bid: 1_750_000n, salt: 22n, refundAddress: 'b2' },
      { bid: 900_000n, salt: 33n, refundAddress: 'b3' },
      { bid: 1_900_000n, salt: 44n, refundAddress: 'b1' },
    ]);
    expect(o.winningBid).toBe(1_750_000n);
    expect(await verify(o.publicSignals, o.proof)).toBe(true);
    expect(readPublic(o.publicSignals).winner).toBe(1);
    expect(o.payouts.map((p) => [p.address, p.amount])).toEqual([
      ['utest1seller', 1_750_000n],
      ['b2', cfg.depositZat - 1_750_000n - SETTLEMENT_FEE_BUDGET_ZAT],
      ['b1', cfg.depositZat],
      ['b3', cfg.depositZat],
      ['b1', cfg.depositZat],
    ]);
  });

  it('refuses to sell below the reserve', async () => {
    const deposits = classifyDeposits(cfg, [await dep('z', 10, 400_000n, 5n)]);
    await expect(decide(cfg, deposits, [{ bid: 400_000n, salt: 5n, refundAddress: 'r' }])).rejects.toThrow(/below the reserve/);
  });
});

describe('unrevealed bids', () => {
  it('a valid deposit with no reveal is declared unrevealed, so the outcome still passes its check; hiding it does not', async () => {
    const deposits = classifyDeposits(cfg, [
      await dep('u1', 10, 1_200_000n, 11n),
      await dep('u2', 11, 1_750_000n, 22n), // never revealed
      await dep('u3', 12, 900_000n, 33n),
    ]);
    const o = await decide(cfg, deposits, [
      { bid: 1_200_000n, salt: 11n, refundAddress: 'b1' },
      { bid: 900_000n, salt: 33n, refundAddress: 'b3' },
    ]);
    expect(o.unrevealed).toEqual(['u2']);
    expect(o.winningBid).toBe(1_200_000n);
    const published = await checkOutcome(cfg, deposits, o);
    expect(published).toMatchObject({ ok: true, winnerTxid: 'u1' });
    // An auctioneer that leaves the deposit out without saying so is caught.
    const hidden = await checkOutcome(cfg, deposits, { ...o, unrevealed: [] });
    expect(hidden.ok).toBe(false);
    expect(hidden.checks.find((c) => !c.ok)?.name).toBe('slots');
  });
});

describe('multi-payment deposits', () => {
  // The shape sba-verify prints for a transaction whose Ironwood bundle pays the auction twice (the
  // Rust test two_payments_to_one_key_in_one_bundle_are_two_outputs builds such a bundle for real).
  const twice = async (memo2: string): Promise<DecryptedTx> => ({
    txid: 'm'.repeat(64),
    height: 20,
    confirmations: 5,
    outputs: [
      { pool: 'Ironwood', index: 2, value: Number(cfg.depositZat), memo: { text: depositMemo(cfg.auctionId, await commitment(cfg.auctionId, 1_100_000n, 7n)) } },
      { pool: 'Ironwood', index: 0, value: Number(cfg.depositZat), memo: { text: memo2 } },
    ],
    pools: { sapling: false, orchard: false, ironwood: true, transparent: false },
  });

  it('a transaction that pays the auction twice is two deposits, each named by its output', async () => {
    const t = await twice(depositMemo(cfg.auctionId, await commitment(cfg.auctionId, 1_300_000n, 8n)));
    const ds = asDeposits(t);
    expect(ds.map((d) => [d.output, d.value])).toEqual([
      ['2', cfg.depositZat],
      ['0', cfg.depositZat],
    ]);
    const classified = classifyDeposits(cfg, ds);
    expect(classified.map((d) => [d.ref, d.status])).toEqual([
      [`${'m'.repeat(64)}:0`, 'valid'],
      [`${'m'.repeat(64)}:2`, 'valid'],
    ]);
    // Both bids compete: the higher one (output 0) wins, the other is refunded in full.
    const o = await decide(cfg, classified, [
      { bid: 1_100_000n, salt: 7n, refundAddress: 'r' },
      { bid: 1_300_000n, salt: 8n, refundAddress: 'r' },
    ]);
    expect(o.winningBid).toBe(1_300_000n);
    expect(o.payouts.filter((p) => p.why.startsWith('refund')).map((p) => p.amount)).toEqual([cfg.depositZat]);
  });

  it('a second payment with the same commitment in the same transaction is a duplicate and is refunded', async () => {
    const first = depositMemo(cfg.auctionId, await commitment(cfg.auctionId, 1_100_000n, 7n));
    const classified = classifyDeposits(cfg, asDeposits(await twice(first)));
    expect(classified.map((d) => d.status)).toEqual(['valid', 'duplicate']);
    const o = await decide(cfg, [...classified, ...classifyDeposits(cfg, [await dep('n', 21, 900_000n, 3n)])], [
      { bid: 1_100_000n, salt: 7n, refundAddress: 'r1' },
      { bid: 900_000n, salt: 3n, refundAddress: 'r2' },
    ]);
    expect(o.winningBid).toBe(1_100_000n);
    expect(o.payouts.map((p) => [p.address, p.amount])).toContainEqual(['r1', cfg.depositZat]);
  });
});
