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
import { asDeposit, chainTip, checkOutcome, classifyDeposits, depositMemo, quicksend, scan, SETTLEMENT_FEE_BUDGET_ZAT, zingoConfig, type AuctionConfig } from '@sba/service';

interface Published {
  auction: { name: string; auctionId: string; address: string; uivk: string; depositZat: string; reserveZat: string; openHeight?: number; closeHeight: number; seller: string };
  deposits: { txid: string }[];
  settlement?: { height: number };
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

/**
 * Every deposit to the auction, found by scanning its blocks with the published viewing key (from
 * the open height to the settlement, or to the tip while it is unsettled), so the list does not
 * depend on the auctioneer. Also says which of them the published record leaves out.
 */
async function depositsOnChain(p: Published) {
  const cfg = config(p);
  if (typeof p.auction.openHeight !== 'number') throw new Error('Setup required: auction.openHeight in SBA_AUCTION_FILE (the block to start scanning from)');
  const end = p.settlement?.height ?? (await chainTip());
  const found = await scan(cfg.uivk, p.auction.openHeight, end);
  const classified = classifyDeposits(cfg, found.map(asDeposit));
  const listed = new Set(p.deposits.map((d) => d.txid));
  const onChain = new Set(found.map((t) => t.txid));
  return {
    cfg,
    classified,
    scanned: `${p.auction.openHeight}-${end}`,
    notListed: [...onChain].filter((t) => !listed.has(t)),
    notOnChain: [...listed].filter((t) => !onChain.has(t)),
  };
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
      description: "Every deposit to the auction, found live on testnet by scanning the auction's blocks with its public incoming viewing key: heights, statuses (valid, late, duplicate, wrong_amount, memo_mismatch), and any deposit the published record leaves out. Bids are commitments; none is revealed.",
      annotations: { readOnlyHint: true },
    },
    () =>
      wrap(async () => {
        const p = published();
        const { classified: deposits, scanned, notListed } = await depositsOnChain(p);
        return {
          auction: p.auction.name,
          deposit_zat: p.auction.depositZat,
          reserve_zat: p.auction.reserveZat,
          close_height: p.auction.closeHeight,
          blocks_scanned: scanned,
          deposits: deposits.map((d) => ({ txid: d.txid, height: d.height, status: d.status, reason: d.reason ?? null })),
          missing_from_published_record: notListed,
        };
      }),
  );

  server.registerTool(
    'bid',
    {
      title: 'Place a sealed bid',
      description: 'Refuses if the auction has closed. Otherwise commits to bid_zat with a fresh random salt and sends the fixed deposit to the auction address with the commitment as memo, from SBA_BIDDER_WALLET. The opening is saved in SBA_BIDDER_DIR for the reveal.',
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
        const tip = await chainTip();
        // The deposit is mined at tip + 1 at the earliest; after closeHeight it would be late.
        if (tip >= cfg.closeHeight) throw new Error(`the auction closed after block ${cfg.closeHeight} and the chain is at ${tip}; a deposit now would be late, so nothing was sent`);
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
        const { cfg, classified, notListed, notOnChain } = await depositsOnChain(p);
        const r = await checkOutcome(cfg, classified, p.outcome);
        const ok = (name: string) => r.checks.find((c) => c.name === name)?.ok ?? false;
        return {
          result_holds: r.ok && notListed.length === 0 && notOnChain.length === 0,
          record_lists_every_chain_deposit: notListed.length === 0 && notOnChain.length === 0,
          proof_verifies: ok('proof'),
          auction_id_matches: ok('auction'),
          slots_are_the_chain_deposits: ok('slots') && ok('unrevealed'),
          winner_is_a_deposit: ok('winner'),
          winning_bid_zat: r.winningBid.toString(),
          winner_deposit: r.winnerTxid,
          unrevealed: p.outcome.unrevealed ?? [],
          failed: [
            ...r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
            ...notListed.map((t) => `deposit ${t} is on chain but not in the published record`),
            ...notOnChain.map((t) => `listed deposit ${t} is not on chain in the auction's blocks`),
          ],
          losing_bids_revealed: false,
        };
      }),
  );

  return server;
}
