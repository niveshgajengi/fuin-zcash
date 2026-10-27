// Fuin app data: the published sale records (deployments/testnet*.json, bundled at build time) and,
// when a Fuin node is running (pnpm fuin), its live auctions, feed, wallets and jobs over /api.
// Nothing here invents a number: every figure comes from a record, the node, or the chain via the node.
import { isCanonicalCommitment } from '@sba/circuits/result';

export type Phase = 'bidding' | 'reveal' | 'settle' | 'settling' | 'settled';
export interface Card {
  name: string;
  auctionId: string;
  address: string;
  uivk: string;
  depositZat: string;
  reserveZat: string;
  openHeight: number;
  closeHeight: number;
  revealCloseHeight?: number;
  disputeBlocks?: number;
  revealKey?: string;
  seller: string;
}
export interface LotMeta {
  title: string;
  art: string;
  blurb: string;
}
type BlockTime = { height: number; time: number; hash: string };
export interface SaleRecord {
  lot?: LotMeta;
  auction: Card;
  deposits: { txid: string; output?: string; height: number | null; valueZat: string; memo: string; status: string; reason: string | null; label?: string | null }[];
  reveals?: { ref: string; txid: string; height: number | null; deposit: string | null; status: string; reason: string | null; label: string | null }[];
  scannedTo?: number;
  outcome?: { winnerSlot?: number; winningBidZat?: string; proof: object | null; publicSignals: string[] | null; unrevealed?: string[]; noSale?: { reason: string; detail: string } | null };
  settlement?: { txid: string; height: number; outputs: { amountZat: string; why: string; recipient: string }[]; viewingKeyChecks: { recipient: string; expected: string; seen: number[]; ok: boolean }[] };
  ironwoodOnly?: boolean;
  blockTimes?: { open: BlockTime; close: BlockTime; revealClose?: BlockTime; settlement: BlockTime };
  verificationKeySha256?: string;
  complaints?: { file: string; by: string; anchor: { txid: string; height: number } }[];
}

export interface Bid {
  ref: string;
  txid: string;
  height: number | null;
  valueZat: string;
  status: string;
  commitment: string | null;
}
export interface RevealNote {
  txid: string;
  height: number | null;
  deposit: string | null;
  status: string | null;
  late: boolean;
}
export interface Lot {
  sale: string;
  meta: LotMeta;
  card: Card;
  phase: Phase;
  source: 'record' | 'node';
  bids: Bid[];
  reveals: RevealNote[];
  pending: { kind: string; txid: string; at: string }[];
  record: SaleRecord | null;
  /** The opened bid: the only amount ever published. */
  winner: { ref: string; bidZat: string } | null;
  noSale: { reason: string; detail: string } | null;
  scanError: string | null;
}

/* ---------- formatting ---------- */
export const EXPLORER = 'https://testnet.zecblock.com/tx/';
export const REPO = 'https://github.com/nickthelegend/zec-sealed-bid-auction';
export const BLOCK_S = 75;
export const taz = (z: string | number | bigint, max = 6) => `${(Number(z) / 1e8).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: max })}`;
export const num = (n: number) => n.toLocaleString('en-US');
export const short = (s: string, a = 6, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
export const ago = (iso: string | number) => {
  const t = typeof iso === 'number' ? iso * 1000 : Date.parse(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
export const eta = (blocks: number) => {
  if (blocks <= 0) return 'now';
  const m = Math.round((blocks * BLOCK_S) / 60);
  return m < 60 ? `~${m} min` : `~${Math.floor(m / 60)}h ${m % 60}m`;
};

/* ---------- the published records ---------- */
// Lot titles and art for the three sales run before the app existed. The art is illustrative; the
// deposits, proofs and settlements are the real testnet records.
const LEGACY_LOTS: Record<string, LotMeta> = {
  '001': { title: 'Glass Hanko', art: 'hanko', blurb: 'The first sealed sale on Zcash testnet: three valid bids, four refused deposits, one shielded settlement.' },
  '002': { title: 'Chrome Koi', art: 'koi', blurb: 'The first sale with sealed reveal notes: bids opened to the house through the chain, never in public.' },
  '003': { title: 'Kintsugi Cat', art: 'lucky-cat', blurb: 'Terms bound into the auction id, a forfeited no-show and a complaint anchored on chain.' },
};
const files = import.meta.glob('@deployments/testnet*.json', { eager: true, import: 'default' }) as Record<string, SaleRecord>;
const saleOf = (path: string) => {
  const f = path.split('/').pop()!;
  if (f === 'testnet.json') return '001';
  if (f === 'testnet-reveal.json') return '002';
  return f.match(/testnet-sale(\d{3})\.json$/)?.[1] ?? null;
};
const refOf = (d: { txid: string; output?: string }) => (d.output === undefined ? d.txid : `${d.txid}:${d.output}`);
const commitmentOf = (memo: string) => {
  const c = memo.split(':')[2];
  return c !== undefined && isCanonicalCommitment(c) ? c : null;
};

export function lotFromRecord(sale: string, r: SaleRecord): Lot {
  const unrevealed = r.outcome?.unrevealed ?? [];
  const proven = r.deposits.filter((d) => d.status === 'valid' && !unrevealed.includes(refOf(d)));
  const settled = !!r.settlement;
  const w = settled && r.outcome && !r.outcome.noSale && typeof r.outcome.winnerSlot === 'number' ? proven[r.outcome.winnerSlot] : undefined;
  return {
    sale,
    meta: r.lot ?? LEGACY_LOTS[sale] ?? { title: `Lot ${sale}`, art: 'envelope', blurb: '' },
    card: r.auction,
    phase: settled ? 'settled' : 'bidding',
    source: 'record',
    bids: r.deposits.map((d) => ({ ref: refOf(d), txid: d.txid, height: d.height, valueZat: d.valueZat, status: d.status, commitment: commitmentOf(d.memo) })),
    reveals: (r.reveals ?? []).map((x) => ({ txid: x.txid, height: x.height, deposit: x.deposit, status: x.status, late: x.status === 'late' })),
    pending: [],
    record: settled ? r : null,
    winner: w && r.outcome?.winningBidZat ? { ref: refOf(w), bidZat: r.outcome.winningBidZat } : null,
    noSale: r.outcome?.noSale ?? null,
    scanError: null,
  };
}

export const PUBLISHED: Lot[] = Object.entries(files)
  .map(([p, r]) => {
    const sale = saleOf(p);
    return sale ? lotFromRecord(sale, r) : null;
  })
  .filter((x): x is Lot => x !== null && x.record !== null)
  .sort((a, b) => b.sale.localeCompare(a.sale));

/* ---------- the node ---------- */
export interface NodeAuction {
  sale: string;
  lot: LotMeta;
  card: Card;
  phase: Phase;
  tip: number;
  deposits: Bid[];
  reveals: { txid: string; height: number | null; deposit: string | null; late: boolean }[];
  pending: { kind: string; txid: string; at: string }[];
  settlement: { txid: string } | null;
  record: SaleRecord | null;
  scanError: string | null;
}
export function lotFromNode(a: NodeAuction): Lot {
  if (a.record?.settlement) return { ...lotFromRecord(a.sale, a.record), source: 'node' };
  return {
    sale: a.sale,
    meta: a.lot,
    card: a.card,
    phase: a.phase,
    source: 'node',
    bids: a.deposits,
    reveals: a.reveals.map((r) => ({ ...r, status: null })),
    pending: a.pending,
    record: null,
    winner: null,
    noSale: null,
    scanError: a.scanError,
  };
}
export interface Health {
  ok: boolean;
  tip: number;
  tipAgeS: number | null;
  setup: string[];
}
export interface FeedItem {
  id: string;
  at: string;
  kind: 'bid' | 'reveal' | 'settle' | 'other' | 'created';
  sale: string;
  lot: string;
  height: number | null;
  txid: string;
  text: string;
}
export interface Wallet {
  name: string;
  address: string | null;
  balance: { zat: string | null; at: string | null; error?: string } | null;
  refreshing: boolean;
}
export interface Job {
  id: string;
  kind: string;
  auctionId?: string;
  wallet?: string;
  status: 'running' | 'done' | 'failed';
  stage: string;
  stages: { at: string; text: string }[];
  result?: { txid?: string; txids?: string[]; settlement?: string; commitment?: string };
  error?: string;
  startedAt: string;
}
export interface Opening {
  bidZat: string;
  deposit: string | null;
  status: string;
  revealTxid: string | null;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`the Fuin node answered HTTP ${res.status} with something that is not JSON`);
  }
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

/* ---------- seal avatars: a deterministic glyph per commitment ---------- */
export function sealHue(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** What happened to one of my bids, from the record: won, lost (refunded), forfeited, or no sale. */
export function fate(lot: Lot, deposit: string | null, revealed: boolean): { text: string; cls: 'opened' | 'sealed-txt' | 'refused' | 'ok' } {
  if (lot.phase !== 'settled' || !lot.record) return revealed ? { text: 'revealed to the house', cls: 'ok' } : { text: deposit ? 'sealed on chain' : 'sending', cls: 'sealed-txt' };
  if (deposit && deposit === lot.winner?.ref) return { text: 'won · the only bid opened', cls: 'opened' };
  if (deposit && (lot.record.outcome?.unrevealed ?? []).includes(deposit)) return { text: 'not revealed in time · forfeited to the seller', cls: 'refused' };
  const b = lot.bids.find((x) => x.ref === deposit);
  if (b && b.status !== 'valid') return { text: `${b.status.replace('_', ' ')} · see the record`, cls: 'refused' };
  if (lot.noSale) return { text: 'no sale · refunded', cls: 'refused' };
  return { text: 'lost · sealed forever, deposit refunded', cls: 'sealed-txt' };
}
