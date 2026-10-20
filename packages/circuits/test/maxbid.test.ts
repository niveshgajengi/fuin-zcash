// Real Groth16 proofs with the committed zkey/vk (no mocks): what the circuit accepts and refuses.
import { describe, expect, it } from 'vitest';
import { commitment, inputs, prove, readPublic, verify, winnerOf, type Opening } from '../src/maxbid.js';

const AUCTION = 1234567890123456789n;
const bids: Opening[] = [
  { bid: 1_200_000n, salt: 111n },
  { bid: 1_750_000n, salt: 222n },
  { bid: 900_000n, salt: 333n },
];

async function witnessFails(input: Awaited<ReturnType<typeof inputs>>) {
  await expect(prove(input)).rejects.toThrow(/Assert Failed|Error in template/);
}

describe('MaxBid(8)', () => {
  it('proves the highest bid wins; the proof verifies and reveals only the winning bid', async () => {
    const w = winnerOf(bids);
    expect(w).toBe(1);
    const { proof, publicSignals } = await prove(await inputs(AUCTION, 1_000_000n, bids, w));
    expect(await verify(publicSignals, proof)).toBe(true);
    const pub = readPublic(publicSignals);
    expect(pub.winningBid).toBe(1_750_000n);
    expect(pub.winner).toBe(1);
    expect(pub.commitments[0]).toBe(await commitment(AUCTION, 1_200_000n, 111n));
    // Losing bids are not among the public signals.
    expect(publicSignals).not.toContain('1200000');
    expect(publicSignals).not.toContain('900000');
  }, 120_000);

  it('a proof with a tampered public winner or winning bid does not verify', async () => {
    const { proof, publicSignals } = await prove(await inputs(AUCTION, 1_000_000n, bids, 1));
    const lied = [...publicSignals];
    lied[2 + 8] = '0';
    expect(await verify(lied, proof)).toBe(false);
    const lowered = [...publicSignals];
    lowered[3 + 8] = '1200000';
    expect(await verify(lowered, proof)).toBe(false);
  }, 120_000);

  it('cannot prove a winner that is not the highest bid', async () => {
    await witnessFails(await inputs(AUCTION, 1_000_000n, bids, 0));
  }, 60_000);

  it('cannot prove a winning bid below the reserve', async () => {
    await witnessFails(await inputs(AUCTION, 2_000_000n, bids, 1));
  }, 60_000);

  it('cannot prove with an opening that does not match its commitment', async () => {
    const input = await inputs(AUCTION, 1_000_000n, bids, 1);
    input.bids[2] = '950000';
    await witnessFails(input);
  }, 60_000);

  it('ties go to the earliest deposit: the later slot cannot claim the win', async () => {
    const tie: Opening[] = [
      { bid: 1_500_000n, salt: 1n },
      { bid: 1_500_000n, salt: 2n },
    ];
    await witnessFails(await inputs(AUCTION, 0n, tie, 1));
    const { proof, publicSignals } = await prove(await inputs(AUCTION, 0n, tie, 0));
    expect(await verify(publicSignals, proof)).toBe(true);
  }, 120_000);
});
