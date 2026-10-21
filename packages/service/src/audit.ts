// Audit a published auction from the chain, with only public information:
//   pnpm --filter @sba/service audit [deployments/testnet.json]
// Scans every block from the auction's open height to its settlement with the auction's incoming
// viewing key, so the deposit list comes from the chain, not from the auctioneer. Then re-applies
// the rules, verifies the MaxBid proof and checks that it is about exactly those deposits.
// Optional: SBA_AUDIT_UIVK=<a recipient's incoming viewing key> also shows what that key decrypts
// in the settlement. Exit 1 if anything does not match.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asDeposit, checkOutcome, classifyDeposits, decrypt, ironwoodOnly, scan, type AuctionConfig } from './index.js';

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
console.log(`\nblocks ${a.openHeight}-${end} scanned with the auction incoming viewing key: ${found.length} transaction(s) pay the auction`);
const incoming = found.map((t) => {
  const d = asDeposit(t);
  console.log(`  ${t.txid.slice(0, 10)}  block ${t.height}  ${String(d.value).padStart(8)} zat  memo ${d.memo.length > 40 ? d.memo.slice(0, 40) + '…' : d.memo}`);
  return d;
});
const listed = new Set<string>(run.deposits.map((d: { txid: string }) => d.txid));
const onChain = new Set(found.map((t) => t.txid));
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
  const recorded = run.deposits.find((x: { txid: string }) => x.txid === d.txid)?.status ?? 'not listed';
  check(recorded === d.status, `${d.txid.slice(0, 10)} ${d.status}${d.reason ? ` (${d.reason})` : ''}${recorded === d.status ? '' : `; the record says ${recorded}`}`);
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
