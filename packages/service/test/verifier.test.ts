// How scans are split for sba-verify, which takes at most 5,000 blocks per call (MAX_SCAN_BLOCKS in
// packages/verifier/src/main.rs, covered by its own Rust test). The live audit tests run real scans.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SCAN_BLOCKS, scan, scanWindows } from '../src/verifier.js';

describe('scan windows', () => {
  it('1..12001 is three windows of at most 5,000 blocks with no gap or overlap', () => {
    expect(MAX_SCAN_BLOCKS).toBe(5000);
    expect(scanWindows(1, 12001)).toEqual([
      [1, 5000],
      [5001, 10000],
      [10001, 12001],
    ]);
    expect(scanWindows(4526425, 4526493)).toEqual([[4526425, 4526493]]);
    expect(scanWindows(1, 5000)).toEqual([[1, 5000]]);
    expect(scanWindows(1, 5001)).toEqual([
      [1, 5000],
      [5001, 5001],
    ]);
    expect(scanWindows(10, 9)).toEqual([]);
  });

  it('scan calls sba-verify once per window and joins what each window finds', async () => {
    // A stand-in for the sba-verify binary (SBA_VERIFY_BIN) that refuses more than 5,000 blocks, as the
    // real one does, logs each call and reports one transaction per window.
    const dir = mkdtempSync(join(tmpdir(), 'fuin-scan-'));
    try {
      const bin = join(dir, 'sba-verify');
      const log = join(dir, 'calls');
      writeFileSync(bin, `#!/bin/sh\nif [ $(($3 - $2 + 1)) -gt 5000 ]; then echo "$(($3 - $2 + 1)) blocks requested, at most 5000" >&2; exit 1; fi\necho "$2-$3" >> "${log}"\necho '{"txid":"t'$2'","height":'$2',"confirmations":1,"outputs":[],"pools":{"sapling":false,"orchard":false,"ironwood":true,"transparent":false}}'\n`);
      chmodSync(bin, 0o755);
      const before = process.env.SBA_VERIFY_BIN;
      process.env.SBA_VERIFY_BIN = bin;
      try {
        const found = await scan('uivk', 1, 12001);
        expect(found.map((t) => t.txid)).toEqual(['t1', 't5001', 't10001']);
        expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['1-5000', '5001-10000', '10001-12001']);
      } finally {
        if (before === undefined) delete process.env.SBA_VERIFY_BIN;
        else process.env.SBA_VERIFY_BIN = before;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
