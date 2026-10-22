// Audit a published auction from the chain, with only public information:
//   pnpm --filter @sba/service run audit [deployments/testnet.json] [complaint.json ...]
// ("run" is needed: plain `pnpm audit` is pnpm's own dependency audit.) Relative paths are read from
// the directory pnpm was started in (INIT_CWD), not from packages/service.
// Reads the settlement's block height from the chain (it must match the record and come after the
// close or reveal window), then scans every block from the auction's open height to that height with
// the auction's incoming viewing key, so the deposit list comes from the chain, not from the auctioneer. Then re-applies
// the rules, verifies the MaxBid proof and checks that it is about exactly those deposits.
// Optional: SBA_AUDIT_UIVK=<a recipient's incoming viewing key> also shows what that key decrypts
// in the settlement. Complaint files (from a bidder's dispute) are checked against the chain: an
// upheld complaint is a failure that names what the auctioneer did wrong. Exit 1 if anything does
// not match.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asDeposits, asMessages, auditReveals, chainTip, checkComplaint, checkOutcome, checkSharedRefundKeys, checkTerms, memoText, parsePayoutMemo, classifyDeposits, COMPLAINT_PREFIX, decrypt, depositRef, ironwoodOnly, openRevealWithEsk, owns, parseRevealMemo, REVEAL_PREFIX, scan, type AuctionConfig, type Complaint } from './index.js';

const cwd = process.env.INIT_CWD ?? process.cwd();
const file = process.argv[2] ? resolve(cwd, process.argv[2]) : resolve(import.meta.dirname, '../../../deployments/testnet.json');
const complaintFiles = process.argv.slice(3).map((f) => resolve(cwd, f));
const run = JSON.parse(readFileSync(file, 'utf8'));
const a = run.auction;
if (typeof a.openHeight !== 'number') {
  console.error('Setup required: auction.openHeight in the record (the block to start scanning from)');
  process.exit(1);
}
const cfg: AuctionConfig = { name: a.name, auctionId: BigInt(a.auctionId), address: a.address, uivk: a.uivk, depositZat: BigInt(a.depositZat), reserveZat: BigInt(a.reserveZat), closeHeight: a.closeHeight, sellerAddress: a.seller };
let failures = 0;
const check = (ok: boolean, line: string) => {
  console.log(`${ok ? '✓' : '✗'} ${line}`);
  if (!ok) failures++;
};

console.log(`auction ${a.name}: deposit ${a.depositZat} zat, reserve ${a.reserveZat} zat, open at block ${a.openHeight}, close after block ${a.closeHeight}`);
// Are the heights, reserve and windows below the ones the bids were placed under? Only if the id hashes them.
const terms = checkTerms(a);
if (terms.status === 'legacy') console.log(`! terms: ${terms.detail}`);
else check(terms.ok, `terms: ${terms.detail}`);
// The settlement's height comes from the chain, not the record: it ends the deposit scan and starts the
// dispute window, so a record that understates it could stop the scan before a deposit it leaves out.
const [settle] = await decrypt(cfg.uivk, [run.settlement.txid]);
const lastWindow = typeof a.revealCloseHeight === 'number' ? a.revealCloseHeight : a.closeHeight;
const settledAt = settle.height;
check(
  settledAt !== null && settledAt === run.settlement.height && settledAt > lastWindow,
  settledAt === null
    ? `settlement ${run.settlement.txid.slice(0, 10)} is not mined`
    : `settlement ${run.settlement.txid.slice(0, 10)} is mined at block ${settledAt}${settledAt === run.settlement.height ? ', as the record says' : `; the record says ${run.settlement.height}`}, ${settledAt > lastWindow ? 'after' : 'NOT after'} the ${typeof a.revealCloseHeight === 'number' ? 'reveal window' : 'close'} (block ${lastWindow})`,
);
const end = settledAt ?? (await chainTip());
const found = await scan(cfg.uivk, a.openHeight, end);
const incoming = found.flatMap(asDeposits);
console.log(`\nblocks ${a.openHeight}-${end} scanned with the auction incoming viewing key: ${found.length} transaction(s) pay the auction, ${incoming.length} of their payments are deposits`);
for (const d of incoming) {
  const name = depositRef(d);
  console.log(`  ${name.slice(0, 10)}${d.output === undefined ? '' : `:${d.output}`}  block ${d.height}  ${String(d.value).padStart(8)} zat  memo ${d.memo.length > 40 ? d.memo.slice(0, 40) + '…' : d.memo}`);
}
const listed = new Set<string>(run.deposits.map(depositRef));
const onChain = new Set(incoming.map(depositRef));
check(
  [...onChain].every((t) => listed.has(t)),
  `every deposit on chain is in the published list${[...onChain].filter((t) => !listed.has(t)).map((t) => `; NOT LISTED: ${t}`).join('')}`,
);
check(
  [...listed].every((t) => onChain.has(t)),
  `every listed deposit is on chain in the window${[...listed].filter((t) => !onChain.has(t)).map((t) => `; NOT FOUND: ${t}`).join('')}`,
);

const classified = classifyDeposits(cfg, incoming);
console.log('\nrules applied to what the chain shows:');
for (const d of classified) {
  const recorded = run.deposits.find((x: { txid: string; output?: string }) => depositRef(x) === d.ref)?.status ?? 'not listed';
  check(recorded === d.status, `${d.ref.slice(0, 10)}${d.output === undefined ? '' : `:${d.output}`} ${d.status}${d.reason ? ` (${d.reason})` : ''}${recorded === d.status ? '' : `; the record says ${recorded}`}`);
}

const revealMsgs = found.flatMap((t) => asMessages(t, `${REVEAL_PREFIX}:`));
if (a.revealKey) {
  console.log(`\nreveals (sealed to the auctioneer's reveal key; this key sees only which deposit each names and when), window ${a.closeHeight + 1}-${a.revealCloseHeight}:`);
  for (const m of revealMsgs) {
    const rec = (run.reveals ?? []).find((r: { ref: string }) => r.ref === depositRef(m));
    console.log(`  ${depositRef(m).slice(0, 10)}  block ${m.height}  names deposit ${(() => { const d = m.memo.split(':').slice(2, -1).join(':'); return d.length > 64 ? `${d.slice(0, 10)}:${d.slice(65)}` : d.slice(0, 10); })()}  record: ${rec ? rec.status : 'not listed'}`);
  }
  const r = auditReveals({ auctionId: cfg.auctionId, closeHeight: a.closeHeight, revealCloseHeight: a.revealCloseHeight }, classified, revealMsgs, run.reveals ?? [], run.outcome.unrevealed ?? []);
  for (const c of r.checks) check(c.ok, `${c.name}: ${c.detail}`);
  for (const n of r.notes) console.log(`  note: ${n}`);
} else {
  console.log(`\nreveals: this auction predates the reveal channel (openings were handed over out of band); ${revealMsgs.length} reveal note(s) on chain`);
}

console.log('\nthe result:');
const outcome = await checkOutcome(cfg, classified, run.outcome);
for (const c of outcome.checks) check(c.ok, `${c.name}: ${c.detail}`);
if (outcome.winnerTxid) console.log(`  winner: deposit ${outcome.winnerTxid.slice(0, 10)}, winning bid ${outcome.winningBid} zat (the only bid made public)`);
if (outcome.noSale) console.log(`  no sale (${outcome.noSale.reason}): every revealed deposit is refunded minus its own output fee, unrevealed ones go to the seller`);
const txs = [...found, settle];
check(txs.every(ironwoodOnly), `all ${txs.length} transactions have only an Ironwood bundle (no transparent part)`);
check(settle.outputs.length === 0, 'the auction key sees no outputs of the settlement (refunds are only visible to their recipients)');
if (process.env.SBA_AUDIT_UIVK) {
  const [mine] = await decrypt(process.env.SBA_AUDIT_UIVK, [run.settlement.txid]);
  // Settlement memos name what each output pays (seller, change, refund or forfeit of a deposit); legacy ones say `settlement`.
  const what = (memo: string) => {
    const t = parsePayoutMemo(memo);
    return t && t.auctionId === cfg.auctionId ? ` (${t.kind}${t.deposit ? ` of ${t.deposit.slice(0, 10)}` : ''})` : '';
  };
  console.log(`\nwith the given recipient key, the settlement pays: ${mine.outputs.map((o) => `${o.value} zat${what(memoText(o.memo))}`).join(' + ') || 'nothing'}`);
}
if (complaintFiles.length) {
  console.log('\ncomplaints:');
  if (!a.revealKey || typeof a.disputeBlocks !== 'number') {
    check(false, 'this auction has no reveal channel or dispute window, so complaints cannot be checked');
  } else {
    // The window starts after the settlement as mined (chain height), whatever the record says.
    const from = end + 1;
    const to = Math.min(end + a.disputeBlocks, await chainTip());
    const anchors = to >= from ? (await scan(cfg.uivk, from, to)).flatMap((t) => asMessages(t, `${COMPLAINT_PREFIX}:`)) : [];
    console.log(`  dispute window ${from}-${end + a.disputeBlocks}; blocks ${from}-${to} scanned: ${anchors.length} complaint anchor(s)`);
    const outcomeCheck = await checkOutcome(cfg, classified, run.outcome);
    const results: Parameters<typeof checkSharedRefundKeys>[0] = [];
    for (const f of complaintFiles) {
      const c = JSON.parse(readFileSync(f, 'utf8')) as Complaint;
      let refund = null;
      if (c.refundViewingKey) {
        // The refund address is inside the reveal; the complaint's secret opens it (checkComplaint re-checks all of this).
        const note = revealMsgs.find((m) => depositRef(m) === c.reveal);
        const parsed = note && parseRevealMemo(note.memo);
        let address: string | null = null;
        try {
          address = parsed ? openRevealWithEsk(a.revealKey, c.revealSecret, parsed).refundAddress : null;
        } catch {
          address = null;
        }
        if (address) {
          const keyOwnsAddress = await owns(c.refundViewingKey, address);
          const [mine] = keyOwnsAddress ? await decrypt(c.refundViewingKey, [run.settlement.txid]) : [{ outputs: [] }];
          refund = { keyOwnsAddress, outputs: mine.outputs.map((o) => ({ valueZat: BigInt(o.value), memo: memoText(o.memo) })) };
        }
      }
      const r = await checkComplaint(c, {
        cfg: { ...cfg, closeHeight: a.closeHeight, revealCloseHeight: a.revealCloseHeight, revealKey: a.revealKey, disputeBlocks: a.disputeBlocks },
        deposits: classified,
        reveals: revealMsgs,
        anchors,
        record: { reveals: run.reveals ?? [], unrevealed: run.outcome.unrevealed ?? [], winnerDeposit: outcomeCheck.winnerTxid, winningBid: outcomeCheck.winningBid, settlement: { txid: run.settlement.txid, height: end }, noSale: !!run.outcome.noSale },
        refund,
      });
      const name = f.split('/').pop()!;
      results.push({ name, key: c.refundViewingKey, result: r });
      if (r.verdict === 'upheld') check(false, `complaint ${name} UPHELD: ${r.reasons.join('; ')}`);
      else console.log(`  complaint ${name} ${r.verdict}: ${r.reasons.join('; ')}`);
    }
    // Legacy settlement memos do not name deposits: compare each refund key's total with everything its complaints are owed.
    for (const g of checkSharedRefundKeys(results, run.settlement.txid)) {
      if (g.ok) console.log(`  refund key of ${g.names.join(', ')}: ${g.line}`);
      else check(false, `refund key of ${g.names.join(', ')} UPHELD: ${g.line}`);
    }
  }
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks pass');
process.exit(failures ? 1 : 0);
