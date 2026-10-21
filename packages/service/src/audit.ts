// Audit a published auction from the chain, with only public information:
//   pnpm --filter @sba/service audit [deployments/testnet.json]
// Scans every block from the auction's open height to its settlement with the auction's incoming
// viewing key, so the deposit list comes from the chain, not from the auctioneer. Then re-applies
// the rules, verifies the MaxBid proof and checks that it is about exactly those deposits.
// Optional: SBA_AUDIT_UIVK=<a recipient's incoming viewing key> also shows what that key decrypts
// in the settlement. Exit 1 if anything does not match.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asDeposits, asMessages, auditReveals, checkOutcome, classifyDeposits, decrypt, depositRef, ironwoodOnly, REVEAL_PREFIX, scan, type AuctionConfig } from './index.js';

const file = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../../../deployments/testnet.json'));
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
const end = run.settlement.height as number;
const found = await scan(cfg.uivk, a.openHeight, end);
const incoming = found.flatMap(asDeposits);
console.log(`\nblocks ${a.openHeight}-${end} scanned with the auction incoming viewing key: ${found.length} transaction(s) pay the auction, ${incoming.length} payment(s)`);
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
    console.log(`  ${depositRef(m).slice(0, 10)}  block ${m.height}  names deposit ${m.memo.split(':')[2]?.slice(0, 10)}  record: ${rec ? rec.status : 'not listed'}`);
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
const [settle] = await decrypt(cfg.uivk, [run.settlement.txid]);
const txs = [...found, settle];
check(txs.every(ironwoodOnly), `all ${txs.length} transactions have only an Ironwood bundle (no transparent part)`);
check(settle.outputs.length === 0, 'the auction key sees no outputs of the settlement (refunds are only visible to their recipients)');
if (process.env.SBA_AUDIT_UIVK) {
  const [mine] = await decrypt(process.env.SBA_AUDIT_UIVK, [run.settlement.txid]);
  console.log(`\nwith the given recipient key, the settlement pays: ${mine.outputs.map((o) => `${o.value} zat`).join(' + ') || 'nothing'}`);
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks pass');
process.exit(failures ? 1 : 0);
