// Poseidon commitments over BN254, as the MaxBid circuit computes them. No Node imports, so the
// dashboard runs the same code in the browser.
import { buildPoseidon } from 'circomlibjs';

let poseidonP: ReturnType<typeof buildPoseidon> | null = null;

/** Poseidon(auction_id, bid, salt) as a decimal string (BN254 field element). */
export async function commitment(auctionId: bigint, bid: bigint, salt: bigint): Promise<string> {
  poseidonP ??= buildPoseidon();
  const p = await poseidonP;
  return p.F.toString(p([auctionId, bid, salt]));
}

/** What an unused proof slot must hold: Poseidon(auction_id, 0, 0). */
export const emptyCommitment = (auctionId: bigint) => commitment(auctionId, 0n, 0n);
