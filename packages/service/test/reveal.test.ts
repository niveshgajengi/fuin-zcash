// The encrypted reveal channel, with real X25519 / ChaCha20-Poly1305 ciphertexts, real Poseidon
// commitments and real MaxBid proofs. The messages are what the auction's viewing key reads from
// reveal notes on chain (memo, height); the chain read itself is tested live in audit.test.ts.
import { describe, expect, it } from 'vitest';
import { commitment } from '@sba/circuits';
import { auctionIdFor, checkOutcome, classifyDeposits, decide, depositMemo, type AuctionConfig, type IncomingDeposit } from '../src/auction.js';
import { auditReveals, complaintKeyPair, ingestReveals, openRevealWithEsk, parseRevealMemo, revealKeyPair, sealReveal, type RevealMessage, type SealedOpening } from '../src/reveal.js';

const keys = revealKeyPair();
const cfg: AuctionConfig & { closeHeight: number; revealCloseHeight: number } = {
  name: 'reveal-unit',
  auctionId: auctionIdFor('reveal-unit'),
  address: 'utest1auction',
  uivk: 'uivk',
  depositZat: 2_000_000n,
  reserveZat: 500_000n,
  closeHeight: 100,
  revealCloseHeight: 110,
  sellerAddress: 'utest1seller',
};
const UA = 'utest1nf60qztq7tcpqu' + 'x'.repeat(90); // a 110-character unified address, as on testnet

interface Bidder {
  deposit: IncomingDeposit;
  opening: SealedOpening;
}
async function bidder(txid: string, height: number, bid: bigint, salt: bigint): Promise<Bidder> {
  const opening = { bid, salt, refundAddress: `${UA.slice(0, -txid.length)}${txid}`, complaintKey: complaintKeyPair().public };
  return { deposit: { txid, height, value: cfg.depositZat, memo: depositMemo(cfg.auctionId, await commitment(cfg.auctionId, bid, salt)) }, opening };
}
const T = (c: string) => c.repeat(64);
const msg = (txid: string, height: number | null, memo: string): RevealMessage => ({ txid, height, memo });

async function setup() {
  const alice = await bidder(T('a'), 90, 1_200_000n, 0xa11ce5a17n);
  const bob = await bidder(T('b'), 91, 1_750_000n, 0xb0b5a17n);
  const carol = await bidder(T('c'), 92, 900_000n, 0xca801n);
  const deposits = classifyDeposits(cfg, [alice.deposit, bob.deposit, carol.deposit]);
  return { alice, bob, carol, deposits };
}
const seal = (b: Bidder, deposit = b.deposit.txid) => sealReveal(cfg.auctionId, keys.public, deposit, b.opening);

describe('reveal memos', () => {
  it('fit in one memo, carry no bid, salt or refund address in the clear, and only the reveal key opens them', async () => {
    const { bob } = await setup();
    const { memo, esk } = seal(bob);
    expect(Buffer.byteLength(memo)).toBeLessThanOrEqual(512);
    expect(memo.startsWith(`sba1r:${cfg.auctionId}:${T('b')}:`)).toBe(true);
    for (const secret of [bob.opening.bid.toString(), bob.opening.salt.toString(), bob.opening.salt.toString(16), bob.opening.refundAddress]) expect(memo).not.toContain(secret);
    // The same opening sealed twice gives different ciphertexts (fresh ephemeral key each time).
    expect(seal(bob).memo).not.toBe(memo);
    // With the bidder's ephemeral secret anyone can open this one reveal; a different secret cannot.
    expect(openRevealWithEsk(keys.public, esk, parseRevealMemo(memo)!)).toEqual(bob.opening);
    expect(() => openRevealWithEsk(keys.public, seal(bob).esk, parseRevealMemo(memo)!)).toThrow(/does not match/);
  });
});

describe('ingestReveals (the auctioneer reads openings from the chain, not from a file)', () => {
  it('accepts reveals in the window and decides the auction from them; a deposit with no reveal is listed unrevealed', async () => {
    const { alice, bob, carol, deposits } = await setup();
    const { reveals, log } = await ingestReveals(cfg, keys.secret, deposits, [msg(T('1'), 101, seal(alice).memo), msg(T('2'), 105, seal(bob).memo)]);
    expect(log.map((l) => l.status)).toEqual(['accepted', 'accepted']);
    const o = await decide(cfg, deposits, reveals);
    expect(o.winningBid).toBe(1_750_000n);
    expect(o.unrevealed).toEqual([carol.deposit.txid]);
    expect((await checkOutcome(cfg, deposits, o)).ok).toBe(true);
    expect(o.payouts.map((p) => p.address)).toContain(alice.opening.refundAddress);
  });

  it("rejects a reveal for another bidder's commitment", async () => {
    const { alice, bob, deposits } = await setup();
    // Alice's real opening, pointed at Bob's deposit: it decrypts, but does not hash to Bob's memo.
    const { reveals, log } = await ingestReveals(cfg, keys.secret, deposits, [msg(T('1'), 101, seal(alice, bob.deposit.txid).memo)]);
    expect(log[0]).toMatchObject({ status: 'wrong_commitment', deposit: bob.deposit.txid });
    expect(reveals).toEqual([]);
    // Bob's own sealed reveal moved onto Alice's deposit does not even decrypt (the header is bound).
    const bobs = seal(bob).memo;
    const moved = bobs.replace(T('b'), T('a'));
    const r2 = await ingestReveals(cfg, keys.secret, deposits, [msg(T('2'), 101, moved)]);
    expect(r2.log[0]).toMatchObject({ status: 'tampered', deposit: alice.deposit.txid });
  });

  it('rejects a tampered ciphertext', async () => {
    const { bob, deposits } = await setup();
    const { memo } = seal(bob);
    const parsed = parseRevealMemo(memo)!;
    const flipped = Buffer.concat([parsed.epk, parsed.sealed]);
    flipped[40] ^= 0x01; // one bit of the encrypted bid
    const tampered = `${parsed.header}:${flipped.toString('base64url')}`;
    const { reveals, log } = await ingestReveals(cfg, keys.secret, deposits, [msg(T('1'), 101, tampered)]);
    expect(log[0]).toMatchObject({ status: 'tampered' });
    expect(reveals).toEqual([]);
    // Sealed to some other key: also refused.
    const other = sealReveal(cfg.auctionId, revealKeyPair().public, bob.deposit.txid, bob.opening).memo;
    expect((await ingestReveals(cfg, keys.secret, deposits, [msg(T('2'), 101, other)])).log[0].status).toBe('tampered');
  });

  it('rejects a late reveal (after the reveal window) and an early one (before the close)', async () => {
    const { bob, deposits } = await setup();
    const { reveals, log } = await ingestReveals(cfg, keys.secret, deposits, [
      msg(T('1'), cfg.revealCloseHeight + 1, seal(bob).memo),
      msg(T('2'), cfg.closeHeight, seal(bob).memo),
      msg(T('3'), null, seal(bob).memo),
    ]);
    expect(Object.fromEntries(log.map((l) => [l.txid[0], l.status]))).toEqual({ '1': 'late', '2': 'early', '3': 'pending' });
    expect(reveals).toEqual([]);
    // The last block of the window still counts.
    expect((await ingestReveals(cfg, keys.secret, deposits, [msg(T('4'), cfg.revealCloseHeight, seal(bob).memo)])).log[0].status).toBe('accepted');
  });

  it('a duplicate reveal is idempotent: the same opening twice decides exactly as once', async () => {
    const { alice, bob, deposits } = await setup();
    const once = await ingestReveals(cfg, keys.secret, deposits, [msg(T('1'), 101, seal(alice).memo), msg(T('2'), 102, seal(bob).memo)]);
    const bobAgain = seal(bob).memo; // a fresh ciphertext of the same opening
    const twice = await ingestReveals(cfg, keys.secret, deposits, [msg(T('1'), 101, seal(alice).memo), msg(T('2'), 102, seal(bob).memo), msg(T('3'), 104, bobAgain), msg(T('4'), 104, bobAgain)]);
    expect(twice.log.map((l) => l.status)).toEqual(['accepted', 'accepted', 'duplicate', 'duplicate']);
    expect(twice.reveals).toEqual(once.reveals);
    const [a, b] = [await decide(cfg, deposits, once.reveals), await decide(cfg, deposits, twice.reveals)];
    expect([b.winningBid, b.unrevealed, b.payouts]).toEqual([a.winningBid, a.unrevealed, a.payouts]);
    // A different opening for an already-revealed commitment cannot replace the first one.
    const hijack = sealReveal(cfg.auctionId, keys.public, bob.deposit.txid, { ...bob.opening, refundAddress: UA }).memo;
    const r = await ingestReveals(cfg, keys.secret, deposits, [msg(T('2'), 102, seal(bob).memo), msg(T('5'), 103, hijack)]);
    expect(r.log.map((l) => l.status)).toEqual(['accepted', 'conflicting']);
    expect(r.reveals[0].refundAddress).toBe(bob.opening.refundAddress);
  });

  it('rejects memos that are not reveals of this auction, and reveals naming no bid deposit', async () => {
    const { bob, deposits } = await setup();
    const { log } = await ingestReveals(cfg, keys.secret, deposits, [
      msg(T('1'), 101, 'sba1r:garbage'),
      msg(T('2'), 101, sealReveal(cfg.auctionId + 1n, keys.public, bob.deposit.txid, bob.opening).memo),
      msg(T('3'), 101, seal(bob, T('d')).memo),
    ]);
    expect(log.map((l) => l.status)).toEqual(['malformed', 'other_auction', 'unknown_deposit']);
  });
});

describe('auditReveals (what the viewing key alone can check)', () => {
  it('passes an honest reveal log and catches hidden, relabelled and contradictory reveals', async () => {
    const { alice, bob, carol, deposits } = await setup();
    const messages = [msg(T('1'), 101, seal(alice).memo), msg(T('2'), 105, seal(bob).memo), msg(T('3'), 111, seal(carol).memo)];
    const { reveals, log } = await ingestReveals(cfg, keys.secret, deposits, messages);
    const o = await decide(cfg, deposits, reveals);
    expect(o.unrevealed).toEqual([carol.deposit.txid]);
    const honest = auditReveals(cfg, deposits, messages, log, o.unrevealed);
    expect(honest.checks.every((c) => c.ok)).toBe(true);
    expect(honest.notes.join()).toMatch(/rejects it as late/);
    // Hiding Bob's reveal from the record.
    const hidden = auditReveals(cfg, deposits, messages, log.filter((l) => l.txid !== T('2')), o.unrevealed);
    expect(hidden.checks.find((c) => c.name === 'reveals_listed')).toMatchObject({ ok: false, detail: expect.stringContaining(`NOT LISTED: ${T('2')}`) });
    // Calling Carol's late reveal "tampered", or an in-window reveal "late".
    const relabelled = auditReveals(cfg, deposits, messages, log.map((l) => (l.txid === T('3') ? { ...l, status: 'tampered' as const } : l.txid === T('1') ? { ...l, status: 'late' as const } : l)), o.unrevealed);
    expect(relabelled.checks.find((c) => c.name === 'reveal_status')?.ok).toBe(false);
    // Accepting Alice's reveal but declaring her deposit unrevealed.
    const contradictory = auditReveals(cfg, deposits, messages, log, [...o.unrevealed, alice.deposit.txid]);
    expect(contradictory.checks.find((c) => c.name === 'reveal_vs_outcome')?.ok).toBe(false);
  });
});
