// Real MCP client ↔ real sba-mcp (stdio) ↔ live Zcash testnet (lightwalletd via sba-verify).
// Uses the published auction in deployments/testnet.json; no deposit is sent by these tests.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const AUCTION = resolve(ROOT, 'deployments/testnet.json');
const run = JSON.parse(readFileSync(AUCTION, 'utf8')) as { deposits: { txid: string; status: string }[]; outcome: { winningBidZat: string } };
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

  it('auction_status reads the deposits live with the auction viewing key', async () => {
    const r = JSON.parse((await call(client, 'auction_status')).text);
    const live = Object.fromEntries(r.deposits.map((d: { txid: string; status: string }) => [d.txid, d.status]));
    expect(live).toEqual(Object.fromEntries(run.deposits.map((d) => [d.txid, d.status])));
  }, 180_000);

  it('verify_result checks the proof and that its commitments are the on-chain memos', async () => {
    const r = JSON.parse((await call(client, 'verify_result')).text);
    expect(r).toMatchObject({ proof_verifies: true, commitments_match_chain: true, auction_id_matches: true, losing_bids_revealed: false, winning_bid_zat: run.outcome.winningBidZat });
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
});
