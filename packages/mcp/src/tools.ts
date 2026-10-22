// An agent bids in a sealed-bid auction through these tools. Its own zingo-cli wallet pays the
// deposit; its openings (bid, salt) stay in SBA_BIDDER_DIR and are never returned in full.
//
// Env: SBA_AUCTION_FILE (published auction JSON, e.g. deployments/testnet.json), SBA_BIDDER_WALLET
// (zingo-cli data dir; needed for `bid`), SBA_BIDDER_DIR (where openings are kept), SBA_REFUND_WALLET
// (optional: a refunds-only wallet whose viewing key `complain` may publish; never the bidding wallet).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { commitment, SLOTS } from '@sba/circuits';
import { asDeposits, chainTip, checkOutcome, checkTerms, classifyDeposits, complaintAnchor, complaintKeyPair, decrypt, depositForCommitment, validAhead, revealKeyPair, depositMemo, depositRef, exportUfvk, quicksend, REVEAL_ZAT, scan, sealReveal, SETTLEMENT_FEE_BUDGET_ZAT, signComplaint, uivkOf, zingoConfig, type AuctionConfig } from '@sba/service';

interface Published {
  auction: { name: string; auctionId: string; address: string; uivk: string; depositZat: string; reserveZat: string; openHeight?: number; closeHeight: number; seller: string; revealKey?: string; revealCloseHeight?: number; disputeBlocks?: number };
  deposits: { txid: string; output?: string }[];
  settlement?: { txid: string; height: number };
  outcome?: { proof: object | null; publicSignals: string[] | null; unrevealed?: string[]; noSale?: { reason: 'no_reveal' | 'below_reserve'; detail: string } | null };
}

/** What the bid tool keeps in SBA_BIDDER_DIR (mode 0600). The reveal and complaint secrets never leave it unless the bidder files a complaint. */
interface Opening {
  auctionId: string;
  bid: string;
  salt: string;
  refundAddress: string;
  /** The deposit's name; null until the send reports it (or `reveal` finds it on chain by its commitment). */
  txid: string | null;
  commitment?: string;
  /** 'sending', 'sent', or 'send failed, may still be mined: <error>'. */
  status?: string;
  complaintKey: string;
  complaintSecret: string;
  revealTxid?: string;
  revealSecret?: string;
}

/** The longest refund address a reveal can carry (the sealed opening has a fixed size). */
function refundAddressFits(auctionId: bigint, bid: bigint, refundAddress: string) {
  try {
    // A dry run with throwaway keys and the longest deposit name: exactly what `reveal` will seal later.
    sealReveal(auctionId, revealKeyPair().public, `${'f'.repeat(64)}:o9999`, { bid, salt: (1n << 248n) - 1n, refundAddress, complaintKey: complaintKeyPair().public });
  } catch (e) {
    if (/refund address is \d+ characters/.test((e as Error).message))
      throw new Error(`refund address is ${refundAddress.length} characters; a reveal holds at most 150 (an Orchard-only unified address fits, one with a Sapling or transparent receiver does not), so this deposit could never be revealed or refunded; nothing was sent`);
    throw e;
  }
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
 * The published settlement as mined: its height is read from the chain, never taken from the record,
 * and must match the record and come after the close (or the reveal window). Null when unsettled.
 */
async function settlementOnChain(p: Published): Promise<{ height: number | null; problems: string[] } | null> {
  if (!p.settlement) return null;
  const [t] = await decrypt(p.auction.uivk, [p.settlement.txid]);
  const last = typeof p.auction.revealCloseHeight === 'number' ? p.auction.revealCloseHeight : p.auction.closeHeight;
  const problems: string[] = [];
  if (t.height === null) problems.push(`settlement ${p.settlement.txid} is not mined`);
  else {
    if (t.height !== p.settlement.height) problems.push(`settlement ${p.settlement.txid} is mined at block ${t.height}; the record says ${p.settlement.height}`);
    if (t.height <= last) problems.push(`settlement ${p.settlement.txid} is mined at block ${t.height}, not after block ${last}`);
  }
  return { height: t.height, problems };
}

/**
 * Every deposit to the auction, found by scanning its blocks with the published viewing key (from
 * the open height to the settlement as mined, or to the tip while it is unsettled), so the list does
 * not depend on the auctioneer. Also says which of them the published record leaves out.
 */
async function depositsOnChain(p: Published) {
  const cfg = config(p);
  if (typeof p.auction.openHeight !== 'number') throw new Error('Setup required: auction.openHeight in SBA_AUCTION_FILE (the block to start scanning from)');
  const settled = await settlementOnChain(p);
  const end = settled?.height ?? (await chainTip());
  const found = await scan(cfg.uivk, p.auction.openHeight, end);
  const classified = classifyDeposits(cfg, found.flatMap(asDeposits));
  const listed = new Set(p.deposits.map(depositRef));
  const onChain = new Set(classified.map((d) => d.ref));
  return {
    cfg,
    classified,
    scanned: `${p.auction.openHeight}-${end}`,
    settlementProblems: settled?.problems ?? [],
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
        const { classified: deposits, scanned, notListed, settlementProblems } = await depositsOnChain(p);
        return {
          auction: p.auction.name,
          deposit_zat: p.auction.depositZat,
          reserve_zat: p.auction.reserveZat,
          close_height: p.auction.closeHeight,
          blocks_scanned: scanned,
          deposits: deposits.map((d) => ({ txid: d.txid, ...(d.output === undefined ? {} : { output: d.output }), height: d.height, status: d.status, reason: d.reason ?? null })),
          missing_from_published_record: notListed,
          settlement_problems: settlementProblems,
        };
      }),
  );

  server.registerTool(
    'bid',
    {
      title: 'Place a sealed bid',
      description: "Refuses if the auction has closed, or if its id is not the hash of its published terms (so the close, reveal window and reserve cannot change after the bid). Also refuses a refund address longer than a reveal can carry (150 characters: an Orchard-only unified address). The proof has 8 slots, taken by the first 8 revealed valid deposits; when 8 or more valid deposits are already on chain the result carries an advisory capacity_note (a deposit nobody reveals takes no slot). Otherwise commits to bid_zat with a fresh random salt, saves the opening in SBA_BIDDER_DIR (mode 0600) before anything is sent, and sends the fixed deposit to the auction address with the commitment as memo, from SBA_BIDDER_WALLET.",
      inputSchema: { bid_zat: z.number().int().positive(), refund_address: z.string().startsWith('utest1').describe('a unified address of at most 150 characters (Orchard-only) that receives the refund or the winner change') },
    },
    ({ bid_zat, refund_address }) =>
      wrap(async () => {
        const p = published();
        const cfg = config(p);
        if (BigInt(bid_zat) > cfg.depositZat - SETTLEMENT_FEE_BUDGET_ZAT) throw new Error(`bid ${bid_zat} zat is above the deposit (${cfg.depositZat}) minus the fee budget; nothing was sent`);
        if (BigInt(bid_zat) < cfg.reserveZat) throw new Error(`bid ${bid_zat} zat is below the reserve ${cfg.reserveZat}; nothing was sent`);
        refundAddressFits(cfg.auctionId, BigInt(bid_zat), refund_address);
        const wallet = need('SBA_BIDDER_WALLET');
        const dir = need('SBA_BIDDER_DIR');
        const tip = await chainTip();
        // The deposit is mined at tip + 1 at the earliest; after closeHeight it would be late.
        if (tip >= cfg.closeHeight) throw new Error(`the auction closed after block ${cfg.closeHeight} and the chain is at ${tip}; a deposit now would be late, so nothing was sent`);
        // The deposit memo commits to the auction id; bid only if that id commits to the terms shown here.
        const terms = checkTerms(p.auction);
        if (terms.status === 'legacy') throw new Error("this auction's id hashes only its name, so its close, reveal window and reserve could be changed after you bid; nothing was sent");
        if (!terms.ok) throw new Error(`${terms.detail}; nothing was sent`);
        // The proof has 8 slots, taken by the first 8 revealed valid deposits. Advisory only: a deposit
        // nobody reveals never takes a slot, so a full-looking auction does not stop this bid from competing.
        const { classified: onChain } = await depositsOnChain(p);
        const ahead = validAhead(onChain);
        const capacityNote =
          ahead >= SLOTS
            ? `${ahead} valid deposits are already on chain and the proof has ${SLOTS} slots: this bid competes only if fewer than ${SLOTS} of them are revealed (advisory: unrevealed deposits take no slot)`
            : null;
        const salt = BigInt('0x' + randomBytes(31).toString('hex'));
        const c = await commitment(cfg.auctionId, BigInt(bid_zat), salt);
        const complaint = complaintKeyPair();
        // The opening is saved before anything is sent: a deposit whose opening is lost can never be revealed or refunded.
        const file = resolve(dir, `${cfg.auctionId}-c${c.slice(0, 24)}.json`);
        const opening: Opening = { auctionId: cfg.auctionId.toString(), bid: String(bid_zat), salt: salt.toString(), refundAddress: refund_address, txid: null, commitment: c, status: 'sending', complaintKey: complaint.public, complaintSecret: complaint.secret };
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          writeFileSync(file, JSON.stringify(opening), { mode: 0o600, flag: 'wx' });
        } catch (e) {
          throw new Error(`cannot save the opening in SBA_BIDDER_DIR (${(e as Error).message}); without it the deposit could never be revealed, so nothing was sent`);
        }
        let txid: string;
        try {
          [txid] = await quicksend(zingoConfig(), wallet, [{ address: cfg.address, amount: cfg.depositZat, memo: depositMemo(cfg.auctionId, c) }]);
        } catch (e) {
          // zingo-cli can fail after broadcasting (lightwalletd errors on sends that were mined later), so the opening stays.
          writeFileSync(file, JSON.stringify({ ...opening, status: `send failed, may still be mined: ${(e as Error).message}` }), { mode: 0o600 });
          throw new Error(`${(e as Error).message}; the opening is kept in SBA_BIDDER_DIR in case the deposit is mined anyway (reveal finds it by its commitment)`);
        }
        writeFileSync(file, JSON.stringify({ ...opening, txid, status: 'sent' }), { mode: 0o600 });
        return { sent: true, txid, deposit_zat: cfg.depositZat.toString(), commitment: c, capacity_note: capacityNote, note: 'the bid amount is not visible on-chain; after the close, call reveal to send it to the auctioneer encrypted' };
      }),
  );

  server.registerTool(
    'reveal',
    {
      title: 'Reveal sealed bids to the auctioneer',
      description:
        "During the reveal window (after the close, up to the auction's revealCloseHeight), sends each of this bidder's unrevealed openings from SBA_BIDDER_DIR to the auction address as a 1-zat shielded note whose memo is the opening encrypted to the auction's published reveal key. Only the auctioneer can read it; the auction's viewing key shows only which deposit it names. Refuses outside the window, before any wallet call.",
    },
    () =>
      wrap(async () => {
        const p = published();
        const cfg = config(p);
        if (!p.auction.revealKey || typeof p.auction.revealCloseHeight !== 'number') throw new Error('this auction has no reveal channel (auction.revealKey and auction.revealCloseHeight are missing); nothing was sent');
        const dir = need('SBA_BIDDER_DIR');
        const wallet = need('SBA_BIDDER_WALLET');
        const mine = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${cfg.auctionId}-`) && f.endsWith('.json')) : [];
        const pending = mine.map((f) => ({ file: resolve(dir, f), o: JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as Opening })).filter((x) => !x.o.revealTxid);
        if (pending.length === 0) throw new Error(`no unrevealed opening for auction ${cfg.auctionId} in SBA_BIDDER_DIR; nothing was sent`);
        const tip = await chainTip();
        // A note sent now is mined at tip + 1 at the earliest.
        if (tip < cfg.closeHeight) throw new Error(`the auction closes after block ${cfg.closeHeight} and the chain is at ${tip}; a reveal now would be early, so nothing was sent`);
        if (tip + 1 > p.auction.revealCloseHeight) throw new Error(`the reveal window closed at block ${p.auction.revealCloseHeight} and the chain is at ${tip}; a reveal now would be late, so nothing was sent`);
        // An opening whose send reported no txid (it failed, or the process stopped) is looked up on chain by its commitment.
        const unknown = pending.filter((x) => !x.o.txid);
        const notFound: string[] = [];
        if (unknown.length) {
          const { classified } = await depositsOnChain(p);
          for (const x of unknown) {
            const c = x.o.commitment ?? (await commitment(cfg.auctionId, BigInt(x.o.bid), BigInt(x.o.salt)));
            const d = depositForCommitment(classified, c);
            if (d) {
              x.o = { ...x.o, txid: d.ref, status: `found on chain at block ${d.height}` };
              writeFileSync(x.file, JSON.stringify(x.o), { mode: 0o600 });
            } else notFound.push(x.file);
          }
        }
        const sent = [];
        for (const { file, o } of pending) {
          if (!o.txid) continue;
          const { memo, esk } = sealReveal(cfg.auctionId, p.auction.revealKey, o.txid, { bid: BigInt(o.bid), salt: BigInt(o.salt), refundAddress: o.refundAddress, complaintKey: o.complaintKey });
          const [revealTxid] = await quicksend(zingoConfig(), wallet, [{ address: cfg.address, amount: REVEAL_ZAT, memo }]);
          writeFileSync(file, JSON.stringify({ ...o, revealTxid, revealSecret: esk }), { mode: 0o600 });
          sent.push({ deposit: o.txid, reveal_txid: revealTxid });
        }
        return {
          sent,
          not_on_chain: notFound,
          window_closes_after: p.auction.revealCloseHeight,
          note: `each memo is encrypted to the auction reveal key; the bid, salt and refund address are not visible with the auction viewing key${notFound.length ? `; ${notFound.length} opening(s) have no deposit on chain with their commitment and were not revealed` : ''}`,
        };
      }),
  );

  server.registerTool(
    'complain',
    {
      title: 'File a complaint about the settlement',
      description:
        "Within the dispute window after the settlement (its height as mined, read from the chain, + disputeBlocks), files a complaint for each of this bidder's revealed openings: it publishes that reveal's ephemeral secret (which makes this bidder's own bid, salt and refund address public), signs it with the complaint key inside the reveal, saves it in SBA_BIDDER_DIR, and anchors its SHA-256 on chain with a 1-zat note to the auction address. The audit, given the file, says whether it is upheld. By default the complaint publishes no viewing key, so the audit checks the reveal and the record but not the payment. With include_refund_key it adds the incoming viewing key of SBA_REFUND_WALLET (a separate wallet that should receive only refunds; the bidding wallet is refused) so the audit can read what the settlement paid: that key makes every incoming payment to that wallet, past and future, readable by anyone. Refuses outside the window, before any wallet call.",
      inputSchema: { include_refund_key: z.boolean().optional() },
    },
    ({ include_refund_key }) =>
      wrap(async () => {
        const p = published();
        const cfg = config(p);
        if (!p.auction.revealKey || typeof p.auction.disputeBlocks !== 'number') throw new Error('this auction has no reveal channel or dispute window; nothing was sent');
        if (!p.settlement) throw new Error('this auction is not settled yet; nothing was sent');
        const dir = need('SBA_BIDDER_DIR');
        const wallet = need('SBA_BIDDER_WALLET');
        // A wallet's incoming viewing key covers every payment it ever receives, so only a refunds-only wallet's key may be published.
        let refundWallet: string | null = null;
        if (include_refund_key) {
          refundWallet = process.env.SBA_REFUND_WALLET ?? null;
          if (!refundWallet) throw new Error("Setup required: SBA_REFUND_WALLET (a wallet that receives only this auction's refunds; its incoming viewing key is published with the complaint)");
          if (resolve(refundWallet) === resolve(wallet)) throw new Error('SBA_REFUND_WALLET is the bidding wallet: its incoming viewing key would publish every payment the bidder ever receives; use a wallet that receives only refunds; nothing was sent');
        }
        const revealed = (existsSync(dir) ? readdirSync(dir) : [])
          .filter((f) => f.startsWith(`${cfg.auctionId}-`) && f.endsWith('.json'))
          .map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as Opening)
          .filter((o) => o.revealTxid && o.revealSecret);
        if (revealed.length === 0) throw new Error(`no revealed opening for auction ${cfg.auctionId} in SBA_BIDDER_DIR; nothing was sent`);
        // The window counts from the settlement as mined, not from the height the record gives.
        const settled = (await settlementOnChain(p))!;
        if (settled.height === null) throw new Error(`settlement ${p.settlement.txid} is not mined yet; nothing was sent`);
        const tip = await chainTip();
        const last = settled.height + p.auction.disputeBlocks;
        if (tip + 1 > last) throw new Error(`the dispute window closed at block ${last} and the chain is at ${tip}; nothing was sent`);
        const refundViewingKey = refundWallet ? await uivkOf(await exportUfvk(zingoConfig(), refundWallet)) : null;
        const filed = [];
        for (const o of revealed) {
          const c = signComplaint({ auctionId: cfg.auctionId.toString(), deposit: o.txid!, reveal: o.revealTxid!, revealSecret: o.revealSecret!, refundViewingKey }, o.complaintSecret);
          const file = resolve(dir, `${cfg.auctionId}-${o.revealTxid}.complaint.json`);
          writeFileSync(file, JSON.stringify(c, null, 2));
          const [anchorTxid] = await quicksend(zingoConfig(), wallet, [{ address: cfg.address, amount: REVEAL_ZAT, memo: complaintAnchor(c) }]);
          filed.push({ deposit: o.txid, complaint_file: file, anchor_txid: anchorTxid });
        }
        return {
          filed,
          window_closes_after: last,
          refund_key_published: refundViewingKey !== null,
          note: `each complaint makes this bidder's own opening public${refundViewingKey ? ", and the refund wallet's incoming viewing key (every payment to that wallet)" : '; no viewing key was published, so the audit cannot check the payment'}; run the audit with the complaint file for the verdict`,
        };
      }),
  );

  server.registerTool(
    'verify_result',
    {
      title: "Check the auction's published result",
      description: "Verifies the MaxBid Groth16 proof and checks it is about exactly this auction's deposits as read on-chain with the auction's viewing key (scanned up to the settlement's height as mined, which must match the record): proven slots are the valid deposits in chain order (minus any declared unrevealed), spare slots are empty, and the winner is a real deposit. A no-sale result holds only when nothing valid was revealed, or when its proof shows the highest revealed bid is below the reserve.",
      annotations: { readOnlyHint: true },
    },
    () =>
      wrap(async () => {
        const p = published();
        if (!p.outcome) throw new Error('this auction has no published result yet');
        const { cfg, classified, notListed, notOnChain, settlementProblems } = await depositsOnChain(p);
        const r = await checkOutcome(cfg, classified, p.outcome);
        const ok = (name: string) => r.checks.find((c) => c.name === name)?.ok ?? false;
        return {
          result_holds: r.ok && notListed.length === 0 && notOnChain.length === 0 && settlementProblems.length === 0,
          settlement_mined_as_recorded: settlementProblems.length === 0,
          record_lists_every_chain_deposit: notListed.length === 0 && notOnChain.length === 0,
          proof_verifies: ok('proof'),
          auction_id_matches: ok('auction'),
          slots_are_the_chain_deposits: ok('slots') && ok('unrevealed'),
          winner_is_a_deposit: ok('winner'),
          winning_bid_zat: r.noSale ? null : r.winningBid.toString(),
          winner_deposit: r.winnerTxid,
          // No sale: nothing valid was revealed, or the proof (reserve 0) shows the highest bid is below the reserve.
          no_sale: r.noSale ? { ...r.noSale, highest_bid_zat: r.noSale.reason === 'below_reserve' ? r.winningBid.toString() : null } : null,
          unrevealed: p.outcome.unrevealed ?? [],
          failed: [
            ...settlementProblems,
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
