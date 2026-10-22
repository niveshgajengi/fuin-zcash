// The reveal channel: after the close, each bidder sends its opening to the auction address as a
// second shielded note whose memo is the opening encrypted to the auctioneer's published reveal key.
//
//   memo = sba1r:<auction_id>:<deposit>:<base64url(epk || ChaCha20-Poly1305(opening))>
//
// The auction's incoming viewing key is public (so anyone can audit deposits), which means anyone can
// read this memo. That is why the opening inside it is encrypted again, to an X25519 key whose secret
// only the auctioneer holds: auditors see that deposit <deposit> was revealed at block h, never the
// bid, salt or refund address. The key is derived per message from a fresh ephemeral key (ECIES:
// X25519, HKDF-SHA256, ChaCha20-Poly1305), and the header is the AEAD's associated data, so a
// ciphertext moved to another deposit or auction does not decrypt. The plaintext has a fixed size, so
// the memo length says nothing about the refund address.
//
// The bidder keeps the ephemeral secret. Publishing it later (in a dispute) lets anyone decrypt that
// one on-chain reveal with the auctioneer's public key, which proves what was sent and when.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { commitment } from '@sba/circuits';
import { depositRef, SETTLEMENT_FEE_BUDGET_ZAT, type AuctionConfig, type ClassifiedDeposit, type Reveal } from './auction.js';

export const REVEAL_PREFIX = 'sba1r';
/** The value of a reveal note. It stays with the auction (a reveal is a message, not a deposit). */
export const REVEAL_ZAT = 1n;
const PLAIN_BYTES = 224;
const MEMO_MAX = 512;
const INFO = Buffer.from('fuin-reveal-v1');

const DER = {
  xPriv: Buffer.from('302e020100300506032b656e04220420', 'hex'),
  xPub: Buffer.from('302a300506032b656e032100', 'hex'),
  edPriv: Buffer.from('302e020100300506032b657004220420', 'hex'),
  edPub: Buffer.from('302a300506032b6570032100', 'hex'),
};
const hex32 = (h: string, what: string) => {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${what} must be 32 bytes of hex`);
  return Buffer.from(h, 'hex');
};
export const xPrivate = (raw: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([DER.xPriv, raw]), format: 'der', type: 'pkcs8' });
export const xPublic = (raw: Buffer): KeyObject => createPublicKey({ key: Buffer.concat([DER.xPub, raw]), format: 'der', type: 'spki' });
export const edPrivate = (raw: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([DER.edPriv, raw]), format: 'der', type: 'pkcs8' });
export const edPublic = (raw: Buffer): KeyObject => createPublicKey({ key: Buffer.concat([DER.edPub, raw]), format: 'der', type: 'spki' });
/** The raw 32-byte public key of a raw X25519 or Ed25519 secret. */
const rawPublic = (k: KeyObject) => Buffer.from(createPublicKey(k).export({ format: 'der', type: 'spki' }).subarray(-32));

/** A fresh X25519 key pair for an auction's reveals (hex). The secret stays with the auctioneer. */
export function revealKeyPair(): { secret: string; public: string } {
  const sk = randomBytes(32);
  return { secret: sk.toString('hex'), public: rawPublic(xPrivate(sk)).toString('hex') };
}

/** A fresh Ed25519 key pair a bidder signs complaints with (hex). Its public half rides in the reveal. */
export function complaintKeyPair(): { secret: string; public: string } {
  const sk = randomBytes(32);
  return { secret: sk.toString('hex'), public: rawPublic(edPrivate(sk)).toString('hex') };
}

export interface SealedOpening extends Reveal {
  /** Ed25519 public key (hex) that signs this bidder's complaints. */
  complaintKey: string;
}

function encodeOpening(o: SealedOpening): Buffer {
  const addr = Buffer.from(o.refundAddress, 'ascii');
  if (o.bid < 0n || o.bid >= 1n << 64n) throw new Error('bid out of range');
  if (o.salt < 0n || o.salt >= 1n << 256n) throw new Error('salt out of range');
  if (addr.length > PLAIN_BYTES - 74) throw new Error(`refund address is ${addr.length} characters, at most ${PLAIN_BYTES - 74} fit in a reveal`);
  const b = Buffer.alloc(PLAIN_BYTES);
  b[0] = 1;
  b.writeBigUInt64BE(o.bid, 1);
  Buffer.from(o.salt.toString(16).padStart(64, '0'), 'hex').copy(b, 9);
  hex32(o.complaintKey, 'complaint key').copy(b, 41);
  b[73] = addr.length;
  addr.copy(b, 74);
  return b;
}

function decodeOpening(b: Buffer): SealedOpening {
  if (b.length !== PLAIN_BYTES || b[0] !== 1) throw new Error('unknown reveal version');
  const len = b[73];
  if (74 + len > PLAIN_BYTES || b.subarray(74 + len).some((x) => x !== 0)) throw new Error('bad reveal padding');
  return {
    bid: b.readBigUInt64BE(1),
    salt: BigInt('0x' + b.subarray(9, 41).toString('hex')),
    complaintKey: b.subarray(41, 73).toString('hex'),
    refundAddress: b.subarray(74, 74 + len).toString('ascii'),
  };
}

const header = (auctionId: bigint, deposit: string) => `${REVEAL_PREFIX}:${auctionId}:${deposit}`;

function aeadKey(shared: Buffer, epk: Buffer, revealPub: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, revealPub]), INFO, 32));
}

/**
 * Encrypts an opening of deposit `deposit` to the auction's reveal key. Returns the memo to send and
 * the ephemeral secret (hex), which the bidder keeps: it is the bidder's evidence in a dispute.
 */
export function sealReveal(auctionId: bigint, revealKey: string, deposit: string, opening: SealedOpening): { memo: string; esk: string } {
  const pub = hex32(revealKey, 'reveal key');
  const esk = randomBytes(32);
  const eskKey = xPrivate(esk);
  const epk = rawPublic(eskKey);
  const key = aeadKey(diffieHellman({ privateKey: eskKey, publicKey: xPublic(pub) }), epk, pub);
  const h = header(auctionId, deposit);
  const c = createCipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: 16 });
  c.setAAD(Buffer.from(h, 'ascii'), { plaintextLength: PLAIN_BYTES });
  const box = Buffer.concat([epk, c.update(encodeOpening(opening)), c.final(), c.getAuthTag()]);
  const memo = `${h}:${box.toString('base64url')}`;
  if (Buffer.byteLength(memo) > MEMO_MAX) throw new Error(`reveal memo is ${Buffer.byteLength(memo)} bytes, a memo holds ${MEMO_MAX}`);
  return { memo, esk: esk.toString('hex') };
}

export interface RevealMemo {
  auctionId: bigint;
  deposit: string;
  epk: Buffer;
  sealed: Buffer;
  header: string;
}

export function parseRevealMemo(memo: string): RevealMemo | null {
  const m = memo.match(/^sba1r:(\d{1,40}):([0-9a-f]{64}(?::[os]?\d{1,4})?):([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const box = Buffer.from(m[3], 'base64url');
  if (box.length !== 32 + PLAIN_BYTES + 16) return null;
  return { auctionId: BigInt(m[1]), deposit: m[2], epk: box.subarray(0, 32), sealed: box.subarray(32), header: header(BigInt(m[1]), m[2]) };
}

function open(key: Buffer, r: RevealMemo): SealedOpening {
  const d = createDecipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: 16 });
  d.setAAD(Buffer.from(r.header, 'ascii'), { plaintextLength: PLAIN_BYTES });
  d.setAuthTag(r.sealed.subarray(PLAIN_BYTES));
  const plain = Buffer.concat([d.update(r.sealed.subarray(0, PLAIN_BYTES)), d.final()]);
  return decodeOpening(plain);
}

/** The auctioneer decrypts with its reveal secret. Throws if the ciphertext was altered or moved. */
export function openReveal(revealSecret: string, r: RevealMemo): SealedOpening {
  const sk = xPrivate(hex32(revealSecret, 'reveal secret'));
  return open(aeadKey(diffieHellman({ privateKey: sk, publicKey: xPublic(r.epk) }), r.epk, rawPublic(sk)), r);
}

/**
 * Anyone decrypts one reveal with the bidder's published ephemeral secret and the auction's public
 * reveal key. Throws if the secret is not the one this reveal was made with.
 */
export function openRevealWithEsk(revealKey: string, esk: string, r: RevealMemo): SealedOpening {
  const pub = hex32(revealKey, 'reveal key');
  const eskKey = xPrivate(hex32(esk, 'reveal secret'));
  if (!rawPublic(eskKey).equals(r.epk)) throw new Error("the ephemeral secret does not match this reveal's ephemeral key");
  return open(aeadKey(diffieHellman({ privateKey: eskKey, publicKey: xPublic(pub) }), r.epk, pub), r);
}

/** A reveal note as the auction sees it on chain. */
export interface RevealMessage {
  txid: string;
  output?: string;
  height: number | null;
  memo: string;
}

export type RevealStatus =
  | 'accepted'
  | 'duplicate'
  | 'conflicting'
  | 'malformed'
  | 'other_auction'
  | 'pending'
  | 'early'
  | 'late'
  | 'unknown_deposit'
  | 'tampered'
  | 'wrong_commitment'
  | 'bid_over_deposit';

/** What the auctioneer publishes about each reveal: never the opening. */
export interface RevealLogEntry {
  ref: string;
  txid: string;
  output?: string;
  height: number | null;
  deposit: string | null;
  status: RevealStatus;
  reason: string | null;
}

/** Statuses an auditor can re-derive from the chain alone (no decryption). */
export const PUBLIC_REVEAL_STATUSES: RevealStatus[] = ['malformed', 'other_auction', 'pending', 'early', 'late', 'unknown_deposit'];

export interface RevealWindow {
  closeHeight: number;
  revealCloseHeight: number;
}

/**
 * The status of a reveal that can be decided without decrypting it: its memo, its auction, its
 * height against the reveal window (after the close, at or before revealCloseHeight) and whether it
 * names a deposit that carries a commitment. Null means it is in the window and needs decrypting.
 */
export function publicRevealStatus(
  cfg: Pick<AuctionConfig, 'auctionId'> & RevealWindow,
  deposits: Pick<ClassifiedDeposit, 'ref' | 'commitment'>[],
  m: RevealMessage,
): { status: RevealStatus; reason: string; parsed: RevealMemo | null } | { status: null; parsed: RevealMemo } {
  const parsed = parseRevealMemo(m.memo);
  if (!parsed) return { status: 'malformed', reason: 'memo is not sba1r:<auction>:<deposit>:<sealed opening>', parsed };
  if (parsed.auctionId !== cfg.auctionId) return { status: 'other_auction', reason: `reveal is for auction ${parsed.auctionId}`, parsed };
  if (m.height === null) return { status: 'pending', reason: 'not mined yet', parsed };
  if (m.height <= cfg.closeHeight) return { status: 'early', reason: `mined at ${m.height}, before the close at ${cfg.closeHeight}`, parsed };
  if (m.height > cfg.revealCloseHeight) return { status: 'late', reason: `mined at ${m.height}, after the reveal window closed at ${cfg.revealCloseHeight}`, parsed };
  const d = deposits.find((x) => x.ref === parsed.deposit);
  if (!d || d.commitment === null) return { status: 'unknown_deposit', reason: `no deposit ${parsed.deposit.slice(0, 10)} carrying a bid commitment`, parsed };
  return { status: null, parsed };
}

/**
 * The auctioneer reads every reveal note from the chain, in chain order (height, then txid within a
 * block), and keeps the openings that
 * hold: in the window, decrypting with its reveal secret, hashing to the named deposit's commitment.
 * The first accepted opening of a commitment counts; the same opening sent again is a no-op
 * (`duplicate`) and a different one is `conflicting`.
 */
export async function ingestReveals(
  cfg: AuctionConfig & RevealWindow,
  revealSecret: string,
  deposits: ClassifiedDeposit[],
  messages: RevealMessage[],
): Promise<{ reveals: SealedOpening[]; log: RevealLogEntry[] }> {
  const ordered = [...messages].sort((a, b) => (a.height ?? Infinity) - (b.height ?? Infinity) || depositRef(a).localeCompare(depositRef(b)));
  const accepted = new Map<string, SealedOpening>();
  const log: RevealLogEntry[] = [];
  for (const m of ordered) {
    const entry = (status: RevealStatus, reason: string | null, deposit: string | null) =>
      log.push({ ref: depositRef(m), txid: m.txid, ...(m.output === undefined ? {} : { output: m.output }), height: m.height, deposit, status, reason });
    const pre = publicRevealStatus(cfg, deposits, m);
    if (pre.status !== null) {
      entry(pre.status, pre.reason, pre.parsed?.deposit ?? null);
      continue;
    }
    const r = pre.parsed;
    const d = deposits.find((x) => x.ref === r.deposit)!;
    let o: SealedOpening;
    try {
      o = openReveal(revealSecret, r);
    } catch {
      entry('tampered', 'does not decrypt with the auction reveal key (altered, moved to another deposit, or sealed to another key)', r.deposit);
      continue;
    }
    if ((await commitment(cfg.auctionId, o.bid, o.salt)) !== d.commitment) {
      entry('wrong_commitment', `the opening does not hash to deposit ${r.deposit.slice(0, 10)}'s commitment`, r.deposit);
      continue;
    }
    if (o.bid > cfg.depositZat - SETTLEMENT_FEE_BUDGET_ZAT) {
      entry('bid_over_deposit', `bid exceeds the deposit minus the fee budget`, r.deposit);
      continue;
    }
    const prior = accepted.get(d.commitment!);
    if (prior) {
      const same = prior.bid === o.bid && prior.salt === o.salt && prior.refundAddress === o.refundAddress && prior.complaintKey === o.complaintKey;
      entry(same ? 'duplicate' : 'conflicting', same ? 'the same opening was already accepted; no effect' : 'a different opening of this commitment was accepted first', r.deposit);
      continue;
    }
    accepted.set(d.commitment!, o);
    entry('accepted', null, r.deposit);
  }
  return { reveals: [...accepted.values()], log };
}

export interface AuditCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const DECRYPTED_STATUSES: RevealStatus[] = ['accepted', 'duplicate', 'conflicting', 'tampered', 'wrong_commitment', 'bid_over_deposit'];

/**
 * What an auditor can check about the reveals with the auction's viewing key alone (it cannot
 * decrypt them): the record lists exactly the reveal notes on chain; every status that follows from
 * public facts (memo shape, auction, height against the window, the named deposit) is the one the
 * record gives; and no deposit is both revealed (an accepted reveal) and declared unrevealed. Notes
 * name every rejected reveal of an unrevealed deposit, which is where a bidder's complaint would go.
 */
export function auditReveals(
  cfg: Pick<AuctionConfig, 'auctionId'> & RevealWindow,
  deposits: ClassifiedDeposit[],
  onChain: RevealMessage[],
  recorded: RevealLogEntry[],
  unrevealed: string[],
): { checks: AuditCheck[]; notes: string[] } {
  const checks: AuditCheck[] = [];
  const chainRefs = new Map(onChain.map((m) => [depositRef(m), m]));
  const recRefs = new Map(recorded.map((r) => [r.ref, r]));
  const notListed = [...chainRefs.keys()].filter((r) => !recRefs.has(r));
  const notFound = [...recRefs.keys()].filter((r) => !chainRefs.has(r));
  checks.push({
    name: 'reveals_listed',
    ok: notListed.length === 0 && notFound.length === 0,
    detail: `${onChain.length} reveal note(s) on chain, ${recorded.length} in the record${notListed.map((r) => `; NOT LISTED: ${r}`).join('')}${notFound.map((r) => `; NOT FOUND: ${r}`).join('')}`,
  });
  const wrong: string[] = [];
  for (const [ref, m] of chainRefs) {
    const rec = recRefs.get(ref);
    if (!rec) continue;
    const pub = publicRevealStatus(cfg, deposits, m);
    if (pub.status !== null && pub.status !== rec.status) wrong.push(`${ref.slice(0, 10)} is ${pub.status} (${pub.reason}) but the record says ${rec.status}`);
    if (pub.status === null && !DECRYPTED_STATUSES.includes(rec.status)) wrong.push(`${ref.slice(0, 10)} is in the window for a real deposit but the record says ${rec.status}`);
    if (pub.status === null && rec.deposit !== pub.parsed.deposit) wrong.push(`${ref.slice(0, 10)} names deposit ${pub.parsed.deposit.slice(0, 10)}, the record says ${rec.deposit}`);
  }
  checks.push({ name: 'reveal_status', ok: wrong.length === 0, detail: wrong.length ? wrong.join('; ') : 'every status that follows from the chain (memo, auction, window, deposit) matches the record' });
  const declared = new Set(unrevealed);
  const both = recorded.filter((r) => r.status === 'accepted' && r.deposit && declared.has(r.deposit)).map((r) => r.deposit!);
  checks.push({
    name: 'reveal_vs_outcome',
    ok: both.length === 0,
    detail: both.length ? `declared unrevealed although the record accepted a reveal for it: ${both.join(', ')}` : 'no deposit with an accepted reveal is declared unrevealed',
  });
  const notes = unrevealed.flatMap((dep) => {
    const tries = recorded.filter((r) => r.deposit === dep);
    if (tries.length === 0) return [`deposit ${dep.slice(0, 10)} is unrevealed and no reveal note names it`];
    return tries.map((r) => `deposit ${dep.slice(0, 10)} is unrevealed; reveal ${r.ref.slice(0, 10)} (block ${r.height}) names it and the record rejects it as ${r.status}${r.reason ? ` (${r.reason})` : ''}: its bidder can file a complaint`);
  });
  return { checks, notes };
}
