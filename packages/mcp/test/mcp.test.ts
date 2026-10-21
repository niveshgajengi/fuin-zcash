// Real MCP client ↔ real sba-mcp (stdio) ↔ live Zcash testnet (lightwalletd via sba-verify).
// Uses the published auction in deployments/testnet.json; no deposit is sent by these tests.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const AUCTION = resolve(ROOT, 'deployments/testnet.json');
const run = JSON.parse(readFileSync(AUCTION, 'utf8')) as { deposits: { txid: string; status: string; label: string }[]; outcome: { winningBidZat: string } };
let client: Client;

async function connect(env: Record<string, string>) {
  const c = new Client({ name: 'sba-test', version: '0' });
  await c.connect(new StdioClientTransport({ command: resolve(__dirname, '../node_modules/.bin/tsx'), args: [resolve(__dirname, '../src/main.ts')], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } }));
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError, text: r.content[0].text };
};

beforeAll(async () => {
  client = await connect({ SBA_AUCTION_FILE: AUCTION });
});
afterAll(async () => client?.close());

describe('sba-mcp', () => {
  it('lists its tools', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['auction_status', 'bid', 'verify_result']);
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
});
