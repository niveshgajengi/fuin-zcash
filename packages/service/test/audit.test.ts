// The audit script against live Zcash testnet (lightwalletd via sba-verify). It finds deposits by
// scanning the auction's blocks with the published viewing key, so a deposit the auctioneer leaves
// out of its record is caught. No deposit is sent by these tests.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = resolve(__dirname, '../../..');
const RECORD = resolve(ROOT, 'deployments/testnet.json');
const RECORD2 = resolve(ROOT, 'deployments/testnet-reveal.json');
const RECORD3 = resolve(ROOT, 'deployments/testnet-sale003.json');
const COMPLAINTS = resolve(ROOT, 'deployments/complaints');
const TSX = resolve(__dirname, '../node_modules/.bin/tsx');
const AUDIT = resolve(__dirname, '../src/audit.ts');

// The seller's incoming viewing key, from the gitignored demo state (local runs only; never printed).
const STATE = resolve(ROOT, '.demo/reveal-run-state.json');
const sellerUivk: string | undefined = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')).uivks?.seller : undefined;
const STATE3 = resolve(ROOT, '.demo/reveal-run-003-state.json');
const sellerUivk3: string | undefined = existsSync(STATE3) ? JSON.parse(readFileSync(STATE3, 'utf8')).uivks?.seller : undefined;
let env: Record<string, string> = {};

async function audit(file: string, ...complaints: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await run(TSX, [AUDIT, file, ...complaints], { timeout: 1_000_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env } });
    return { code: 0, out: stdout };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

async function withRecord(rec: object, ...complaints: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'fuin-audit-'));
  try {
    const file = join(dir, 'record.json');
    writeFileSync(file, JSON.stringify(rec));
    return await audit(file, ...complaints);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('audit (live testnet)', () => {
  it('the published auction passes: the chain scan finds exactly the 7 recorded deposits', async () => {
    const r = await audit(RECORD);
    // Sale 001's id hashes only its name: the audit says its terms are read from the record.
    expect(r.out).toContain('! terms: legacy: the auction id hashes only its name');
    expect(r.out).toMatch(/7 transaction\(s\) pay the auction/);
    // The chain cannot show what the settlement paid: without a recipient key the run says so.
    expect(r.out).toContain("\nchain checks pass; payments not checked: give the seller's incoming viewing key (SBA_SELLER_UIVK) to check the seller's payout, and a complaint with a refund key to check a refund");
    expect(r.out).not.toMatch(/all checks pass/);
    expect(r.code).toBe(0);
  }, 300_000);

  it('a record that hides a deposit fails: the late deposit, owed a refund, is found on chain anyway', async () => {
    const rec = JSON.parse(readFileSync(RECORD, 'utf8'));
    const late = rec.deposits.find((d: { status: string }) => d.status === 'late').txid as string;
    rec.deposits = rec.deposits.filter((d: { txid: string }) => d.txid !== late);
    const dir = mkdtempSync(join(tmpdir(), 'fuin-audit-'));
    try {
      const file = join(dir, 'hidden.json');
      writeFileSync(file, JSON.stringify(rec));
      const r = await audit(file);
      expect(r.out).toContain(`NOT LISTED: ${late}`);
      expect(r.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('a record that understates the settlement height, so the scan stops before the late deposit it hides, fails: the height comes from the chain', async () => {
    const rec = JSON.parse(readFileSync(RECORD, 'utf8'));
    const late = rec.deposits.find((d: { status: string }) => d.status === 'late');
    rec.deposits = rec.deposits.filter((d: { txid: string }) => d.txid !== late.txid);
    rec.settlement = { ...rec.settlement, height: late.height - 4 };
    const r = await withRecord(rec);
    expect(r.out).toContain(`✗ settlement ${rec.settlement.txid.slice(0, 10)} is mined at block 4522291; the record says ${late.height - 4}`);
    // The scan runs to the chain's settlement height, so the hidden deposit is found anyway.
    expect(r.out).toMatch(/blocks 4522258-4522291 scanned/);
    expect(r.out).toContain(`NOT LISTED: ${late.txid}`);
    expect(r.out).not.toMatch(/all checks pass/);
    expect(r.code).toBe(1);
  }, 300_000);
});

describe('audit of the reveal-channel auction (live testnet)', () => {
  const rec2 = () => JSON.parse(readFileSync(RECORD2, 'utf8'));

  it('passes: the two-payment transaction reads as two deposits and the reveal log matches the reveal notes on chain', async () => {
    const rec = rec2();
    const r = await audit(RECORD2);
    expect(r.out).toContain('! terms: legacy: the auction id hashes only its name');
    const multi = rec.deposits.filter((d: { output?: string; status: string }) => d.output !== undefined && d.status !== 'memo_mismatch');
    expect(multi.map((d: { status: string }) => d.status).sort()).toEqual(['duplicate', 'valid']);
    for (const d of multi) expect(r.out).toContain(`${d.txid.slice(0, 10)}:${d.output} ${d.status}`);
    expect(r.out).toMatch(/12 transaction\(s\) pay the auction, 9 of their payments are deposits/);
    expect(r.out).toMatch(/✓ reveals_listed: 5 reveal note\(s\) on chain, 5 in the record/);
    expect(r.out).toMatch(/✓ reveal_status/);
    expect(r.out).toMatch(/note: deposit \w+ is unrevealed and no reveal note names it/);
    expect(r.out).toMatch(/chain checks pass; payments not checked/);
    expect(r.code).toBe(0);
  }, 300_000);

  it('a record whose auction id matches neither its terms nor its name fails the terms check', async () => {
    const rec = rec2();
    const r = await withRecord({ ...rec, auction: { ...rec.auction, name: `${rec.auction.name}-renamed` } });
    expect(r.out).toContain(`✗ terms: the auction id ${rec.auction.auctionId} is not the hash of these terms`);
    expect(r.code).toBe(1);
  }, 300_000);

  it('fails when the record hides a reveal note or calls the late reveal tampered', async () => {
    const rec = rec2();
    const attack = rec.reveals.find((v: { status: string }) => v.status === 'wrong_commitment');
    const hidden = await withRecord({ ...rec, reveals: rec.reveals.filter((v: { ref: string }) => v.ref !== attack.ref) });
    expect(hidden.out).toContain(`NOT LISTED: ${attack.ref}`);
    expect(hidden.code).toBe(1);
    const relabelled = await withRecord({ ...rec, reveals: rec.reveals.map((v: { status: string }) => (v.status === 'late' ? { ...v, status: 'tampered' } : v)) });
    expect(relabelled.out).toMatch(/✗ reveal_status: \w+ is late \(mined at \d+, after the reveal window closed at \d+\) but the record says tampered/);
    expect(relabelled.code).toBe(1);
  }, 600_000);

  it('a record naming an unrelated transaction as its settlement, with no complaint and no seller key, no longer ends "all checks pass": payments not checked', async () => {
    const rec = rec2();
    // A public testnet transaction from another project (zec-null-402 pass 2), mined after the window, that does not pay the auction:
    // every chain check passes on it, which is why the chain alone cannot say the settlement paid anyone.
    const unrelated = { txid: '90f70d6a79edafb8ec5fb4f0c845aab0af9b56a90b3d51d01800c11783c6c9d4', height: 4529569 };
    const r = await withRecord({ ...rec, settlement: { ...rec.settlement, ...unrelated } });
    expect(r.out).toContain(`✓ settlement 90f70d6a79 is mined at block 4529569, as the record says, after the reveal window (block ${rec.auction.revealCloseHeight})`);
    expect(r.out).toContain('✓ the auction key sees no outputs of the settlement');
    expect(r.out).not.toMatch(/all checks pass/);
    expect(r.out).toContain("\nchain checks pass; payments not checked: give the seller's incoming viewing key (SBA_SELLER_UIVK) to check the seller's payout");
    expect(r.code).toBe(0);
  }, 1_200_000); // scans about 3,100 blocks (to the unrelated transaction's height): several minutes

  it.skipIf(!sellerUivk)("with the seller's viewing key (local demo state): the real settlement paid the winning bid; a swapped settlement fails 'seller received 0 zat, owed 135000'", async () => {
    const rec = rec2();
    env = { SBA_SELLER_UIVK: sellerUivk! };
    try {
      const honest = await audit(RECORD2);
      expect(honest.out).toContain('✓ seller received 135000 zat, owed 135000 (legacy settlement memos: compared in total)');
      expect(honest.out).toMatch(/\nall checks pass\n/);
      expect(honest.code).toBe(0);
      const other = rec.reveals.find((v: { status: string }) => v.status === 'late');
      const swapped = await withRecord({ ...rec, settlement: { ...rec.settlement, txid: other.txid, height: other.height } });
      expect(swapped.out).toContain('✗ seller received 0 zat, owed 135000 (the winning bid)');
      expect(swapped.code).toBe(1);
    } finally {
      env = {};
    }
  }, 600_000);

  it("a note mined after the auctioneer's scan (scannedTo) is reported, not failed: anyone can pay the auction between the scan and the settlement", async () => {
    const rec = rec2();
    // The late reveal (block 4526489) was mined after the window and before the settlement (4526493): as if it arrived after the auctioneer's scan.
    const late = rec.reveals.find((v: { status: string }) => v.status === 'late');
    const unlisted = rec.reveals.filter((v: { ref: string }) => v.ref !== late.ref);
    const r = await withRecord({ ...rec, scannedTo: late.height - 1, reveals: unlisted });
    expect(r.out).toContain(`✓ the record covers blocks up to ${late.height - 1} (the auctioneer's scan), at or after the end of the reveal window (block ${rec.auction.revealCloseHeight})`);
    expect(r.out).toContain(`note: reveal ${late.ref.slice(0, 10)} (block ${late.height}) is outside the record (mined after the auctioneer's scan to ${late.height - 1}, after the reveal window): it cannot affect the outcome`);
    expect(r.out).toMatch(/✓ reveals_listed: 4 reveal note\(s\) on chain, 4 in the record/);
    expect(r.out).not.toContain('NOT LISTED');
    expect(r.code).toBe(0);
    // A scan that stops inside the reveal window does not cover it: that fails.
    const short = await withRecord({ ...rec, scannedTo: rec.auction.revealCloseHeight - 1, reveals: unlisted });
    expect(short.out).toContain(`✗ the record covers blocks up to ${rec.auction.revealCloseHeight - 1} (the auctioneer's scan), BEFORE the end of the reveal window (block ${rec.auction.revealCloseHeight})`);
    expect(short.code).toBe(1);
  }, 600_000);

  it("checks the winner's complaint against the chain: unfounded on the real settlement, upheld (names the shortfall) when the record points at another settlement", async () => {
    const rec = rec2();
    // Sale 002's complaint, named by its record (deployments/complaints also holds Sale 003's).
    const file = join(ROOT, 'deployments', rec.complaints[0].file);
    expect(readdirSync(COMPLAINTS)).toContain(file.split('/').pop());
    const honest = await audit(RECORD2, file);
    expect(honest.out).toContain(`✓ settlement ${rec.settlement.txid.slice(0, 10)} is mined at block ${rec.settlement.height}, as the record says, after the reveal window (block ${rec.auction.revealCloseHeight})`);
    // Sale 002's settlement predates memos that name each deposit (all say `settlement`), so the payment is summed per refund key.
    expect(honest.out).toMatch(/complaint \S+ unfounded: reveal \w+ \(block \d+\) was honoured; legacy settlement memos do not say which deposit an output pays: the refund key received 5000 zat in settlement \w+, this opening is owed 5000/);
    expect(honest.out).toContain(`refund key of ${file.split('/').pop()}: paid in full: the refund address received 5000 zat in settlement ${rec.settlement.txid.slice(0, 10)}, owed 5000 across complaint ${file.split('/').pop()}`);
    expect(honest.code).toBe(0);
    // A record that names as its settlement a transaction mined before the reveal window closed (bidder1's deposit) fails on the chain height alone.
    const early = rec.deposits.find((d: { label: string | null }) => d.label?.startsWith('bidder1 sealed bid'));
    const before = await withRecord({ ...rec, settlement: { ...rec.settlement, txid: early.txid } }, file);
    expect(before.out).toContain(`✗ settlement ${early.txid.slice(0, 10)} is mined at block ${early.height}; the record says ${rec.settlement.height}, NOT after the reveal window (block ${rec.auction.revealCloseHeight})`);
    expect(before.code).toBe(1);
    // One that names a transaction mined after the window, at the height it gives (the late reveal note), passes that check; the complaint shows it never paid this bidder.
    const other = rec.reveals.find((v: { status: string }) => v.status === 'late');
    const lying = await withRecord({ ...rec, settlement: { ...rec.settlement, txid: other.txid, height: other.height } }, file);
    expect(lying.out).toContain(`✓ settlement ${other.txid.slice(0, 10)} is mined at block ${other.height}, as the record says`);
    expect(lying.out).toContain(`✗ complaint ${file.split('/').pop()} UPHELD: the refund address received 0 zat in settlement ${other.txid.slice(0, 10)}, owed 5000 (5000 winner change for`);
    expect(lying.code).toBe(1);
  }, 900_000);
});

describe('audit of Sale 003, under the current rules (live testnet)', () => {
  const rec3 = () => JSON.parse(readFileSync(RECORD3, 'utf8'));

  it("passes with bound terms, scannedTo, the forfeit declared and the winner's no-key complaint unfounded; without the seller's key it says payments were not checked", async () => {
    const rec = rec3();
    const r = await audit(RECORD3, join(ROOT, 'deployments', rec.complaints[0].file));
    expect(r.out).toContain('✓ terms: the auction id is the hash of every term');
    expect(r.out).not.toContain('! terms: legacy');
    expect(r.out).toContain(`✓ the record covers blocks up to ${rec.scannedTo} (the auctioneer's scan), at or after the end of the reveal window (block ${rec.auction.revealCloseHeight})`);
    expect(r.out).toMatch(/✓ reveals_listed: 5 reveal note\(s\) on chain, 5 in the record/);
    expect(r.out).toContain(`✓ 37e5c2df32:2 duplicate`);
    expect(r.out).toContain(`note: deposit ${rec.outcome.unrevealed[0].slice(0, 10)} is unrevealed and no reveal note names it`);
    expect(r.out).toMatch(/complaint \S+ unfounded: reveal 6e9e9cf97c \(block 4530306\) was honoured; payment not checked: the complaint gives no refund viewing key/);
    expect(r.out).toContain("\nchain checks pass; payments not checked: give the seller's incoming viewing key (SBA_SELLER_UIVK) to check the seller's payout, and a complaint with a refund key to check a refund");
    expect(r.code).toBe(0);
  }, 600_000);

  it.skipIf(!sellerUivk3)("with the seller's viewing key (local demo state): the winning bid and the forfeit (memo forfeit:<deposit>) reached the seller, and the run ends all checks pass", async () => {
    const rec = rec3();
    env = { SBA_SELLER_UIVK: sellerUivk3! };
    try {
      const r = await audit(RECORD3);
      expect(r.out).toContain('✓ seller received 135000 zat, owed 135000 (the winning bid)');
      expect(r.out).toContain(`✓ forfeit of ${rec.outcome.unrevealed[0].slice(0, 10)}: seller received 195000 zat, owed 195000`);
      expect(r.out).toMatch(/\nall checks pass\n/);
      expect(r.code).toBe(0);
    } finally {
      env = {};
    }
  }, 600_000);
});
