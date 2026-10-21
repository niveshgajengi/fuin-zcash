// checkResult ties a MaxBid proof to the auction's deposits. Real Groth16 proofs; the attacks are
// proofs an auctioneer could really produce, which verify but are about the wrong deposits.
import { describe, expect, it } from 'vitest';
import { checkResult, commitment, emptyCommitment, inputs, prove, verify, type Opening, type ResultDeposit } from '../src/maxbid.js';

const AUCTION = 777n;
const RESERVE = 500_000n;
const real: Opening[] = [
  { bid: 1_200_000n, salt: 11n },
  { bid: 1_750_000n, salt: 22n },
  { bid: 900_000n, salt: 33n },
];

async function deposits(): Promise<ResultDeposit[]> {
  const d: ResultDeposit[] = [];
  for (const [i, o] of real.entries()) d.push({ txid: `t${i + 1}`, height: 10 + i, status: 'valid', commitment: await commitment(AUCTION, o.bid, o.salt) });
  d.push({ txid: 'late', height: 99, status: 'late', commitment: await commitment(AUCTION, 1_900_000n, 44n) });
  return d;
}

async function check(publicSignals: string[], unrevealed: string[] = []) {
  return checkResult({ auctionId: AUCTION, reserve: RESERVE, deposits: await deposits(), unrevealed, publicSignals, emptyCommitment: await emptyCommitment(AUCTION) });
}
const failed = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('checkResult', () => {
  it('accepts the honest result: the three deposits in chain order, empty slots, the highest bid wins', async () => {
    const { proof, publicSignals } = await prove(await inputs(AUCTION, RESERVE, real, 1));
    expect(await verify(publicSignals, proof)).toBe(true);
    const r = await check(publicSignals);
    expect(failed(r)).toEqual([]);
    expect(r).toMatchObject({ ok: true, winnerTxid: 't2', winningBid: 1_750_000n, proven: ['t1', 't2', 't3'] });
  }, 120_000);

  it('rejects a phantom bid: an invented commitment in a spare slot that "wins" with a verifying proof', async () => {
    // The auctioneer proves over the three real commitments plus one of its own in slot 3.
    const phantom: Opening[] = [...real, { bid: 1_950_000n, salt: 666n }];
    const { proof, publicSignals } = await prove(await inputs(AUCTION, RESERVE, phantom, 3));
    expect(await verify(publicSignals, proof)).toBe(true); // the proof alone is fine
    // What the old checkers did: compare only the first valid.length slots. That passes.
    const valid = (await deposits()).filter((d) => d.status === 'valid');
    expect(valid.every((d, i) => d.commitment === publicSignals[2 + i])).toBe(true);
    const r = await check(publicSignals);
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(['slots', 'winner']);
    expect(r.winnerTxid).toBeNull();
  }, 120_000);

  it('rejects a proof that leaves out a valid deposit unless it is declared unrevealed, and only valid deposits can be declared', async () => {
    const without = [real[0], real[2]];
    const { publicSignals } = await prove(await inputs(AUCTION, RESERVE, without, 0));
    expect(failed(await check(publicSignals))).toEqual(['slots']);
    const declared = await check(publicSignals, ['t2']);
    expect(declared).toMatchObject({ ok: true, winnerTxid: 't1', proven: ['t1', 't3'] });
    expect(failed(await check(publicSignals, ['t2', 'late']))).toEqual(['unrevealed']);
  }, 120_000);

  it('rejects a proof for another auction or reserve, and a malformed signal list', async () => {
    const { publicSignals } = await prove(await inputs(AUCTION, 0n, real, 1));
    expect(failed(await check(publicSignals))).toEqual(['auction']);
    expect(failed(await check(publicSignals.slice(1)))).toEqual(['signals']);
  }, 120_000);
});
