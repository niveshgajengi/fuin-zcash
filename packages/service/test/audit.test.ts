// The audit script against live Zcash testnet (lightwalletd via sba-verify). It finds deposits by
// scanning the auction's blocks with the published viewing key, so a deposit the auctioneer leaves
// out of its record is caught. No deposit is sent by these tests.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = resolve(__dirname, '../../..');
const RECORD = resolve(ROOT, 'deployments/testnet.json');
const TSX = resolve(__dirname, '../node_modules/.bin/tsx');
const AUDIT = resolve(__dirname, '../src/audit.ts');

async function audit(file: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await run(TSX, [AUDIT, file], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
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
