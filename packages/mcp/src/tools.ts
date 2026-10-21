// An agent bids in a sealed-bid auction through these tools. Its own zingo-cli wallet pays the
// deposit; its openings (bid, salt) stay in SBA_BIDDER_DIR and are never returned in full.
//
// Env: SBA_AUCTION_FILE (published auction JSON, e.g. deployments/testnet.json), SBA_BIDDER_WALLET
// (zingo-cli data dir; needed for `bid`), SBA_BIDDER_DIR (where openings are kept).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { commitment } from '@sba/circuits';
import { checkOutcome, classifyDeposits, decrypt, depositMemo, memoText, quicksend, SETTLEMENT_FEE_BUDGET_ZAT, zingoConfig, type AuctionConfig } from '@sba/service';

interface Published {
  auction: { name: string; auctionId: string; address: string; uivk: string; depositZat: string; reserveZat: string; closeHeight: number; seller: string };
  deposits: { txid: string }[];
  outcome?: { proof: object; publicSignals: string[]; unrevealed?: string[] };
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Setup required: ${name}`);
  return v;
}

function published(): Published {
  const file = need('SBA_AUCTION_FILE');
  if (!existsSync(file)) throw new Error(`Setup required: SBA_AUCTION_FILE (${file} does not exist)`);
  return JSON.parse(readFileSync(file, 'utf8')) as Published;
}

function config(p: Published): AuctionConfig {
  const a = p.auction;
  return { name: a.name, auctionId: BigInt(a.auctionId), address: a.address, uivk: a.uivk, depositZat: BigInt(a.depositZat), reserveZat: BigInt(a.reserveZat), closeHeight: a.closeHeight, sellerAddress: a.seller };
}

const ok = (d: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(d, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] });
const wrap = (fn: () => Promise<unknown>) => fn().then(ok, fail);

export function createServer(): McpServer {
  const server = new McpServer({ name: 'sealed-bid-auction', version: '0.1.0' });

  server.registerTool(
    'auction_status',
    {
      title: 'Auction and its deposits',
      description: "Deposits read live from testnet with the auction's public incoming viewing key: heights, statuses (valid, late, duplicate, wrong_amount, memo_mismatch). Bids are commitments; none is revealed.",
      annotations: { readOnlyHint: true },
    },
    () =>
      wrap(async () => {
        const p = published();
        const cfg = config(p);
        const txs = await decrypt(cfg.uivk, p.deposits.map((d) => d.txid));
        const deposits = classifyDeposits(
          cfg,
          txs.map((t) => {
            const o = t.outputs.find((x) => memoText(x.memo)) ?? t.outputs[0];
            return { txid: t.txid, height: t.height, value: BigInt(o?.value ?? 0), memo: memoText(o?.memo ?? null) };
          }),
        );
        return {
          auction: p.auction.name,
          deposit_zat: p.auction.depositZat,
          reserve_zat: p.auction.reserveZat,
          close_height: p.auction.closeHeight,
          deposits: deposits.map((d) => ({ txid: d.txid, height: d.height, status: d.status, reason: d.reason ?? null })),
        };
      }),
  );

  server.registerTool(
    'bid',
    {
      title: 'Place a sealed bid',
      description: 'Commits to bid_zat with a fresh random salt and sends the fixed deposit to the auction address with the commitment as memo, from SBA_BIDDER_WALLET. The opening is saved in SBA_BIDDER_DIR for the reveal.',
      inputSchema: { bid_zat: z.number().int().positive(), refund_address: z.string().startsWith('utest1') },
    },
    ({ bid_zat, refund_address }) =>
      wrap(async () => {
        const p = published();
        const cfg = config(p);
        if (BigInt(bid_zat) > cfg.depositZat - SETTLEMENT_FEE_BUDGET_ZAT) throw new Error(`bid ${bid_zat} zat is above the deposit (${cfg.depositZat}) minus the fee budget; nothing was sent`);
        if (BigInt(bid_zat) < cfg.reserveZat) throw new Error(`bid ${bid_zat} zat is below the reserve ${cfg.reserveZat}; nothing was sent`);
        const wallet = need('SBA_BIDDER_WALLET');
        const dir = need('SBA_BIDDER_DIR');
        const salt = BigInt('0x' + randomBytes(31).toString('hex'));
        const c = await commitment(cfg.auctionId, BigInt(bid_zat), salt);
        const [txid] = await quicksend(zingoConfig(), wallet, [{ address: cfg.address, amount: cfg.depositZat, memo: depositMemo(cfg.auctionId, c) }]);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(resolve(dir, `${cfg.auctionId}-${txid}.json`), JSON.stringify({ auctionId: cfg.auctionId.toString(), bid: String(bid_zat), salt: salt.toString(), refundAddress: refund_address, txid }), { mode: 0o600 });
        return { sent: true, txid, deposit_zat: cfg.depositZat.toString(), commitment: c, note: 'the bid amount is not visible on-chain; reveal it to the auctioneer after the close' };
      }),
  );

  server.registerTool(
    'verify_result',
    {
      title: "Check the auction's published result",
      description: "Verifies the MaxBid Groth16 proof and checks it is about exactly this auction's deposits as read on-chain with the auction's viewing key: proven slots are the valid deposits in chain order (minus any declared unrevealed), spare slots are empty, and the winner is a real deposit.",
      annotations: { readOnlyHint: true },
    },
    () =>
      wrap(async () => {
        const p = published();
        if (!p.outcome) throw new Error('this auction has no published result yet');
        const cfg = config(p);
        const txs = await decrypt(cfg.uivk, p.deposits.map((d) => d.txid));
        const classified = classifyDeposits(
          cfg,
          txs.map((t) => {
            const o = t.outputs.find((x) => memoText(x.memo)) ?? t.outputs[0];
            return { txid: t.txid, height: t.height, value: BigInt(o?.value ?? 0), memo: memoText(o?.memo ?? null) };
          }),
        );
        const r = await checkOutcome(cfg, classified, p.outcome);
        const ok = (name: string) => r.checks.find((c) => c.name === name)?.ok ?? false;
        return {
          result_holds: r.ok,
          proof_verifies: ok('proof'),
          auction_id_matches: ok('auction'),
          slots_are_the_chain_deposits: ok('slots') && ok('unrevealed'),
          winner_is_a_deposit: ok('winner'),
          winning_bid_zat: r.winningBid.toString(),
          winner_deposit: r.winnerTxid,
          unrevealed: p.outcome.unrevealed ?? [],
          failed: r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
          losing_bids_revealed: false,
        };
      }),
  );

  return server;
}
