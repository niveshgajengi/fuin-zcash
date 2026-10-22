// The auction rules, with real Poseidon commitments and real Groth16 proofs. No chain access here:
// the same functions classify the live testnet deposits in testnet-run.ts.
import { describe, expect, it } from 'vitest';
import { checkResult, commitment, emptyCommitment, readPublic, verify } from '@sba/circuits';
import { asDeposits, type DecryptedTx } from '../src/verifier.js';
import { complaintKeyPair, parseRevealMemo, revealKeyPair, sealReveal } from '../src/reveal.js';
import { auctionIdFor, checkOutcome, checkReveal, checkTerms, classifyDeposits, decide, depositForCommitment, depositMemo, FORFEIT_OUTPUT_FEE_ZAT, openSlots, parseMemo, parsePayoutMemo, SETTLEMENT_FEE_BUDGET_ZAT, termsAuctionId, termsOf, type AuctionConfig, type IncomingDeposit } from '../src/auction.js';

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

describe('depositForCommitment (how MCP reveal finds a deposit whose send reported no txid)', () => {
  it('picks the valid deposit with that commitment over an earlier non-valid copy, and null when none carries it', async () => {
    const wrong = await dep('w1', 10, 1_000_000n, 1n, 500_000n); // same commitment, wrong amount, mined first
    const good = { ...wrong, txid: 'w2', height: 11, value: cfg.depositZat };
    const late = { ...wrong, txid: 'w3', height: 150, value: cfg.depositZat };
    const classified = classifyDeposits(cfg, [late, good, wrong]);
    const c = parseMemo(wrong.memo)!.commitment;
    expect(depositForCommitment(classified, c)).toMatchObject({ ref: 'w2', status: 'valid' });
    expect(depositForCommitment(classified.filter((d) => d.txid !== 'w2'), c)).toMatchObject({ ref: 'w1', status: 'wrong_amount' });
    expect(depositForCommitment(classified, '123')).toBeNull();
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
    // Each output's memo names what it pays, so a recipient (and a complaint) can tell its outputs apart.
    expect(o.payouts.map((p) => p.memo)).toEqual([`sba1:${cfg.auctionId}:seller`, `sba1:${cfg.auctionId}:change:t2`, `sba1:${cfg.auctionId}:refund:t1`, `sba1:${cfg.auctionId}:refund:t3`, `sba1:${cfg.auctionId}:refund:t4`]);
    expect(parsePayoutMemo(o.payouts[2].memo)).toBeNull(); // 't1' is not a txid: parsing accepts only real deposit names
    expect(parsePayoutMemo(`sba1:${cfg.auctionId}:refund:${'a'.repeat(64)}:2`)).toEqual({ auctionId: cfg.auctionId, kind: 'refund', deposit: `${'a'.repeat(64)}:2` });
    expect(parsePayoutMemo(`sba1:${cfg.auctionId}:settlement`)).toEqual({ auctionId: cfg.auctionId, kind: 'legacy', deposit: null });
  });

  it('refuses to sell below the reserve', async () => {
    const deposits = classifyDeposits(cfg, [await dep('z', 10, 400_000n, 5n)]);
    await expect(decide(cfg, deposits, [{ bid: 400_000n, salt: 5n, refundAddress: 'r' }])).rejects.toThrow(/below the reserve/);
  });
});

describe('ties', () => {
  it('two equal bids in one block: the lexically lower txid takes the earlier slot and wins, whatever order the block holds them in', async () => {
    // 'f0…' was (say) first in the block and 'a0…' second; the order passed in is the block order.
    const first = await dep('f0'.padEnd(64, '0'), 10, 1_500_000n, 1n);
    const second = await dep('a0'.padEnd(64, '0'), 10, 1_500_000n, 2n);
    const deposits = classifyDeposits(cfg, [first, second]);
    expect(deposits.map((d) => d.txid.slice(0, 2))).toEqual(['a0', 'f0']);
    const o = await decide(cfg, deposits, [
      { bid: 1_500_000n, salt: 1n, refundAddress: 'first-in-block' },
      { bid: 1_500_000n, salt: 2n, refundAddress: 'second-in-block' },
    ]);
    expect(readPublic(o.publicSignals).winner).toBe(0);
    expect(o.payouts.find((p) => p.memo.includes(':change:'))?.address).toBe('second-in-block');
  });
});

describe('capacity: the proof has 8 slots', () => {
  it('nine valid revealed bids: the first 8 in chain order compete, the 9th is over_capacity and refunded; the outcome passes its check', async () => {
    const bids = [1_100_000n, 1_200_000n, 900_000n, 1_300_000n, 1_000_000n, 800_000n, 1_250_000n, 700_000n, 1_900_000n];
    const deposits = classifyDeposits(cfg, await Promise.all(bids.map((b, i) => dep(`k${i}`, 10 + i, b, BigInt(100 + i)))));
    expect(deposits.map((d) => d.status)).toEqual([...Array(8).fill('valid'), 'over_capacity']);
    expect(deposits[8].reason).toBe('the auction already had 8 valid bids (the proof has 8 slots): refunded if revealed, cannot win');
    expect(openSlots(deposits)).toBe(0);
    expect(openSlots(deposits.slice(0, 5))).toBe(3);
    const o = await decide(cfg, deposits, bids.map((b, i) => ({ bid: b, salt: BigInt(100 + i), refundAddress: `r${i}` })));
    // 1,900,000 would be the highest, but it arrived after the eighth valid bid: 1,300,000 wins.
    expect(o.winningBid).toBe(1_300_000n);
    expect(await verify(o.publicSignals, o.proof)).toBe(true);
    expect(o.payouts.find((p) => p.address === 'r8')).toMatchObject({ amount: cfg.depositZat, why: 'refund (over_capacity deposit k8)' });
    expect(await checkOutcome(cfg, deposits, o)).toMatchObject({ ok: true, winnerTxid: 'k3' });
    // A record that does not apply the cap (the 9th called valid) fails the slot check.
    const uncapped = deposits.map((d) => ({ ...d, txid: d.ref, status: 'valid' }));
    const r = checkResult({ auctionId: cfg.auctionId, reserve: cfg.reserveZat, deposits: uncapped, unrevealed: [], publicSignals: o.publicSignals, emptyCommitment: await emptyCommitment(cfg.auctionId) });
    expect(r.checks.find((c) => c.name === 'slots')).toMatchObject({ ok: false, detail: expect.stringMatching(/9 revealed valid deposits, the circuit has 8 slots/) });
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
    // The unrevealed deposit is forfeited to the seller, not kept by the auctioneer, so a failed reveal earns the auctioneer nothing.
    expect(o.payouts.filter((p) => p.memo.includes(':forfeit:'))).toEqual([
      { address: 'utest1seller', amount: cfg.depositZat - FORFEIT_OUTPUT_FEE_ZAT, why: 'forfeit (unrevealed bid deposit u2) to the seller, minus its 5000 zat output fee', memo: `sba1:${cfg.auctionId}:forfeit:u2` },
    ]);
    expect(o.payouts.reduce((n, p) => n + p.amount, 0n)).toBe(3n * cfg.depositZat - SETTLEMENT_FEE_BUDGET_ZAT - FORFEIT_OUTPUT_FEE_ZAT);
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

describe('auction terms bound to the id', () => {
  const card = {
    name: 'terms-unit',
    address: 'utest1auction',
    uivk: 'uivktest1auction',
    depositZat: '2000000',
    reserveZat: '500000',
    openHeight: 80,
    closeHeight: 100,
    revealCloseHeight: 124,
    disputeBlocks: 60,
    revealKey: 'ab'.repeat(32),
    seller: 'utest1seller',
  };
  const id = termsAuctionId(termsOf(card));

  it('the auction id is a hash of every term: change any one after the fact and the record no longer matches its id', () => {
    expect(id).toBeLessThan(1n << 127n);
    expect(id).toBeGreaterThan(1n << 64n); // far wider than the legacy 63-bit name hash, so two term sets cannot be ground to one id
    expect(checkTerms({ ...card, auctionId: id.toString() })).toMatchObject({ status: 'bound', ok: true });
    const edits: [string, unknown][] = [
      ['closeHeight', 101],
      ['revealCloseHeight', 4526463],
      ['reserveZat', '400000'],
      ['openHeight', 81],
      ['disputeBlocks', 1],
      ['revealKey', 'cd'.repeat(32)],
      ['seller', 'utest1other'],
      ['depositZat', '1000000'],
      ['address', 'utest1elsewhere'],
      ['uivk', 'uivktest1other'],
    ];
    for (const [k, v] of edits) {
      const r = checkTerms({ ...card, [k]: v, auctionId: id.toString() });
      expect(r, k).toMatchObject({ status: 'mismatch', ok: false, name: 'terms' });
      expect(r.detail).toContain(`auction id ${id} is not the hash of these terms`);
    }
    // Auctions created before the binding hash only their name: flagged, not passed off as bound.
    expect(checkTerms({ ...card, auctionId: auctionIdFor(card.name).toString() })).toMatchObject({ status: 'legacy', ok: true, detail: expect.stringMatching(/^legacy: the auction id hashes only its name/) });
  });

  it('a 127-bit terms id fits the deposit memo, a reveal memo naming a multi-output deposit, and a real MaxBid proof', async () => {
    const cfgT: AuctionConfig = { ...cfg, auctionId: id };
    const c = await commitment(id, 1_000_000n, 9n);
    expect(parseMemo(depositMemo(id, c))).toEqual({ auctionId: id, commitment: c });
    const keys = revealKeyPair();
    const sealed = sealReveal(id, keys.public, `${'f'.repeat(64)}:o12`, { bid: 1_000_000n, salt: 9n, refundAddress: 'utest1' + 'x'.repeat(144), complaintKey: complaintKeyPair().public });
    expect(Buffer.byteLength(sealed.memo)).toBeLessThanOrEqual(512);
    expect(parseRevealMemo(sealed.memo)?.auctionId).toBe(id);
    const deposits = classifyDeposits(cfgT, [
      { txid: 'v1'.padEnd(64, '0'), height: 90, value: cfgT.depositZat, memo: depositMemo(id, c) },
      { txid: 'v2'.padEnd(64, '0'), height: 91, value: cfgT.depositZat, memo: depositMemo(id, await commitment(id, 1_200_000n, 8n)) },
    ]);
    const o = await decide(cfgT, deposits, [
      { bid: 1_000_000n, salt: 9n, refundAddress: 'r1' },
      { bid: 1_200_000n, salt: 8n, refundAddress: 'r2' },
    ]);
    expect(await verify(o.publicSignals, o.proof)).toBe(true);
    expect(readPublic(o.publicSignals).auctionId).toBe(id);
  });
});
