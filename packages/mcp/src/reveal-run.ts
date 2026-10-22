// Live auction on Zcash testnet with the encrypted reveal channel, resumable
// (state in .demo/reveal-run-state.json, gitignored):
//   pnpm --filter @sba/mcp reveal-run
//
// The bidders are separate sba-mcp processes, each with only its own wallet and its own openings
// folder (.demo/bidders/<name>): they bid and reveal through the MCP tools. The auctioneer never
// reads a bidder's folder. It learns the openings only by scanning the auction's blocks and
// decrypting the reveal notes with its reveal secret, then proves, settles and publishes
// deployments/testnet-reveal.json.
//
// Also exercised on chain: a deposit transaction that pays the auction twice (bidder3, the second
// payment a duplicate of its commitment), a reveal of one bidder's opening pointed at another
// bidder's deposit (wrong_commitment), a deposit that is never revealed (unrevealed), and a reveal
// sent after the window (late).
//
// Wallets: .demo/wallets/{auction,bidder1,bidder2,bidder3,seller} (zingo-cli data dirs, gitignored).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { commitment, readPublic } from '@sba/circuits';
import {
  address,
  asDeposits,
  asMessages,
  blockTime,
  chainTip,
  checkOutcome,
  classifyDeposits,
  complaintKeyPair,
  decide,
  decrypt,
  depositMemo,
  exportUfvk,
  ingestReveals,
  ironwoodOnly,
  quicksend,
  REVEAL_PREFIX,
  REVEAL_ZAT,
  revealKeyPair,
  scan,
  sealReveal,
  termsAuctionId,
  termsOf,
  uivkOf,
  zingoConfig,
  type AuctionConfig,
} from '@sba/service';

const ROOT = resolve(import.meta.dirname, '../../..');
const WALLETS = resolve(ROOT, '.demo/wallets');
const BIDDERS = resolve(ROOT, '.demo/bidders');
const STATE = resolve(ROOT, '.demo/reveal-run-state.json');
const OUT = resolve(ROOT, 'deployments/testnet-reveal.json');
const MCP = resolve(import.meta.dirname, 'main.ts');
const TSX = resolve(import.meta.dirname, '../node_modules/.bin/tsx');
const cfgZ = zingoConfig();
const DEPOSIT = 200_000n;
const RESERVE = 50_000n;
const CLOSE_AFTER = 30; // blocks from the tip when the auction is created
const REVEAL_BLOCKS = 24;
const DISPUTE_BLOCKS = 60;
const w = (name: string) => resolve(WALLETS, name);
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

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
interface State {
  card?: Card;
  revealSecret?: string;
  uivks: Record<string, string>;
  addrs: Record<string, string>;
  steps: Record<string, unknown>;
  log: string[];
}
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { uivks: {}, addrs: {}, steps: {}, log: [] };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
function say(line: string) {
  console.log(line);
  state.log.push(`${new Date().toISOString()} ${line}`);
  save();
}
/** Runs a step once; its result is kept in the state file so a restart skips it. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (name in state.steps) return state.steps[name] as T;
  const v = await fn();
  state.steps[name] = v;
  save();
  return v;
}

// Transmission failures leave the transaction marked failed in the wallet (nothing was broadcast), so retrying is safe.
const retryable = (m: string) => /insufficient|not enough|Propose send error|Mixnet|no proven exit|spendable|Transmission failed/i.test(m);

/** quicksend that waits out unspendable change and mixnet start-up failures (nothing is sent on those). */
async function send(wallet: string, receivers: Parameters<typeof quicksend>[2]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await quicksend(cfgZ, w(wallet), receivers);
    } catch (e) {
      const m = (e as Error).message;
      if (attempt < 15 && retryable(m)) {
        console.log(`  … ${wallet}: ${m.slice(0, 120)}; retrying in 60 s`);
        await sleep(60);
        continue;
      }
      throw e;
    }
  }
}

/** One MCP tool call as a bidder: its own sba-mcp process, wallet and openings folder. */
async function asBidder(name: string, tool: string, args: Record<string, unknown> = {}) {
  for (let attempt = 0; ; attempt++) {
    const c = new Client({ name: `fuin-${name}`, version: '0' });
    await c.connect(
      new StdioClientTransport({
        command: TSX,
        args: [MCP],
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SBA_AUCTION_FILE: OUT, SBA_BIDDER_WALLET: w(name), SBA_BIDDER_DIR: resolve(BIDDERS, name), ...(process.env.SBA_ZINGO_CLI ? { SBA_ZINGO_CLI: process.env.SBA_ZINGO_CLI } : {}) },
      }),
    );
    try {
      const r = (await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 1_800_000 })) as { isError?: boolean; content: { text: string }[] };
      if (!r.isError) return JSON.parse(r.content[0].text);
      if (attempt < 15 && retryable(r.content[0].text)) {
        console.log(`  … ${name} ${tool}: ${r.content[0].text.slice(0, 120)}; retrying in 60 s`);
        await sleep(60);
        continue;
      }
      throw new Error(`${name} ${tool}: ${r.content[0].text}`);
    } finally {
      await c.close();
    }
  }
}

async function waitFor(what: string, cond: () => Promise<boolean>) {
  for (let i = 0; !(await cond()); i++) {
    if (i % 4 === 0) console.log(`  … waiting: ${what}`);
    await sleep(30);
  }
}
const mined = (uivk: string, txid: string) => async () => {
  const [t] = await decrypt(uivk, [txid]).catch(() => [undefined]);
  return !!t && t.confirmations >= 1;
};

async function main() {
  // 1. Keys and addresses (viewing keys only; nothing here prints a seed).
  for (const name of ['auction', 'bidder1', 'bidder2', 'bidder3', 'seller']) {
    if (!state.uivks[name]) state.uivks[name] = await uivkOf(await exportUfvk(cfgZ, w(name)));
    if (!state.addrs[name]) state.addrs[name] = await address(cfgZ, w(name));
  }
  save();

  // 2. The auctioneer publishes the auction card, including its reveal key.
  if (!state.card) {
    const t = await chainTip();
    const name = `fuin-reveal-${new Date().toISOString().slice(0, 16)}`;
    const keys = revealKeyPair();
    state.revealSecret = keys.secret;
    const terms = {
      name,
      address: state.addrs.auction,
      uivk: state.uivks.auction,
      depositZat: DEPOSIT.toString(),
      reserveZat: RESERVE.toString(),
      openHeight: t,
      closeHeight: t + CLOSE_AFTER,
      revealCloseHeight: t + CLOSE_AFTER + REVEAL_BLOCKS,
      disputeBlocks: DISPUTE_BLOCKS,
      revealKey: keys.public,
      seller: state.addrs.seller,
    };
    // The id is a hash of every term, so no term can change after the bids (Sale 002 predates this: its id hashes the name).
    state.card = { ...terms, auctionId: termsAuctionId(termsOf(terms)).toString() };
    save();
    say(`auction ${name} id ${state.card.auctionId}: deposit ${DEPOSIT} zat, reserve ${RESERVE} zat, open ${t}, close after ${state.card.closeHeight}, reveals until ${state.card.revealCloseHeight}`);
  }
  const card = state.card;
  mkdirSync(dirname(OUT), { recursive: true });
  if (!existsSync(OUT) || !JSON.parse(readFileSync(OUT, 'utf8')).settlement) writeFileSync(OUT, JSON.stringify({ network: 'testnet', auction: card, deposits: [] }, null, 2) + '\n');
  const cfg: AuctionConfig & { closeHeight: number; revealCloseHeight: number } = {
    name: card.name,
    auctionId: BigInt(card.auctionId),
    address: card.address,
    uivk: card.uivk,
    depositZat: DEPOSIT,
    reserveZat: RESERVE,
    closeHeight: card.closeHeight,
    revealCloseHeight: card.revealCloseHeight,
    sellerAddress: card.seller,
  };

  // 3. Bids. bidder1 and bidder2 through their MCP servers.
  const b1 = await step('bid:bidder1', () => asBidder('bidder1', 'bid', { bid_zat: 120_000, refund_address: state.addrs.bidder1 }));
  say(`bidder1 bid via MCP: deposit ${b1.txid}`);
  const b2 = await step('bid:bidder2', () => asBidder('bidder2', 'bid', { bid_zat: 135_000, refund_address: state.addrs.bidder2 }));
  say(`bidder2 bid via MCP: deposit ${b2.txid}`);
  // bidder3 pays the auction twice in one transaction: its bid and, by mistake, the same commitment again.
  const b3 = await step('bid:bidder3', async () => {
    const salt = BigInt('0x' + randomBytes(31).toString('hex'));
    const c = await commitment(cfg.auctionId, 90_000n, salt);
    const memo = depositMemo(cfg.auctionId, c);
    const [txid] = await send('bidder3', [
      { address: card.address, amount: DEPOSIT, memo },
      { address: card.address, amount: DEPOSIT, memo },
    ]);
    const k = complaintKeyPair();
    return { txid, bid: '90000', salt: salt.toString(), complaintKey: k.public, complaintSecret: k.secret };
  });
  say(`bidder3 pays the auction twice in one transaction: ${b3.txid}`);
  // A deposit that is never revealed (bidder2's second bid, opening discarded).
  const noShow = await step('bid:no-show', async () => {
    const salt = BigInt('0x' + randomBytes(31).toString('hex'));
    const [txid] = await send('bidder2', [{ address: card.address, amount: DEPOSIT, memo: depositMemo(cfg.auctionId, await commitment(cfg.auctionId, 60_000n, salt)) }]);
    return { txid };
  });
  say(`bidder2 sends a deposit it will never reveal: ${noShow.txid}`);
  for (const t of [b1.txid, b2.txid, b3.txid, noShow.txid]) await waitFor(`deposit ${t.slice(0, 10)} mined`, mined(card.uivk, t));

  // bidder3 files its opening under the name of its valid deposit (the first of its two payments in chain order).
  const b3Deposit = await step('bidder3:deposit-name', async () => {
    const [t] = await decrypt(card.uivk, [b3.txid]);
    const mine = classifyDeposits(cfg, asDeposits(t));
    const valid = mine.find((d) => d.status === 'valid');
    if (!valid || mine.length !== 2) throw new Error(`bidder3's transaction should read as 2 payments, one valid: ${JSON.stringify(mine.map((d) => [d.ref, d.status]))}`);
    mkdirSync(resolve(BIDDERS, 'bidder3'), { recursive: true, mode: 0o700 });
    writeFileSync(
      resolve(BIDDERS, 'bidder3', `${cfg.auctionId}-${b3.txid}.json`),
      JSON.stringify({ auctionId: card.auctionId, bid: b3.bid, salt: b3.salt, refundAddress: state.addrs.bidder3, txid: valid.ref, complaintKey: b3.complaintKey, complaintSecret: b3.complaintSecret }),
      { mode: 0o600 },
    );
    return valid.ref;
  });
  say(`bidder3's deposit transaction reads as two payments; its bid is ${b3Deposit}`);

  // 4. The reveal window.
  await waitFor(`the close (block ${card.closeHeight})`, async () => (await chainTip()) >= card.closeHeight);
  for (const name of ['bidder1', 'bidder2', 'bidder3']) {
    const r = await step(`reveal:${name}`, () => asBidder(name, 'reveal'));
    say(`${name} reveals via MCP: ${JSON.stringify(r.sent)}`);
  }
  // bidder3 points its own opening at bidder2's deposit: it decrypts, but hashes to another commitment.
  const attack = await step('reveal:attack', async () => {
    const { memo } = sealReveal(cfg.auctionId, card.revealKey, b2.txid, { bid: BigInt(b3.bid), salt: BigInt(b3.salt), refundAddress: state.addrs.bidder3, complaintKey: b3.complaintKey });
    const [txid] = await send('bidder3', [{ address: card.address, amount: REVEAL_ZAT, memo }]);
    return { txid };
  });
  say(`bidder3 sends a reveal of its opening naming bidder2's deposit: ${attack.txid}`);

  // 5. After the window: bidder1 re-sends its reveal, which is late.
  await waitFor(`the end of the reveal window (block ${card.revealCloseHeight})`, async () => (await chainTip()) >= card.revealCloseHeight);
  const late = await step('reveal:late', async () => {
    const f = readdirSync(resolve(BIDDERS, 'bidder1')).find((x) => x.startsWith(`${cfg.auctionId}-`))!;
    const o = JSON.parse(readFileSync(resolve(BIDDERS, 'bidder1', f), 'utf8'));
    const { memo } = sealReveal(cfg.auctionId, card.revealKey, o.txid, { bid: BigInt(o.bid), salt: BigInt(o.salt), refundAddress: o.refundAddress, complaintKey: o.complaintKey });
    const [txid] = await send('bidder1', [{ address: card.address, amount: REVEAL_ZAT, memo }]);
    return { txid };
  });
  say(`bidder1 re-sends its reveal after the window: ${late.txid}`);
  await waitFor(`late reveal ${late.txid.slice(0, 10)} mined`, mined(card.uivk, late.txid));

  // 6. The auctioneer: everything it knows comes from scanning the chain and its reveal secret.
  const tipNow = await chainTip();
  const found = await scan(card.uivk, card.openHeight, tipNow);
  const deposits = classifyDeposits(cfg, found.flatMap(asDeposits));
  const messages = found.flatMap((t) => asMessages(t, `${REVEAL_PREFIX}:`));
  const { reveals, log } = await ingestReveals(cfg, state.revealSecret!, deposits, messages);
  for (const d of deposits) say(`  deposit ${d.ref.slice(0, 10)}${d.output === undefined ? '' : `:${d.output}`} at ${d.height}: ${d.status}`);
  for (const l of log) say(`  reveal ${l.ref.slice(0, 10)} at ${l.height} for ${l.deposit?.slice(0, 10)}${l.deposit && l.deposit.length > 64 ? l.deposit.slice(64) : ''}: ${l.status}${l.reason ? ` (${l.reason})` : ''}`);
  const revealTx = (name: string) => (state.steps[`reveal:${name}`] as { sent: { reveal_txid: string }[] }).sent[0].reveal_txid;
  const want: Record<string, string> = { [revealTx('bidder1')]: 'accepted', [revealTx('bidder2')]: 'accepted', [revealTx('bidder3')]: 'accepted', [attack.txid]: 'wrong_commitment', [late.txid]: 'late' };
  for (const [tx, st] of Object.entries(want)) {
    const got = log.find((l) => l.txid === tx)?.status;
    if (got !== st) throw new Error(`reveal ${tx}: expected ${st}, the auctioneer says ${got}`);
  }

  if (!state.steps.settlement) {
    const o = await decide(cfg, deposits, reveals);
    if (JSON.stringify(o.unrevealed) !== JSON.stringify([noShow.txid])) throw new Error(`expected exactly the no-show deposit unrevealed, got ${o.unrevealed}`);
    say(`winner: bid ${o.winningBid} zat; unrevealed: ${o.unrevealed.join(', ')}; MaxBid proof verifies`);
    state.steps.outcome = { winnerCommitment: o.winnerCommitment, winningBid: o.winningBid.toString(), proof: o.proof, publicSignals: o.publicSignals, unrevealed: o.unrevealed };
    save();
    const txids = await send('auction', o.payouts.map((p) => ({ address: p.address, amount: p.amount, memo: p.memo })));
    state.steps.settlement = { txids, payouts: o.payouts.map((p) => ({ ...p, amount: p.amount.toString() })) };
    save();
    say(`settlement tx ${txids[0]}: ${o.payouts.length} outputs`);
  }
  const settlement = state.steps.settlement as { txids: string[]; payouts: { address: string; amount: string; why: string }[] };
  const outcome = state.steps.outcome as { winnerCommitment: string; winningBid: string; proof: object; publicSignals: string[]; unrevealed: string[] };
  await waitFor(`settlement ${settlement.txids[0].slice(0, 10)} mined`, async () => {
    const [t] = await decrypt(state.uivks.seller, [settlement.txids[0]]).catch(() => [undefined]);
    return !!t && t.confirmations >= 1;
  });
  const [settle] = await decrypt(state.uivks.seller, [settlement.txids[0]]);

  // 7. Each recipient checks its own outputs with its own viewing key.
  const who: Record<string, string> = Object.fromEntries(['seller', 'bidder1', 'bidder2', 'bidder3'].map((n) => [state.addrs[n], n]));
  const checks = [];
  for (const [addr, name] of Object.entries(who)) {
    const expected = settlement.payouts.filter((p) => p.address === addr).map((p) => Number(p.amount)).sort((x, y) => x - y);
    const [t] = await decrypt(state.uivks[name], [settlement.txids[0]]);
    const seen = t.outputs.map((x) => x.value).sort((x, y) => x - y);
    const ok = JSON.stringify(seen) === JSON.stringify(expected);
    checks.push({ recipient: name, expected: expected.join('+') || '0', seen, ok });
    say(`viewing-key check: ${name} sees ${seen.join(' + ') || 'nothing'} zat (expected ${expected.join(' + ') || 'nothing'}) ${ok ? '✓' : '✗'}`);
    if (!ok) throw new Error(`${name}'s settlement outputs do not match`);
  }
  const result = await checkOutcome(cfg, deposits, outcome);
  for (const c of result.checks) say(`result check ${c.name}: ${c.ok ? 'ok' : 'FAILED'} (${c.detail})`);
  if (!result.ok) throw new Error('the outcome fails its own check');
  const all = await decrypt(card.uivk, [...new Set([...found.map((t) => t.txid), settlement.txids[0]])]);
  const allIronwood = all.every(ironwoodOnly);
  const pub = readPublic(outcome.publicSignals);
  // An earlier attempt was abandoned when lightwalletd transmission failures held its deposits in the
  // mempool past its close; they were mined in this auction's first block and read as memo mismatches.
  const abandoned = new Set(((state as { abandoned?: { steps: Record<string, { txid?: string }> }[] }).abandoned ?? []).flatMap((x) => Object.values(x.steps).map((v) => v?.txid ?? '')));
  const labels: Record<string, string> = {
    [b1.txid]: 'bidder1 sealed bid (via MCP)',
    [b2.txid]: 'bidder2 sealed bid (via MCP)',
    [b3Deposit]: 'bidder3 sealed bid (first payment of a two-payment transaction)',
    [noShow.txid]: 'bidder2 second bid, never revealed',
  };
  const revealLabels: Record<string, string> = {
    [attack.txid]: "bidder3's opening pointed at bidder2's deposit",
    [late.txid]: "bidder1's reveal re-sent after the window",
  };
  for (const name of ['bidder1', 'bidder2', 'bidder3']) {
    for (const f of readdirSync(resolve(BIDDERS, name)).filter((x) => x.startsWith(`${cfg.auctionId}-`))) {
      const o = JSON.parse(readFileSync(resolve(BIDDERS, name, f), 'utf8'));
      if (o.revealTxid) revealLabels[o.revealTxid] = `${name} reveal (via MCP)`;
    }
  }
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        network: 'testnet',
        auction: card,
        deposits: deposits.map((d) => ({ txid: d.txid, ...(d.output === undefined ? {} : { output: d.output }), height: d.height, valueZat: d.value.toString(), memo: d.memo, status: d.status, reason: d.reason ?? null, label: labels[d.ref] ?? (d.txid === b3.txid ? 'bidder3 second payment of the same commitment' : abandoned.has(d.txid) ? 'deposit for an earlier, abandoned attempt (mined after its close)' : null) })),
        reveals: log.map((l) => ({ ...l, label: revealLabels[l.txid] ?? null })),
        outcome: { winnerSlot: pub.winner, winningBidZat: pub.winningBid.toString(), reserveZat: pub.reserve.toString(), commitments: pub.commitments, proof: outcome.proof, publicSignals: outcome.publicSignals, unrevealed: outcome.unrevealed, proofVerifies: result.checks[0].ok, slotsMatchDeposits: result.ok },
        settlement: { txid: settlement.txids[0], height: settle.height, outputs: settlement.payouts.map((p) => ({ amountZat: p.amount, why: p.why, recipient: who[p.address] })), viewingKeyChecks: checks },
        ironwoodOnly: allIronwood,
        blockTimes: { open: await blockTime(card.openHeight), close: await blockTime(card.closeHeight), revealClose: await blockTime(card.revealCloseHeight), settlement: await blockTime(settle.height!) },
      },
      null,
      2,
    ) + '\n',
  );
  say('wrote deployments/testnet-reveal.json');
}

// snarkjs keeps its bn128 worker threads alive after proving, so exit explicitly.
main().then(() => process.exit(0)).catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
