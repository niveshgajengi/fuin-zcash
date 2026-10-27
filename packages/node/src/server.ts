// The Fuin node: the local HTTP API behind the Fuin app. It plays two roles on one machine, kept apart:
//
//  - the house (auctioneer): creates auction cards (terms bound into the auction id, its own reveal
//    key), watches the auction's blocks with the auction's incoming viewing key, and after the reveal
//    window decrypts the reveal notes, proves MaxBid and sends the one shielded settlement;
//  - bidders: every bid and reveal goes through that bidder's own `sba-mcp` process, started with only
//    its own wallet and its own openings folder (.demo/bidders/<name>), exactly as an agent would use it.
//
// Nothing is mocked. Every action is a real Zcash testnet transaction through zingo-cli, which runs
// under SBA_ZINGO_LOCK (one zingo-cli at a time on this machine). Missing setup fails with
// "Setup required: …". State lives in .demo/node (gitignored); the house's reveal secret never leaves it.
//
//   pnpm fuin            # http://127.0.0.1:5179 (API) — the app (pnpm --filter @sba/app dev) proxies /api here
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readPublic, VKEY } from '@sba/circuits';
import {
  address,
  asDeposits,
  asMessages,
  blockTime,
  chainTip,
  checkOutcome,
  classifyDeposits,
  decide,
  decrypt,
  exportUfvk,
  ingestReveals,
  ironwoodOnly,
  parseRevealMemo,
  quicksend,
  REVEAL_PREFIX,
  revealKeyPair,
  scan,
  SETTLEMENT_FEE_BUDGET_ZAT,
  spendable,
  termsAuctionId,
  termsOf,
  uivkOf,
  zingoConfig,
  type AuctionConfig,
  type DecryptedTx,
  type NoSale,
} from '@sba/service';

const ROOT = resolve(import.meta.dirname, '../../..');
const DEMO = resolve(ROOT, '.demo');
const WALLETS = resolve(DEMO, 'wallets');
const BIDDERS = resolve(DEMO, 'bidders');
const STATE = resolve(DEMO, 'node');
const DEPLOY = resolve(ROOT, 'deployments');
const MCP = resolve(ROOT, 'packages/mcp/src/main.ts');
const TSX = resolve(ROOT, 'packages/mcp/node_modules/.bin/tsx');
const PORT = Number(process.env.FUIN_NODE_PORT ?? 5179);
const BIDDER_NAMES = ['bidder1', 'bidder2', 'bidder3'] as const;
const DISPUTE_BLOCKS = 60;
const cfgZ = zingoConfig();

/* ---------------- setup ---------------- */
function setupProblems(): string[] {
  const p: string[] = [];
  if (!existsSync(cfgZ.bin)) p.push(`SBA_ZINGO_CLI: no zingo-cli at ${cfgZ.bin}`);
  for (const n of ['auction', ...BIDDER_NAMES]) if (!existsSync(resolve(WALLETS, n))) p.push(`wallet .demo/wallets/${n} is missing`);
  if (!existsSync(VKEY)) p.push('the MaxBid circuit is not built (pnpm --filter @sba/circuits setup)');
  return p;
}

/* ---------------- persistent state ---------------- */
interface Lot {
  title: string;
  art: string;
  blurb: string;
}
interface Card {
  name: string;
  auctionId: string;
  address: string;
  uivk: string;
  depositZat: string;
  reserveZat: string;
  openHeight: number;
  closeHeight: number;
  revealCloseHeight: number;
  disputeBlocks: number;
  revealKey: string;
  seller: string;
}
interface HouseAuction {
  sale: string;
  lot: Lot;
  card: Card;
  revealSecret: string;
  createdAt: string;
  /** Txids this node sent for the auction (bids, reveals), so the settle step waits until the scan shows them. */
  sent: { kind: 'bid' | 'reveal'; wallet: string; txid: string; at: string }[];
  settlement?: { txid: string; payouts: { address: string; amount: string; why: string }[] };
  outcome?: { winnerCommitment: string | null; winningBid: string; proof: object | null; publicSignals: string[] | null; unrevealed: string[]; noSale: NoSale | null };
  recorded?: boolean;
}
interface House {
  addrs: Record<string, string>;
  uivks: Record<string, string>;
}
mkdirSync(resolve(STATE, 'auctions'), { recursive: true, mode: 0o700 });
const houseFile = resolve(STATE, 'house.json');
const auctionFile = (id: string) => resolve(STATE, 'auctions', `${id}.json`);
const save = (file: string, v: unknown) => writeFileSync(file, JSON.stringify(v, null, 2), { mode: 0o600 });
const loadAuctions = (): HouseAuction[] => readdirSync(resolve(STATE, 'auctions')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(resolve(STATE, 'auctions', f), 'utf8')));
const saveAuction = (a: HouseAuction) => save(auctionFile(a.card.auctionId), a);
const recordFile = (sale: string) => resolve(DEPLOY, `testnet-sale${sale}.json`);

/** Addresses and viewing keys (never seeds). Reused from earlier runs' state when present, so no zingo call is needed. */
async function house(): Promise<House> {
  const h: House = existsSync(houseFile) ? JSON.parse(readFileSync(houseFile, 'utf8')) : { addrs: {}, uivks: {} };
  const prior = resolve(DEMO, 'reveal-run-003-state.json');
  if (existsSync(prior)) {
    const s = JSON.parse(readFileSync(prior, 'utf8')) as House;
    for (const k of Object.keys(s.addrs ?? {})) h.addrs[k] ??= s.addrs[k];
    for (const k of Object.keys(s.uivks ?? {})) h.uivks[k] ??= s.uivks[k];
  }
  for (const n of ['auction', 'seller', ...BIDDER_NAMES]) {
    if (!h.uivks[n]) h.uivks[n] = await uivkOf(await exportUfvk(cfgZ, resolve(WALLETS, n)));
    if (!h.addrs[n]) h.addrs[n] = await address(cfgZ, resolve(WALLETS, n));
  }
  save(houseFile, h);
  return h;
}

/* ---------------- jobs (long-running wallet actions) ---------------- */
interface Job {
  id: string;
  kind: 'bid' | 'reveal' | 'settle' | 'balance';
  auctionId?: string;
  wallet?: string;
  status: 'running' | 'done' | 'failed';
  stage: string;
  stages: { at: string; text: string }[];
  result?: unknown;
  error?: string;
  startedAt: string;
}
const jobs = new Map<string, Job>();
function startJob(kind: Job['kind'], meta: Partial<Job>, fn: (stage: (s: string) => void) => Promise<unknown>): Job {
  const job: Job = { id: randomUUID(), kind, status: 'running', stage: 'starting', stages: [], startedAt: new Date().toISOString(), ...meta };
  const stage = (s: string) => {
    job.stage = s;
    job.stages.push({ at: new Date().toISOString(), text: s });
    console.log(`[${kind}${job.wallet ? ` ${job.wallet}` : ''}] ${s}`);
  };
  jobs.set(job.id, job);
  fn(stage).then(
    (r) => {
      job.result = r;
      job.status = 'done';
      stage('done');
    },
    (e) => {
      job.error = (e as Error).message;
      job.status = 'failed';
      stage(`failed: ${job.error}`);
    },
  );
  return job;
}
const busy = (pred: (j: Job) => boolean) => [...jobs.values()].some((j) => j.status === 'running' && pred(j));

/* ---------------- chain watch ---------------- */
let tip = 0;
let tipAt = 0;
const blockTimes = new Map<number, number>();
interface Watch {
  scannedTo: number;
  txs: DecryptedTx[];
  at: number;
  error?: string;
}
const watch = new Map<string, Watch>();
interface FeedItem {
  id: string;
  at: string;
  kind: 'bid' | 'reveal' | 'settle' | 'other' | 'created';
  sale: string;
  lot: string;
  height: number | null;
  txid: string;
  text: string;
}
const feedFile = resolve(STATE, 'feed.json');
const feed: FeedItem[] = existsSync(feedFile) ? JSON.parse(readFileSync(feedFile, 'utf8')) : [];
const pushFeed = (f: Omit<FeedItem, 'id' | 'at'>) => {
  if (feed.some((x) => x.txid === f.txid && x.kind === f.kind)) return;
  feed.unshift({ id: randomUUID(), at: new Date().toISOString(), ...f });
  feed.length = Math.min(feed.length, 300);
  save(feedFile, feed);
};

const cfgOf = (c: Card): AuctionConfig & { closeHeight: number; revealCloseHeight: number } => ({
  name: c.name,
  auctionId: BigInt(c.auctionId),
  address: c.address,
  uivk: c.uivk,
  depositZat: BigInt(c.depositZat),
  reserveZat: BigInt(c.reserveZat),
  closeHeight: c.closeHeight,
  revealCloseHeight: c.revealCloseHeight,
  sellerAddress: c.seller,
});

async function refreshTip() {
  try {
    const t = await chainTip();
    if (t !== tip) {
      tip = t;
      tipAt = Date.now();
    }
  } catch (e) {
    console.error(`chain tip: ${(e as Error).message}`);
  }
}

/** Scans one auction's blocks with its incoming viewing key: deposits and reveal notes as the public sees them. */
async function scanAuction(a: HouseAuction) {
  const w = watch.get(a.card.auctionId);
  const to = a.settlement ? Math.max(tip, a.card.revealCloseHeight) : tip;
  if (!to || (w && w.scannedTo === to && Date.now() - w.at < 60_000)) return;
  try {
    const txs = await scan(a.card.uivk, a.card.openHeight, to);
    watch.set(a.card.auctionId, { scannedTo: to, txs, at: Date.now() });
    const cfg = cfgOf(a.card);
    for (const d of classifyDeposits(cfg, txs.flatMap(asDeposits))) {
      if (d.status === 'memo_mismatch') continue;
      pushFeed({ kind: 'bid', sale: a.sale, lot: a.lot.title, height: d.height, txid: d.ref, text: d.status === 'valid' ? 'sealed bid landed' : `deposit ${d.status.replace('_', ' ')}` });
    }
    for (const m of txs.flatMap((t) => asMessages(t, `${REVEAL_PREFIX}:`))) {
      const late = m.height !== null && m.height > a.card.revealCloseHeight;
      pushFeed({ kind: 'reveal', sale: a.sale, lot: a.lot.title, height: m.height, txid: m.txid, text: late ? 'reveal note arrived late' : 'sealed reveal note landed' });
    }
  } catch (e) {
    watch.set(a.card.auctionId, { scannedTo: w?.scannedTo ?? 0, txs: w?.txs ?? [], at: Date.now(), error: (e as Error).message });
  }
}

async function tick() {
  await refreshTip();
  for (const a of loadAuctions()) if (!a.recorded || !watch.has(a.card.auctionId)) await scanAuction(a);
}

/* ---------------- views ---------------- */
type Phase = 'bidding' | 'reveal' | 'settle' | 'settling' | 'settled';
function phaseOf(a: HouseAuction): Phase {
  if (a.recorded) return 'settled';
  if (a.settlement) return 'settling';
  if (tip < a.card.closeHeight) return 'bidding';
  if (tip < a.card.revealCloseHeight) return 'reveal';
  return 'settle';
}

function publicView(a: HouseAuction) {
  const w = watch.get(a.card.auctionId);
  const cfg = cfgOf(a.card);
  const deposits = w ? classifyDeposits(cfg, w.txs.flatMap(asDeposits)) : [];
  const reveals = (w?.txs ?? []).flatMap((t) => asMessages(t, `${REVEAL_PREFIX}:`)).map((m) => {
    const r = parseRevealMemo(m.memo);
    return { txid: m.txid, height: m.height, deposit: r?.deposit ?? null, late: m.height !== null && m.height > a.card.revealCloseHeight };
  });
  const rec = a.recorded && existsSync(recordFile(a.sale)) ? JSON.parse(readFileSync(recordFile(a.sale), 'utf8')) : null;
  return {
    sale: a.sale,
    lot: a.lot,
    card: { ...a.card },
    phase: phaseOf(a),
    tip,
    createdAt: a.createdAt,
    scannedTo: w?.scannedTo ?? null,
    scanError: w?.error ?? null,
    // What anyone with the auction's viewing key sees: equal deposits and commitments, never a bid.
    deposits: deposits.map((d) => ({ ref: d.ref, txid: d.txid, height: d.height, valueZat: d.value.toString(), status: d.status, commitment: d.commitment })),
    reveals,
    pending: a.sent.filter((s) => !(w?.txs ?? []).some((t) => t.txid === s.txid)).map((s) => ({ kind: s.kind, txid: s.txid, at: s.at })),
    settlement: a.settlement ? { txid: a.settlement.txid } : null,
    record: rec,
  };
}

/* ---------------- bidder actions through sba-mcp ---------------- */
async function asBidder(name: string, a: HouseAuction, tool: string, args: Record<string, unknown>) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SBA_AUCTION_FILE: recordFile(a.sale), SBA_BIDDER_WALLET: resolve(WALLETS, name), SBA_BIDDER_DIR: resolve(BIDDERS, name) };
  for (const k of ['SBA_ZINGO_CLI', 'SBA_ZINGO_LOCK', 'SBA_LWD_URL', 'SBA_VERIFY_BIN']) if (process.env[k]) env[k] = process.env[k]!;
  const c = new Client({ name: `fuin-app-${name}`, version: '0' });
  await c.connect(new StdioClientTransport({ command: TSX, args: [MCP], env }));
  try {
    const r = (await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 1_800_000 })) as { isError?: boolean; content: { text: string }[] };
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  } finally {
    await c.close();
  }
}

/** This bidder's own openings for an auction, read from its own folder. Shown only to that bidder in the app. */
function myOpenings(name: string, auctionId: string) {
  const dir = resolve(BIDDERS, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${auctionId}-`) && f.endsWith('.json') && !f.endsWith('.complaint.json'))
    .map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')))
    .map((o) => ({ bidZat: o.bid as string, deposit: (o.txid as string | null) ?? null, status: (o.status as string) ?? 'sent', revealTxid: (o.revealTxid as string | undefined) ?? null }));
}

/* ---------------- balances ---------------- */
const balancesFile = resolve(STATE, 'balances.json');
const balances: Record<string, { zat: string | null; at: string | null; error?: string }> = existsSync(balancesFile) ? JSON.parse(readFileSync(balancesFile, 'utf8')) : {};
function refreshBalance(name: string) {
  if (busy((j) => j.kind === 'balance' && j.wallet === name)) return;
  startJob('balance', { wallet: name }, async (stage) => {
    stage('waiting for the wallet (one zingo-cli at a time)');
    try {
      const z = await spendable(cfgZ, resolve(WALLETS, name));
      balances[name] = { zat: z.toString(), at: new Date().toISOString() };
      save(balancesFile, balances);
    } catch (e) {
      balances[name] = { ...(balances[name] ?? { zat: null, at: null }), error: (e as Error).message };
      throw e;
    }
  });
}

/* ---------------- the house: create and settle ---------------- */
function nextSale(): string {
  const used = new Set<number>([1, 2, 3]);
  for (const f of readdirSync(DEPLOY)) {
    const m = f.match(/^testnet-sale(\d{3})\.json$/);
    if (m) used.add(Number(m[1]));
  }
  for (const a of loadAuctions()) used.add(Number(a.sale));
  return String(Math.max(...used) + 1).padStart(3, '0');
}

async function createAuction(body: { title?: string; art?: string; blurb?: string; depositTaz?: number; reserveTaz?: number; closeBlocks?: number; revealBlocks?: number }) {
  const problems = setupProblems();
  if (problems.length) throw new Error(`Setup required: ${problems.join('; ')}`);
  const title = String(body.title ?? '').trim();
  if (!title || title.length > 48) throw new Error('a lot needs a title of 1 to 48 characters');
  const deposit = BigInt(Math.round((body.depositTaz ?? 0.002) * 1e8));
  const reserve = BigInt(Math.round((body.reserveTaz ?? 0.0005) * 1e8));
  const closeBlocks = Math.round(body.closeBlocks ?? 16);
  const revealBlocks = Math.round(body.revealBlocks ?? 14);
  if (deposit < 100_000n || deposit > 2_000_000n) throw new Error('the deposit must be between 0.001 and 0.02 TAZ');
  if (reserve < 1n || reserve > deposit - SETTLEMENT_FEE_BUDGET_ZAT) throw new Error(`the reserve must be above 0 and at most the deposit minus the ${SETTLEMENT_FEE_BUDGET_ZAT} zat fee budget`);
  if (closeBlocks < 8 || closeBlocks > 400) throw new Error('bidding must last 8 to 400 blocks (testnet blocks are about 75 s and can stall)');
  if (revealBlocks < 8 || revealBlocks > 400) throw new Error('the reveal window must last 8 to 400 blocks');
  const h = await house();
  await refreshTip();
  if (!tip) throw new Error('cannot read the chain tip from lightwalletd; nothing was created');
  const sale = nextSale();
  const keys = revealKeyPair();
  const terms = {
    name: `fuin-sale${sale}-${new Date().toISOString().slice(0, 16)}`,
    address: h.addrs.auction,
    uivk: h.uivks.auction,
    depositZat: deposit.toString(),
    reserveZat: reserve.toString(),
    openHeight: tip,
    closeHeight: tip + closeBlocks,
    revealCloseHeight: tip + closeBlocks + revealBlocks,
    disputeBlocks: DISPUTE_BLOCKS,
    revealKey: keys.public,
    seller: h.addrs.seller,
  };
  // The id is a hash of every term, so no term can change after the bids.
  const card: Card = { ...terms, auctionId: termsAuctionId(termsOf(terms)).toString() };
  const lot: Lot = { title, art: String(body.art ?? 'envelope'), blurb: String(body.blurb ?? '').slice(0, 200) };
  const a: HouseAuction = { sale, lot, card, revealSecret: keys.secret, createdAt: new Date().toISOString(), sent: [] };
  saveAuction(a);
  // The published card: what bidders (and their sba-mcp servers) read.
  writeFileSync(recordFile(sale), JSON.stringify({ network: 'testnet', lot, auction: card, deposits: [] }, null, 2) + '\n');
  pushFeed({ kind: 'created', sale, lot: title, height: tip, txid: `card-${card.auctionId}`, text: `listed · sealed bidding until block ${card.closeHeight.toLocaleString('en-US')}` });
  return publicView(a);
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

async function settle(a: HouseAuction, stage: (s: string) => void) {
  const h = await house();
  const cfg = cfgOf(a.card);
  await refreshTip();
  if (tip < a.card.revealCloseHeight) throw new Error(`the reveal window is open until block ${a.card.revealCloseHeight} (chain at ${tip}); nothing was sent`);
  if (!a.settlement) {
    // lightwalletd can serve a mined transaction before its compact block, so scan until every note this node sent shows.
    stage(`scanning blocks ${a.card.openHeight}–${tip} with the auction's viewing key`);
    let to = tip;
    let found = await scan(a.card.uivk, a.card.openHeight, to);
    for (let i = 0; a.sent.some((s) => !found.some((t) => t.txid === s.txid)); i++) {
      const missing = a.sent.filter((s) => !found.some((t) => t.txid === s.txid)).map((s) => s.txid.slice(0, 10));
      if (i >= 20) throw new Error(`the scan to block ${to} still does not show ${missing.join(', ')}`);
      stage(`the scan to block ${to} does not show ${missing.join(', ')} yet; rescanning in 30 s`);
      await sleep(30);
      await refreshTip();
      to = tip;
      found = await scan(a.card.uivk, a.card.openHeight, to);
    }
    const deposits = classifyDeposits(cfg, found.flatMap(asDeposits));
    const messages = found.flatMap((t) => asMessages(t, `${REVEAL_PREFIX}:`));
    stage(`opening ${messages.length} sealed reveal note(s) with the house's reveal key`);
    const { reveals, log } = await ingestReveals(cfg, a.revealSecret, deposits, messages);
    stage('proving MaxBid (Groth16): only the winning bid is opened');
    const o = await decide(cfg, deposits, reveals);
    a.outcome = { winnerCommitment: o.winnerCommitment, winningBid: o.winningBid.toString(), proof: o.proof, publicSignals: o.publicSignals, unrevealed: o.unrevealed, noSale: o.noSale ?? null };
    saveAuction(a);
    stage(`sending one shielded settlement with ${o.payouts.length} outputs from the auction wallet`);
    let txids: string[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        txids = await quicksend(cfgZ, resolve(WALLETS, 'auction'), o.payouts.map((p) => ({ address: p.address, amount: p.amount, memo: p.memo })));
        break;
      } catch (e) {
        const m = (e as Error).message;
        if (attempt < 10 && /insufficient|Propose send error|Mixnet|no proven exit|spendable|Transmission failed/i.test(m)) {
          stage(`zingo-cli: ${m.slice(0, 100)}; retrying in 60 s (nothing was sent)`);
          await sleep(60);
          continue;
        }
        throw e;
      }
    }
    a.settlement = { txid: txids[0], payouts: o.payouts.map((p) => ({ address: p.address, amount: p.amount.toString(), why: p.why })) };
    saveAuction(a);
    writeFileSync(resolve(STATE, `scan-${a.sale}.json`), JSON.stringify({ to, deposits: deposits.map((d) => ({ ...d, value: d.value.toString() })), log }, null, 2), { mode: 0o600 });
    pushFeed({ kind: 'settle', sale: a.sale, lot: a.lot.title, height: null, txid: txids[0], text: o.noSale ? 'no sale: every revealed deposit refunded' : 'hammer: winner opened, settlement sent' });
  }
  const settlement = a.settlement!;
  stage(`waiting for settlement ${settlement.txid.slice(0, 10)}… to be mined`);
  for (let i = 0; ; i++) {
    const [t] = await decrypt(h.uivks.seller, [settlement.txid]).catch(() => [undefined]);
    if (t && t.confirmations >= 1) break;
    if (i > 120) throw new Error(`settlement ${settlement.txid} is not mined after an hour`);
    await sleep(30);
  }
  const [settle] = await decrypt(h.uivks.seller, [settlement.txid]);
  const scanned = JSON.parse(readFileSync(resolve(STATE, `scan-${a.sale}.json`), 'utf8')) as { to: number; deposits: (Omit<ReturnType<typeof classifyDeposits>[number], 'value'> & { value: string })[]; log: Awaited<ReturnType<typeof ingestReveals>>['log'] };
  const deposits = scanned.deposits.map((d) => ({ ...d, value: BigInt(d.value) }));
  stage("each recipient checks its own output with its own viewing key");
  const who: Record<string, string> = Object.fromEntries(['seller', ...BIDDER_NAMES].map((n) => [h.addrs[n], n]));
  const checks = [];
  for (const [addr, name] of Object.entries(who)) {
    const expected = settlement.payouts.filter((p) => p.address === addr).map((p) => Number(p.amount)).sort((x, y) => x - y);
    const [t] = await decrypt(h.uivks[name], [settlement.txid]);
    const seen = t.outputs.map((x) => x.value).sort((x, y) => x - y);
    const ok = JSON.stringify(seen) === JSON.stringify(expected);
    checks.push({ recipient: name, expected: expected.join('+') || '0', seen, ok });
    if (!ok) throw new Error(`${name}'s settlement outputs do not match: saw ${seen.join('+') || 'nothing'}, expected ${expected.join('+') || 'nothing'}`);
  }
  const outcome = a.outcome!;
  const result = await checkOutcome(cfgOf(a.card), deposits, outcome);
  if (!result.ok) throw new Error(`the outcome fails its own check: ${result.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`);
  const all = await decrypt(a.card.uivk, [...new Set([...deposits.map((d) => d.txid), ...scanned.log.map((l) => l.txid), settlement.txid])]);
  const pub = outcome.publicSignals ? readPublic(outcome.publicSignals) : null;
  const labels: Record<string, string> = {};
  for (const s of a.sent) labels[s.txid] = `${s.wallet} ${s.kind === 'bid' ? 'sealed bid' : 'reveal'} (Fuin app, via sba-mcp)`;
  const record = {
    network: 'testnet',
    lot: a.lot,
    auction: a.card,
    deposits: deposits.map((d) => ({ txid: d.txid, ...(d.output === undefined ? {} : { output: d.output }), height: d.height, valueZat: d.value.toString(), memo: d.memo, status: d.status, reason: d.reason ?? null, label: labels[d.txid] ?? null })),
    reveals: scanned.log.map((l) => ({ ...l, label: labels[l.txid] ?? null })),
    scannedTo: scanned.to,
    outcome: {
      ...(pub ? { winnerSlot: pub.winner, winningBidZat: pub.winningBid.toString(), reserveZat: pub.reserve.toString(), commitments: pub.commitments } : {}),
      proof: outcome.proof,
      publicSignals: outcome.publicSignals,
      unrevealed: outcome.unrevealed,
      noSale: outcome.noSale,
      proofVerifies: result.checks[0].ok,
      slotsMatchDeposits: result.ok,
    },
    settlement: { txid: settlement.txid, height: settle.height, outputs: settlement.payouts.map((p) => ({ amountZat: p.amount, why: p.why, recipient: who[p.address] })), viewingKeyChecks: checks },
    ironwoodOnly: all.every(ironwoodOnly),
    blockTimes: { open: await blockTime(a.card.openHeight), close: await blockTime(a.card.closeHeight), revealClose: await blockTime(a.card.revealCloseHeight), settlement: await blockTime(settle.height!) },
    verificationKeySha256: createHash('sha256').update(readFileSync(VKEY)).digest('hex'),
  };
  writeFileSync(recordFile(a.sale), JSON.stringify(record, null, 2) + '\n');
  a.recorded = true;
  saveAuction(a);
  stage(`recorded deployments/testnet-sale${a.sale}.json`);
  return { settlement: settlement.txid, height: settle.height, checks };
}

/* ---------------- HTTP ---------------- */
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) s += c;
  if (s.length > 10_000) throw new Error('request too large');
  return s ? JSON.parse(s) : {};
}
const byId = (id: string) => {
  const a = loadAuctions().find((x) => x.card.auctionId === id || x.sale === id);
  if (!a) throw Object.assign(new Error(`no auction ${id} on this node`), { code: 404 });
  return a;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname.replace(/\/+$/, '');
  try {
    if (req.method === 'GET' && p === '/api/health') {
      const problems = setupProblems();
      return json(res, 200, { ok: problems.length === 0, node: 'fuin', tip, tipAgeS: tipAt ? Math.round((Date.now() - tipAt) / 1000) : null, setup: problems, lock: cfgZ.lock ?? null });
    }
    if (req.method === 'GET' && p === '/api/auctions') return json(res, 200, { tip, auctions: loadAuctions().map(publicView) });
    if (req.method === 'POST' && p === '/api/auctions') return json(res, 201, await createAuction(await body(req)));
    if (req.method === 'GET' && p === '/api/feed') return json(res, 200, { tip, feed: feed.slice(0, 80) });
    if (req.method === 'GET' && p === '/api/wallets') {
      const h = existsSync(houseFile) ? (JSON.parse(readFileSync(houseFile, 'utf8')) as House) : { addrs: {} as Record<string, string> };
      return json(res, 200, { wallets: BIDDER_NAMES.map((n) => ({ name: n, address: h.addrs[n] ?? null, balance: balances[n] ?? null, refreshing: busy((j) => j.kind === 'balance' && j.wallet === n) })) });
    }
    if (req.method === 'POST' && p === '/api/wallets/refresh') {
      for (const n of BIDDER_NAMES) refreshBalance(n);
      return json(res, 202, { ok: true });
    }
    let m = p.match(/^\/api\/jobs\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      const j = jobs.get(m[1]);
      return j ? json(res, 200, j) : json(res, 404, { error: 'no such job' });
    }
    if (req.method === 'GET' && p === '/api/jobs') return json(res, 200, { jobs: [...jobs.values()].filter((j) => j.kind !== 'balance').slice(-30) });
    m = p.match(/^\/api\/auctions\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const a = byId(m[1]);
      await scanAuction(a);
      return json(res, 200, publicView(a));
    }
    m = p.match(/^\/api\/auctions\/(\d+)\/mine$/);
    if (req.method === 'GET' && m) {
      const a = byId(m[1]);
      const name = url.searchParams.get('wallet') ?? '';
      if (!(BIDDER_NAMES as readonly string[]).includes(name)) throw new Error(`unknown wallet ${name}`);
      return json(res, 200, { wallet: name, openings: myOpenings(name, a.card.auctionId) });
    }
    m = p.match(/^\/api\/auctions\/(\d+)\/(bid|reveal|settle)$/);
    if (req.method === 'POST' && m) {
      const problems = setupProblems();
      if (problems.length) throw new Error(`Setup required: ${problems.join('; ')}`);
      const a = byId(m[1]);
      const action = m[2] as 'bid' | 'reveal' | 'settle';
      const b = await body(req);
      if (action === 'settle') {
        if (busy((j) => j.kind === 'settle' && j.auctionId === a.card.auctionId)) throw new Error('this auction is already being settled');
        const job = startJob('settle', { auctionId: a.card.auctionId }, (stage) => settle(byId(a.card.auctionId), stage));
        return json(res, 202, job);
      }
      const wallet = String(b.wallet ?? '');
      if (!(BIDDER_NAMES as readonly string[]).includes(wallet)) throw new Error(`unknown wallet ${wallet}`);
      if (busy((j) => j.wallet === wallet && j.kind !== 'balance')) throw new Error(`${wallet} is already sending; wait for it to finish`);
      const h = await house();
      const job = startJob(action, { auctionId: a.card.auctionId, wallet }, async (stage) => {
        stage(`${wallet}'s own sba-mcp server ${action === 'bid' ? 'seals the bid and sends the equal deposit' : 'seals the opening to the house key and sends the reveal note'}`);
        const r =
          action === 'bid'
            ? await asBidder(wallet, a, 'bid', { bid_zat: Number(b.bidZat), refund_address: h.addrs[wallet] })
            : await asBidder(wallet, a, 'reveal', {});
        const txids: string[] = action === 'bid' ? [r.txid] : (r.sent as { reveal_txid: string }[]).map((s) => s.reveal_txid);
        const fresh = byId(a.card.auctionId);
        for (const txid of txids) fresh.sent.push({ kind: action, wallet, txid, at: new Date().toISOString() });
        saveAuction(fresh);
        stage(`broadcast ${txids.map((t) => t.slice(0, 10)).join(', ')}…; waiting for a block`);
        setTimeout(() => refreshBalance(wallet), 5_000);
        // The bid amount stays in the bidder's folder: the response carries only the txid and the public commitment.
        return action === 'bid' ? { txid: r.txid, commitment: r.commitment, depositZat: r.deposit_zat } : { txids };
      });
      return json(res, 202, job);
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    const err = e as Error & { code?: number };
    json(res, err.code === 404 ? 404 : 400, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Fuin node on http://127.0.0.1:${PORT}  (zingo-cli ${cfgZ.bin}${cfgZ.lock ? `, lock ${cfgZ.lock}` : ', NO LOCK'})`);
  const problems = setupProblems();
  if (problems.length) console.log(`Setup required: ${problems.join('; ')}`);
  void house().catch((e) => console.error(`house keys: ${(e as Error).message}`));
  void tick();
  setInterval(() => void tick(), 20_000);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
