// MaxBid helpers: commitments, inputs, Groth16 prove/verify with the committed build artefacts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';

export const SLOTS = 8;
const BUILD = resolve(import.meta.dirname, '../build');
export const WASM = resolve(BUILD, 'maxbid.wasm');
export const ZKEY = resolve(BUILD, 'maxbid_final.zkey');
export const VKEY = resolve(BUILD, 'verification_key.json');

let poseidonP: ReturnType<typeof buildPoseidon> | null = null;

/** Poseidon(auction_id, bid, salt) as a decimal string (BN254 field element). */
export async function commitment(auctionId: bigint, bid: bigint, salt: bigint): Promise<string> {
  poseidonP ??= buildPoseidon();
  const p = await poseidonP;
  return p.F.toString(p([auctionId, bid, salt]));
}

export interface Opening {
  bid: bigint;
  salt: bigint;
}

/** Circuit inputs for openings in deposit order (slot 0 = earliest); empty slots are (0, 0). */
export async function inputs(auctionId: bigint, reserve: bigint, openings: Opening[], winner: number) {
  if (openings.length > SLOTS) throw new Error(`at most ${SLOTS} bids`);
  const padded = [...openings, ...Array.from({ length: SLOTS - openings.length }, () => ({ bid: 0n, salt: 0n }))];
  const commitments = await Promise.all(padded.map((o) => commitment(auctionId, o.bid, o.salt)));
  return {
    auction_id: auctionId.toString(),
    reserve: reserve.toString(),
    commitments,
    winner: String(winner),
    winning_bid: padded[winner].bid.toString(),
    bids: padded.map((o) => o.bid.toString()),
    salts: padded.map((o) => o.salt.toString()),
  };
}

/** Highest bid, earliest slot on ties: the only winner the circuit accepts. */
export function winnerOf(openings: Opening[]): number {
  let w = 0;
  openings.forEach((o, i) => {
    if (o.bid > openings[w].bid) w = i;
  });
  return w;
}

export async function prove(input: Awaited<ReturnType<typeof inputs>>) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  return { proof, publicSignals: publicSignals as string[] };
}

export function verificationKey(): object {
  return JSON.parse(readFileSync(VKEY, 'utf8'));
}

export async function verify(publicSignals: string[], proof: object): Promise<boolean> {
  return snarkjs.groth16.verify(verificationKey(), publicSignals, proof);
}

/** Public signal order: auction_id, reserve, commitments[8], winner, winning_bid. */
export function readPublic(publicSignals: string[]) {
  return {
    auctionId: BigInt(publicSignals[0]),
    reserve: BigInt(publicSignals[1]),
    commitments: publicSignals.slice(2, 2 + SLOTS),
    winner: Number(publicSignals[2 + SLOTS]),
    winningBid: BigInt(publicSignals[3 + SLOTS]),
  };
}
