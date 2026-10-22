// Real MCP client ↔ real sba-mcp (stdio) ↔ live Zcash testnet (lightwalletd via sba-verify).
// Uses the published auction in deployments/testnet.json; no deposit is sent by these tests.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainTip, termsAuctionId, termsOf } from '@sba/service';

const ROOT = resolve(__dirname, '../../..');
const AUCTION = resolve(ROOT, 'deployments/testnet.json');
const run = JSON.parse(readFileSync(AUCTION, 'utf8')) as { deposits: { txid: string; status: string; label: string }[]; outcome: { winningBidZat: string } };
let client: Client;

async function connect(env: Record<string, string>) {
  const c = new Client({ name: 'sba-test', version: '0' });
  await c.connect(new StdioClientTransport({ command: resolve(__dirname, '../node_modules/.bin/tsx'), args: [resolve(__dirname, '../src/main.ts')], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } }));
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}, timeout = 60_000) => {
  const r = (await c.callTool({ name, arguments: args }, undefined, { timeout })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError, text: r.content[0].text };
};

beforeAll(async () => {
  client = await connect({ SBA_AUCTION_FILE: AUCTION });
});
afterAll(async () => client?.close());

describe('sba-mcp', () => {
  it('lists its tools', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['auction_status', 'bid', 'complain', 'reveal', 'verify_result']);
  });

  it('auction_status finds the deposits by scanning the auction blocks with its viewing key', async () => {
    const r = JSON.parse((await call(client, 'auction_status')).text);
    const live = Object.fromEntries(r.deposits.map((d: { txid: string; status: string }) => [d.txid, d.status]));
    expect(live).toEqual(Object.fromEntries(run.deposits.map((d) => [d.txid, d.status])));
    expect(r.missing_from_published_record).toEqual([]);
    expect(r.blocks_scanned).toBe('4522258-4522291');
  }, 180_000);

  it('verify_result checks the proof and that it is about exactly the on-chain deposits', async () => {
    const r = JSON.parse((await call(client, 'verify_result')).text);
    expect(r).toMatchObject({ result_holds: true, proof_verifies: true, slots_are_the_chain_deposits: true, winner_is_a_deposit: true, auction_id_matches: true, failed: [], losing_bids_revealed: false, winning_bid_zat: run.outcome.winningBidZat });
    expect(r.winner_deposit).toBe(run.deposits.find((d) => d.label === 'bidder2 sealed bid')?.txid);
  }, 180_000);

  it('bid refuses out-of-range bids before sending anything, and names missing settings', async () => {
    const tooHigh = await call(client, 'bid', { bid_zat: 1_990_000, refund_address: 'utest1x' });
    expect(tooHigh.isError).toBe(true);
    expect(tooHigh.text).toMatch(/above the deposit .* nothing was sent/);
    const tooLow = await call(client, 'bid', { bid_zat: 1000, refund_address: 'utest1x' });
    expect(tooLow.text).toMatch(/below the reserve .* nothing was sent/);
    const noWallet = await call(client, 'bid', { bid_zat: 1_000_000, refund_address: 'utest1x' });
    expect(noWallet.text).toMatch(/Setup required: SBA_BIDDER_WALLET/);
    const bare = await connect({});
    expect((await call(bare, 'auction_status')).text).toMatch(/Setup required: SBA_AUCTION_FILE/);
    await bare.close();
  }, 60_000);

  it('bid refuses a deposit into an auction that has closed (live chain tip), before zingo-cli runs', async () => {
    const bidder = await connect({ SBA_AUCTION_FILE: AUCTION, SBA_BIDDER_WALLET: '/nonexistent/fuin-wallet', SBA_BIDDER_DIR: '/nonexistent/fuin-openings' });
    const closed = await call(bidder, 'bid', { bid_zat: 1_000_000, refund_address: 'utest1x' });
    await bidder.close();
    expect(closed.isError).toBe(true);
    expect(closed.text).toMatch(/closed after block 4522278 .* nothing was sent/);
  }, 60_000);

  it('bid recomputes the auction id from the published terms before sending: a term changed after the id was fixed, or a legacy name-only id, is refused before zingo-cli runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuin-terms-'));
    try {
      const rec = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet-reveal.json'), 'utf8'));
      const open = { ...rec.auction, closeHeight: 99_000_000, revealCloseHeight: 99_000_024 };
      const bound = { ...open, auctionId: termsAuctionId(termsOf(open)).toString() };
      const tryBid = async (auction: object) => {
        const file = join(dir, 'auction.json');
        writeFileSync(file, JSON.stringify({ ...rec, auction, settlement: undefined, outcome: undefined }));
        const c = await connect({ SBA_AUCTION_FILE: file, SBA_BIDDER_WALLET: '/nonexistent/fuin-wallet', SBA_BIDDER_DIR: join(dir, 'openings') });
        const r = await call(c, 'bid', { bid_zat: 100_000, refund_address: rec.auction.seller });
        await c.close();
        return r;
      };
      const moved = await tryBid({ ...bound, revealCloseHeight: 99_000_030 });
      expect(moved.isError).toBe(true);
      expect(moved.text).toBe(`the auction id ${bound.auctionId} is not the hash of these terms (that would be ${termsAuctionId(termsOf({ ...open, revealCloseHeight: 99_000_030 }))}) nor of the name alone: a term was changed after the id was fixed; nothing was sent`);
      const legacy = await tryBid(open);
      expect(legacy.text).toMatch(/^this auction's id hashes only its name, so its close, reveal window and reserve could be changed after you bid; nothing was sent$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('bid refuses a refund address too long to fit a reveal (any UA with a Sapling or transparent receiver), before reading any setting', async () => {
    for (const len of [151, 182, 217]) {
      const r = await call(client, 'bid', { bid_zat: 1_000_000, refund_address: 'utest1' + 'q'.repeat(len - 6) });
      expect(r.isError).toBe(true);
      expect(r.text).toBe(`refund address is ${len} characters; a reveal holds at most 150 (an Orchard-only unified address fits, one with a Sapling or transparent receiver does not), so this deposit could never be revealed or refunded; nothing was sent`);
    }
  });

  describe('bid saves the opening before it sends (open auction, bound terms, live chain tip)', () => {
    let dir: string;
    let file: string;
    const rec = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet-reveal.json'), 'utf8'));
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'fuin-save-'));
      const tip = await chainTip();
      const open = { ...rec.auction, openHeight: tip - 3, closeHeight: 99_000_000, revealCloseHeight: 99_000_024 };
      file = join(dir, 'auction.json');
      writeFileSync(file, JSON.stringify({ network: 'testnet', auction: { ...open, auctionId: termsAuctionId(termsOf(open)).toString() }, deposits: [] }));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('an openings folder that cannot be written fails before any wallet call', async () => {
      const notADir = join(dir, 'a-file');
      writeFileSync(notADir, '');
      const c = await connect({ SBA_AUCTION_FILE: file, SBA_BIDDER_WALLET: '/nonexistent/fuin-wallet', SBA_BIDDER_DIR: join(notADir, 'openings'), SBA_ZINGO_CLI: '/nonexistent/zingo-cli' });
      const r = await call(c, 'bid', { bid_zat: 100_000, refund_address: rec.auction.seller });
      await c.close();
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^cannot save the opening in SBA_BIDDER_DIR \(ENOTDIR[^)]*\); without it the deposit could never be revealed, so nothing was sent$/);
    }, 120_000);

    it('a send that fails keeps the opening (mode 0600) marked "send failed, may still be mined" (fault injection: zingo-cli path that does not exist)', async () => {
      const openings = join(dir, 'openings');
      const c = await connect({ SBA_AUCTION_FILE: file, SBA_BIDDER_WALLET: '/nonexistent/fuin-wallet', SBA_BIDDER_DIR: openings, SBA_ZINGO_CLI: '/nonexistent/zingo-cli' });
      const r = await call(c, 'bid', { bid_zat: 100_000, refund_address: rec.auction.seller });
      await c.close();
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^zingo-cli quicksend failed: .*; the opening is kept in SBA_BIDDER_DIR in case the deposit is mined anyway \(reveal finds it by its commitment\)$/);
      const files = readdirSync(openings);
      expect(files).toHaveLength(1);
      expect(statSync(join(openings, files[0])).mode & 0o777).toBe(0o600);
      const saved = JSON.parse(readFileSync(join(openings, files[0]), 'utf8'));
      expect(saved).toMatchObject({ bid: '100000', refundAddress: rec.auction.seller, txid: null, status: expect.stringMatching(/^send failed, may still be mined: zingo-cli quicksend failed/) });
      expect(saved.salt).toMatch(/^\d+$/);
      expect(saved.complaintSecret).toMatch(/^[0-9a-f]{64}$/);
    }, 120_000);
  });

  it('reveal looks up an opening whose send reported no txid by its commitment on chain, and does not reveal one with no deposit (live chain tip)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuin-find-'));
    try {
      const rec = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet-reveal.json'), 'utf8'));
      const tip = await chainTip();
      const file = join(dir, 'auction.json');
      // An auction that opened two blocks ago and is in its reveal window: its blocks hold no deposit with this commitment.
      writeFileSync(file, JSON.stringify({ network: 'testnet', auction: { ...rec.auction, openHeight: tip - 2, closeHeight: tip - 1, revealCloseHeight: 99_000_000 }, deposits: [] }));
      const name = join(dir, `${rec.auction.auctionId}-cfailed.json`);
      writeFileSync(name, JSON.stringify({ auctionId: rec.auction.auctionId, bid: '100000', salt: '7', refundAddress: rec.auction.seller, txid: null, commitment: rec.deposits[4].memo.split(':')[2], status: 'send failed, may still be mined: test', complaintKey: '11'.repeat(32), complaintSecret: '22'.repeat(32) }), { mode: 0o600 });
      const c = await connect({ SBA_AUCTION_FILE: file, SBA_BIDDER_WALLET: '/nonexistent/fuin-wallet', SBA_BIDDER_DIR: dir, SBA_ZINGO_CLI: '/nonexistent/zingo-cli' });
      const r = await call(c, 'reveal', {}, 120_000);
      await c.close();
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(r.text)).toMatchObject({ sent: [], not_on_chain: [name], note: expect.stringMatching(/1 opening\(s\) have no deposit on chain with their commitment and were not revealed$/) });
      expect(JSON.parse(readFileSync(name, 'utf8'))).toMatchObject({ txid: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('reveal refuses outside the reveal window (live chain tip) and on an auction with no channel, before zingo-cli runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuin-reveal-'));
    try {
      const rec = JSON.parse(readFileSync(AUCTION, 'utf8'));
      const opening = { auctionId: rec.auction.auctionId, bid: '1000000', salt: '7', refundAddress: rec.auction.seller, txid: rec.deposits[0].txid, complaintKey: '11'.repeat(32), complaintSecret: '22'.repeat(32) };
      writeFileSync(join(dir, `${rec.auction.auctionId}-${opening.txid}.json`), JSON.stringify(opening));
      const env = (file: string) => ({ SBA_AUCTION_FILE: file, SBA_BIDDER_WALLET: '/nonexistent/fuin-wallet', SBA_BIDDER_DIR: dir });
      const tryReveal = async (auction: object) => {
        const file = join(dir, 'auction.json');
        writeFileSync(file, JSON.stringify({ ...rec, auction: { ...rec.auction, ...auction } }));
        const c = await connect(env(file));
        const r = await call(c, 'reveal');
        await c.close();
        return r;
      };
      const none = await connect(env(AUCTION));
      expect((await call(none, 'reveal')).text).toMatch(/no reveal channel .* nothing was sent/);
      await none.close();
      const key = '33'.repeat(32);
      const late = await tryReveal({ revealKey: key, revealCloseHeight: rec.auction.closeHeight + 10 });
      expect(late.isError).toBe(true);
      expect(late.text).toMatch(/reveal window closed at block \d+ .* would be late, so nothing was sent/);
      const early = await tryReveal({ revealKey: key, closeHeight: 99_000_000, revealCloseHeight: 99_000_010 });
      expect(early.text).toMatch(/closes after block 99000000 .* would be early, so nothing was sent/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('complain refuses outside the dispute window (live chain tip) and on an auction with no dispute window, before zingo-cli runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuin-complain-'));
    try {
      const rec = JSON.parse(readFileSync(AUCTION, 'utf8'));
      const opening = { auctionId: rec.auction.auctionId, bid: '1000000', salt: '7', refundAddress: rec.auction.seller, txid: rec.deposits[0].txid, complaintKey: '11'.repeat(32), complaintSecret: '22'.repeat(32), revealTxid: '44'.repeat(32), revealSecret: '55'.repeat(32) };
      writeFileSync(join(dir, `${rec.auction.auctionId}-${opening.txid}.json`), JSON.stringify(opening));
      const file = join(dir, 'auction.json');
      writeFileSync(file, JSON.stringify({ ...rec, auction: { ...rec.auction, revealKey: '33'.repeat(32), revealCloseHeight: rec.auction.closeHeight + 10, disputeBlocks: 30 } }));
      const env = (f: string) => ({ SBA_AUCTION_FILE: f, SBA_BIDDER_WALLET: '/nonexistent/fuin-wallet', SBA_BIDDER_DIR: dir });
      const none = await connect(env(AUCTION));
      expect((await call(none, 'complain')).text).toMatch(/no reveal channel or dispute window; nothing was sent/);
      await none.close();
      const closed = await connect(env(file));
      const r = await call(closed, 'complain');
      await closed.close();
      expect(r.isError).toBe(true);
      expect(r.text).toBe(`the dispute window closed at block ${rec.settlement.height + 30} and the chain is at ${r.text.match(/chain is at (\d+)/)?.[1]}; nothing was sent`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('complain publishes no viewing key unless asked, and then only a separate refund wallet\'s: it refuses the bidding wallet before any wallet call', async () => {
    const tools = (await client.listTools()).tools;
    const complain = tools.find((t) => t.name === 'complain')!;
    expect(complain.description).toMatch(/publishes no viewing key/);
    expect(complain.description).toMatch(/every incoming payment to that wallet, past and future/);
    expect(Object.keys((complain.inputSchema as { properties?: object }).properties ?? {})).toEqual(['include_refund_key']);
    const dir = mkdtempSync(join(tmpdir(), 'fuin-refundkey-'));
    try {
      const rec = JSON.parse(readFileSync(AUCTION, 'utf8'));
      const file = join(dir, 'auction.json');
      writeFileSync(file, JSON.stringify({ ...rec, auction: { ...rec.auction, revealKey: '33'.repeat(32), revealCloseHeight: rec.auction.closeHeight + 10, disputeBlocks: 30 } }));
      const env = { SBA_AUCTION_FILE: file, SBA_BIDDER_WALLET: join(dir, 'bidder-wallet'), SBA_BIDDER_DIR: dir };
      const noRefundWallet = await connect(env);
      expect((await call(noRefundWallet, 'complain', { include_refund_key: true })).text).toBe('Setup required: SBA_REFUND_WALLET (a wallet that receives only this auction\'s refunds; its incoming viewing key is published with the complaint)');
      await noRefundWallet.close();
      const same = await connect({ ...env, SBA_REFUND_WALLET: join(dir, 'bidder-wallet/') });
      const r = await call(same, 'complain', { include_refund_key: true });
      await same.close();
      expect(r.isError).toBe(true);
      expect(r.text).toBe('SBA_REFUND_WALLET is the bidding wallet: its incoming viewing key would publish every payment the bidder ever receives; use a wallet that receives only refunds; nothing was sent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('verify_result reads the settlement height from the chain: a record that understates it, so the scan misses a deposit it leaves out, does not hold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuin-height-'));
    try {
      const rec = JSON.parse(readFileSync(AUCTION, 'utf8'));
      const late = rec.deposits.find((d: { status: string }) => d.status === 'late');
      rec.deposits = rec.deposits.filter((d: { txid: string }) => d.txid !== late.txid);
      rec.settlement = { ...rec.settlement, height: late.height - 4 };
      const file = join(dir, 'auction.json');
      writeFileSync(file, JSON.stringify(rec));
      const c = await connect({ SBA_AUCTION_FILE: file });
      const r = JSON.parse((await call(c, 'verify_result')).text);
      await c.close();
      expect(r.result_holds).toBe(false);
      expect(r.settlement_mined_as_recorded).toBe(false);
      expect(r.failed).toContain(`settlement ${rec.settlement.txid} is mined at block 4522291; the record says ${late.height - 4}`);
      expect(r.failed).toContain(`deposit ${late.txid} is on chain but not in the published record`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('verify_result: a record whose scannedTo stops inside the reveal window does not hold (live)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuin-scanned-'));
    try {
      const rec = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet-reveal.json'), 'utf8'));
      const file = join(dir, 'auction.json');
      writeFileSync(file, JSON.stringify({ ...rec, scannedTo: rec.auction.revealCloseHeight - 1 }));
      const c = await connect({ SBA_AUCTION_FILE: file });
      const r = JSON.parse((await call(c, 'verify_result')).text);
      await c.close();
      expect(r.result_holds).toBe(false);
      expect(r.failed).toContain(`the record covers blocks up to ${rec.auction.revealCloseHeight - 1}, before the end of the reveal window (block ${rec.auction.revealCloseHeight})`);
      expect(r.deposits_after_the_record).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('verify_result holds on the reveal-channel auction: two-payment deposit read per payment, one deposit declared unrevealed', async () => {
    const c = await connect({ SBA_AUCTION_FILE: resolve(ROOT, 'deployments/testnet-reveal.json') });
    const r = JSON.parse((await call(c, 'verify_result')).text);
    const s = JSON.parse((await call(c, 'auction_status')).text);
    await c.close();
    expect(r).toMatchObject({ result_holds: true, record_lists_every_chain_deposit: true, winning_bid_zat: '135000', failed: [] });
    expect(r.unrevealed).toHaveLength(1);
    const two = s.deposits.filter((d: { output?: string; status: string }) => d.output !== undefined && d.status !== 'memo_mismatch');
    expect(two.map((d: { status: string }) => d.status)).toEqual(['valid', 'duplicate']);
  }, 180_000);
});
