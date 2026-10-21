// The audit script against live Zcash testnet (lightwalletd via sba-verify). It finds deposits by
// scanning the auction's blocks with the published viewing key, so a deposit the auctioneer leaves
// out of its record is caught. No deposit is sent by these tests.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = resolve(__dirname, '../../..');
const RECORD = resolve(ROOT, 'deployments/testnet.json');
const RECORD2 = resolve(ROOT, 'deployments/testnet-reveal.json');
const COMPLAINTS = resolve(ROOT, 'deployments/complaints');
const TSX = resolve(__dirname, '../node_modules/.bin/tsx');
const AUDIT = resolve(__dirname, '../src/audit.ts');

async function audit(file: string, ...complaints: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await run(TSX, [AUDIT, file, ...complaints], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, out: stdout };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('audit (live testnet)', () => {
  it('the published auction passes: the chain scan finds exactly the 7 recorded deposits', async () => {
    const r = await audit(RECORD);
    expect(r.out).toMatch(/7 transaction\(s\) pay the auction/);
    expect(r.out).toMatch(/all checks pass/);
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
});

describe('audit of the reveal-channel auction (live testnet)', () => {
  const rec2 = () => JSON.parse(readFileSync(RECORD2, 'utf8'));
  const withRecord = async (rec: object, ...complaints: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'fuin-audit2-'));
    try {
      const file = join(dir, 'record.json');
      writeFileSync(file, JSON.stringify(rec));
      return await audit(file, ...complaints);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('passes: the two-payment transaction reads as two deposits and the reveal log matches the reveal notes on chain', async () => {
    const rec = rec2();
    const r = await audit(RECORD2);
    const multi = rec.deposits.filter((d: { output?: string; status: string }) => d.output !== undefined && d.status !== 'memo_mismatch');
    expect(multi.map((d: { status: string }) => d.status).sort()).toEqual(['duplicate', 'valid']);
    for (const d of multi) expect(r.out).toContain(`${d.txid.slice(0, 10)}:${d.output} ${d.status}`);
    expect(r.out).toMatch(/12 transaction\(s\) pay the auction, 9 of their payments are deposits/);
    expect(r.out).toMatch(/✓ reveals_listed: 5 reveal note\(s\) on chain, 5 in the record/);
    expect(r.out).toMatch(/✓ reveal_status/);
    expect(r.out).toMatch(/note: deposit \w+ is unrevealed and no reveal note names it/);
    expect(r.out).toMatch(/all checks pass/);
    expect(r.code).toBe(0);
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

  it("checks the winner's complaint against the chain: unfounded on the real settlement, upheld (names the shortfall) when the record points at another settlement", async () => {
    const rec = rec2();
    const [file] = readdirSync(COMPLAINTS).filter((f) => f.endsWith('.complaint.json')).map((f) => join(COMPLAINTS, f));
    const honest = await audit(RECORD2, file);
    expect(honest.out).toMatch(/complaint \S+ unfounded: reveal \w+ \(block \d+\) was honoured; paid in full: the refund address received 5000 zat in settlement \w+, owed 5000/);
    expect(honest.code).toBe(0);
    // An auctioneer whose record names as its settlement a transaction that never paid this bidder (bidder1's deposit).
    const other = rec.deposits.find((d: { label: string | null }) => d.label?.startsWith('bidder1 sealed bid')).txid as string;
    const lying = await withRecord({ ...rec, settlement: { ...rec.settlement, txid: other } }, file);
    expect(lying.out).toContain(`✗ complaint ${file.split('/').pop()} UPHELD: the refund address received 0 zat in settlement ${other.slice(0, 10)}, owed 5000 (5000 winner change for`);
    expect(lying.code).toBe(1);
  }, 600_000);
});
