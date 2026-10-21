// Audit a published auction from the chain, with only public information:
//   pnpm --filter @sba/service audit [deployments/testnet.json]
// Re-reads every deposit and the settlement with the auction's incoming viewing key, re-applies
// the rules, verifies the MaxBid proof and checks its commitments against the on-chain memos.
// Optional: SBA_AUDIT_UIVK=<a recipient's incoming viewing key> also shows what that key decrypts
// in the settlement. Exit 1 if anything does not match.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkOutcome, classifyDeposits, decrypt, ironwoodOnly, memoText, type AuctionConfig } from './index.js';

const file = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../../../deployments/testnet.json'));
const run = JSON.parse(readFileSync(file, 'utf8'));
const a = run.auction;
const cfg: AuctionConfig = { name: a.name, auctionId: BigInt(a.auctionId), address: a.address, uivk: a.uivk, depositZat: BigInt(a.depositZat), reserveZat: BigInt(a.reserveZat), closeHeight: a.closeHeight, sellerAddress: a.seller };
let failures = 0;
const check = (ok: boolean, line: string) => {
  console.log(`${ok ? '✓' : '✗'} ${line}`);
  if (!ok) failures++;
};

console.log(`auction ${a.name}: deposit ${a.depositZat} zat, reserve ${a.reserveZat} zat, close after block ${a.closeHeight}`);
const txids: string[] = run.deposits.map((d: { txid: string }) => d.txid);
const txs = await decrypt(cfg.uivk, [...txids, run.settlement.txid]);
console.log('\ndeposits, decrypted with the auction incoming viewing key (amount and memo only):');
const incoming = txs.slice(0, txids.length).map((t) => {
  const o = t.outputs.find((x) => memoText(x.memo)) ?? t.outputs[0];
  const memo = memoText(o?.memo ?? null);
  console.log(`  ${t.txid.slice(0, 10)}  block ${t.height}  ${String(o?.value ?? 0).padStart(8)} zat  memo ${memo.length > 40 ? memo.slice(0, 40) + '…' : memo}`);
  return { txid: t.txid, height: t.height, value: BigInt(o?.value ?? 0), memo };
});
const classified = classifyDeposits(cfg, incoming);
console.log('\nrules applied to what the chain shows:');
for (const d of classified) {
  const recorded = run.deposits.find((x: { txid: string }) => x.txid === d.txid).status;
  check(recorded === d.status, `${d.txid.slice(0, 10)} ${d.status}${d.reason ? ` (${d.reason})` : ''}`);
}
console.log('\nthe result:');
const outcome = await checkOutcome(cfg, classified, run.outcome);
for (const c of outcome.checks) check(c.ok, `${c.name}: ${c.detail}`);
if (outcome.winnerTxid) console.log(`  winner: deposit ${outcome.winnerTxid.slice(0, 10)}, winning bid ${outcome.winningBid} zat (the only bid made public)`);
check(txs.every(ironwoodOnly), `all ${txs.length} transactions have only an Ironwood bundle (no transparent part)`);
const settle = txs[txs.length - 1];
check(settle.outputs.length === 0, 'the auction key sees no outputs of the settlement (refunds are only visible to their recipients)');
if (process.env.SBA_AUDIT_UIVK) {
  const [mine] = await decrypt(process.env.SBA_AUDIT_UIVK, [run.settlement.txid]);
  console.log(`\nwith the given recipient key, the settlement pays: ${mine.outputs.map((o) => `${o.value} zat`).join(' + ') || 'nothing'}`);
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks pass');
process.exit(failures ? 1 : 0);
