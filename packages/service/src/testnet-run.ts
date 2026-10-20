// Live sealed-bid auction on Zcash testnet, resumable (state in .demo/auction-state.json).
//   pnpm --filter @sba/service testnet-run
// Wallets: .demo/wallets/{auction,bidder1,bidder2,bidder3,seller} (zingo-cli data dirs, gitignored).
// bidder1 must hold ~0.065 TAZ and bidder2/bidder3 ~0.03 TAZ each (bidder1 funds the others).
// Writes deployments/testnet.json: deposits, rejections, proof, settlement, and viewing-key checks.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { commitment, readPublic, verify } from '@sba/circuits';
import {
  auctionIdFor,
  checkReveal,
  classifyDeposits,
  decide,
  decrypt,
  depositMemo,
  exportUfvk,
  ironwoodOnly,
  memoText,
  quicksend,
  uivkOf,
  valueTransfers,
  zingoConfig,
  address,
  type AuctionConfig,
  type IncomingDeposit,
  type Reveal,
} from './index.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const WALLETS = resolve(ROOT, '.demo/wallets');
const STATE = resolve(ROOT, '.demo/auction-state.json');
const OUT = resolve(ROOT, 'deployments/testnet.json');
const cfgZ = zingoConfig();
const DEPOSIT = 2_000_000n; // 0.02 TAZ
const RESERVE = 500_000n;
const w = (name: string) => resolve(WALLETS, name);
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

type Bid = { wallet: string; label: string; bid: string; salt: string; amount: string; memo: string; txid?: string; expect: string };
interface State {
  auction?: Omit<AuctionConfig, 'auctionId' | 'depositZat' | 'reserveZat'> & { auctionId: string; depositZat: string; reserveZat: string };
  uivks: Record<string, string>;
  bids: Bid[];
  late?: Bid;
  settlement?: { txids: string[]; payouts: { address: string; amount: string; why: string }[] };
  outcome?: { winnerCommitment: string; winningBid: string; proof: object; publicSignals: string[] };
  log: string[];
}

const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { uivks: {}, bids: [], log: [] };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
function say(line: string) {
  console.log(line);
  state.log.push(`${new Date().toISOString()} ${line}`);
  save();
}

async function tip(): Promise<number> {
  // Any decryptable lookup returns the tip-relative confirmations; use the auction UIVK on a known tx.
  const probe = state.bids.find((b) => b.txid)?.txid ?? '6afa00383ef7eae26c1e76f09948f6ae9c39179f09af780131bb1952c09c4d3b';
  const [t] = await decrypt(state.uivks.auction, [probe]);
  return (t.height ?? 0) + t.confirmations - 1;
}

async function waitMined(txid: string, minConf = 1) {
  for (let i = 0; ; i++) {
    const [t] = await decrypt(state.uivks.auction, [txid]).catch(() => [undefined]);
    if (t && t.confirmations >= minConf) return t;
    if (i % 4 === 0) console.log(`  … waiting for ${txid.slice(0, 10)} (${t?.confirmations ?? 0}/${minConf} confirmations)`);
    await sleep(30);
  }
}

/** quicksend that waits out "not enough confirmed funds" from a still-unconfirmed change note. */
async function send(wallet: string, receivers: Parameters<typeof quicksend>[2]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await quicksend(cfgZ, w(wallet), receivers);
    } catch (e) {
      const m = (e as Error).message;
      if (attempt < 12 && /insufficient|not enough|Propose send error/i.test(m)) {
        console.log(`  … ${wallet}: funds not spendable yet, retrying in 60 s`);
        await sleep(60);
        continue;
      }
      throw e;
    }
  }
}

async function main() {
  // 1. Keys and addresses.
  for (const name of ['auction', 'bidder1', 'bidder2', 'bidder3', 'seller']) {
    if (!state.uivks[name]) state.uivks[name] = await uivkOf(await exportUfvk(cfgZ, w(name)));
  }
  save();

  // 2. Create the auction: closes ~20 blocks from now.
  if (!state.auction) {
    const name = `sba-testnet-${new Date().toISOString().slice(0, 16)}`;
    const t = await tip();
    state.auction = {
      name,
      auctionId: auctionIdFor(name).toString(),
      address: await address(cfgZ, w('auction')),
      uivk: state.uivks.auction,
      depositZat: DEPOSIT.toString(),
      reserveZat: RESERVE.toString(),
      closeHeight: t + 20,
      sellerAddress: await address(cfgZ, w('seller')),
    };
    say(`auction ${name} id ${state.auction.auctionId}: deposit ${DEPOSIT} zat, reserve ${RESERVE} zat, closes after block ${state.auction.closeHeight} (tip ${t})`);
  }
  const a = state.auction;
  const cfg: AuctionConfig = { ...a, auctionId: BigInt(a.auctionId), depositZat: BigInt(a.depositZat), reserveZat: BigInt(a.reserveZat) };

  // 3. Bids: three valid, plus a duplicate commitment, a wrong amount, and a memo mismatch.
  if (state.bids.length === 0) {
    const mk = async (wallet: string, label: string, bid: bigint, amount: bigint, expect: string, memoOverride?: string): Promise<Bid> => {
      const salt = BigInt('0x' + randomBytes(31).toString('hex'));
      const c = await commitment(cfg.auctionId, bid, salt);
      return { wallet, label, bid: bid.toString(), salt: salt.toString(), amount: amount.toString(), memo: memoOverride ?? depositMemo(cfg.auctionId, c), expect };
    };
    const b1 = await mk('bidder1', 'bidder1 sealed bid', 1_200_000n, DEPOSIT, 'valid');
    const b2 = await mk('bidder2', 'bidder2 sealed bid', 1_750_000n, DEPOSIT, 'valid');
    const b3 = await mk('bidder3', 'bidder3 sealed bid', 900_000n, DEPOSIT, 'valid');
    const dup = { ...b1, label: 'bidder1 re-sends the same commitment', expect: 'duplicate', txid: undefined };
    const wrong = await mk('bidder2', 'bidder2 deposits 0.005 TAZ instead of 0.02', 400_000n, 500_000n, 'wrong_amount');
    const garbage = await mk('bidder3', 'bidder3 sends a memo that is not a bid', 0n, 100_000n, 'memo_mismatch', 'hello auction');
    state.bids = [b1, b2, b3, dup, wrong, garbage];
    save();
  }
  // Each wallet sends its deposits in order (change must confirm between them).
  const byWallet = new Map<string, Bid[]>();
  for (const b of state.bids) byWallet.set(b.wallet, [...(byWallet.get(b.wallet) ?? []), b]);
  await Promise.all(
    [...byWallet.entries()].map(async ([wallet, bids]) => {
      for (const b of bids) {
        if (b.txid) continue;
        const [txid] = await send(wallet, [{ address: a.address, amount: BigInt(b.amount), memo: b.memo }]);
        b.txid = txid;
        say(`deposit: ${b.label}  tx ${txid}`);
        await waitMined(txid, 1);
      }
    }),
  );

  // 4. After the close: a late deposit (bidder1, new commitment).
  if (!state.late) {
    while ((await tip()) <= a.closeHeight) {
      console.log(`  … auction closes after block ${a.closeHeight}; waiting`);
      await sleep(60);
    }
    const salt = BigInt('0x' + randomBytes(31).toString('hex'));
    const c = await commitment(cfg.auctionId, 1_900_000n, salt);
    state.late = { wallet: 'bidder1', label: 'bidder1 deposits after the close', bid: '1900000', salt: salt.toString(), amount: DEPOSIT.toString(), memo: depositMemo(cfg.auctionId, c), expect: 'late' };
    save();
  }
  if (!state.late.txid) {
    const [txid] = await send('bidder1', [{ address: a.address, amount: DEPOSIT, memo: state.late.memo }]);
    state.late.txid = txid;
    say(`deposit: ${state.late.label}  tx ${txid}`);
  }
  await waitMined(state.late.txid!, 1);

  // 5. Read every deposit with the auction's incoming viewing key (not the auction wallet).
  const all = [...state.bids, state.late];
  const decrypted = await decrypt(a.uivk, all.map((b) => b.txid!));
  const incoming: IncomingDeposit[] = decrypted.map((t) => {
    const out = t.outputs.find((o) => memoText(o.memo)) ?? t.outputs[0];
    return { txid: t.txid, height: t.height, value: BigInt(out?.value ?? 0), memo: memoText(out?.memo ?? null) };
  });
  const classified = classifyDeposits(cfg, incoming);
  for (const d of classified) say(`  ${d.txid.slice(0, 10)} at ${d.height}: ${d.status}${d.reason ? ` (${d.reason})` : ''}`);
  for (const b of all) {
    const got = classified.find((d) => d.txid === b.txid)!.status;
    if (got !== b.expect) throw new Error(`${b.label}: expected ${b.expect}, the service says ${got}`);
  }

  // 6. Reveals, including an altered one.
  const refund = (wallet: string) => address(cfgZ, w(wallet));
  const reveals: Reveal[] = [];
  for (const b of [state.bids[0], state.bids[1], state.bids[2], state.bids[4], state.late]) {
    reveals.push({ bid: BigInt(b.bid), salt: BigInt(b.salt), refundAddress: await refund(b.wallet) });
  }
  const altered = await checkReveal(cfg, classified, { bid: BigInt(state.bids[2].bid) + 1_000_000n, salt: BigInt(state.bids[2].salt), refundAddress: await refund('bidder3') });
  if (altered.ok) throw new Error('an altered reveal was accepted');
  say(`altered reveal (bidder3 claims a different bid with its salt): rejected (${altered.reason})`);

  // 7. Decide, prove, settle in one shielded transaction.
  if (!state.settlement) {
    const o = await decide(cfg, classified, reveals);
    say(`winner: commitment ${o.winnerCommitment.slice(0, 12)}…, bid ${o.winningBid} zat; MaxBid proof verifies`);
    state.outcome = { winnerCommitment: o.winnerCommitment, winningBid: o.winningBid.toString(), proof: o.proof, publicSignals: o.publicSignals };
    const txids = await send('auction', o.payouts.map((p) => ({ address: p.address, amount: p.amount, memo: `sba1:${a.auctionId}:settlement` })));
    state.settlement = { txids, payouts: o.payouts.map((p) => ({ ...p, amount: p.amount.toString() })) };
    say(`settlement tx ${txids[0]}: ${o.payouts.length} outputs`);
  }
  const settle = await waitMined(state.settlement.txids[0], 1);

  // 8. Each recipient checks its own output with its own incoming viewing key.
  const who: Record<string, string> = {};
  for (const name of ['seller', 'bidder1', 'bidder2', 'bidder3']) who[await address(cfgZ, w(name))] = name;
  const checks: { recipient: string; expected: string; seen: number[]; ok: boolean }[] = [];
  for (const [addr, name] of Object.entries(who)) {
    const expected = state.settlement.payouts.filter((p) => p.address === addr).map((p) => BigInt(p.amount)).sort();
    const [t] = await decrypt(state.uivks[name], [state.settlement.txids[0]]);
    const seen = t.outputs.map((x) => x.value).sort((x, y) => x - y);
    const ok = JSON.stringify(seen.map(String)) === JSON.stringify(expected.map(String));
    checks.push({ recipient: name, expected: expected.map(String).join('+') || '0', seen, ok });
    say(`viewing-key check: ${name} sees ${seen.join(' + ') || 'nothing'} zat in the settlement (expected ${expected.join(' + ') || 'nothing'}) ${ok ? '✓' : '✗'}`);
    if (!ok) throw new Error(`${name}'s settlement output does not match`);
  }
  const pub = readPublic(state.outcome!.publicSignals);
  const proofOk = await verify(state.outcome!.publicSignals, state.outcome!.proof);
  const onChainCommitments = classified.filter((d) => d.status === 'valid').map((d) => d.commitment);
  const slotsMatch = onChainCommitments.every((c, i) => pub.commitments[i] === c);
  say(`proof verifies: ${proofOk}; proof commitments = valid on-chain deposit memos: ${slotsMatch}`);
  const pools = await decrypt(a.uivk, [...all.map((b) => b.txid!), state.settlement.txids[0]]);
  const allIronwood = pools.every(ironwoodOnly);
  say(`every deposit and the settlement are Ironwood-only (no transparent part): ${allIronwood}`);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        network: 'testnet',
        auction: { name: a.name, auctionId: a.auctionId, address: a.address, uivk: a.uivk, depositZat: a.depositZat, reserveZat: a.reserveZat, closeHeight: a.closeHeight, seller: a.sellerAddress },
        deposits: classified.map((d) => ({ txid: d.txid, height: d.height, valueZat: d.value.toString(), memo: d.memo, status: d.status, reason: d.reason ?? null, label: all.find((b) => b.txid === d.txid)?.label })),
        alteredReveal: { rejected: true, reason: (altered as { reason: string }).reason },
        outcome: { winnerSlot: pub.winner, winningBidZat: pub.winningBid.toString(), reserveZat: pub.reserve.toString(), commitments: pub.commitments, proof: state.outcome!.proof, publicSignals: state.outcome!.publicSignals, proofVerifies: proofOk, slotsMatchDeposits: slotsMatch },
        settlement: { txid: state.settlement.txids[0], height: settle.height, outputs: state.settlement.payouts.map((p) => ({ amountZat: p.amount, why: p.why, recipient: who[p.address] })), viewingKeyChecks: checks },
        ironwoodOnly: allIronwood,
        verificationKeySha256: 'd2a3dfccee4d81ab1d2826953969ff383ab467dab0ac4fdbfcac903fe7c0fca2',
      },
      null,
      2,
    ) + '\n',
  );
  say(`wrote deployments/testnet.json`);
}

// snarkjs keeps its bn128 worker threads alive after proving, so exit explicitly.
main().then(() => process.exit(0)).catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
