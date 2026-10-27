// Thin wrapper over zingo-cli (testnet). One process per call; --waitsync so every read is current.
// Never calls `recovery_info` (it prints the seed). Errors carry zingo-cli's own message.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ZingoConfig {
  bin: string;
  server: string;
  /** A directory used as a machine-wide lock: zingo-cli's mixnet proxy fails when two run at once. */
  lock?: string;
}

export function zingoConfig(env: Record<string, string | undefined> = process.env): ZingoConfig {
  return {
    bin: env.SBA_ZINGO_CLI ?? join(homedir(), 'src/zingolib/target/release/zingo-cli'),
    server: env.SBA_LWD_URL ?? 'https://testnet.zec.rocks:443',
    ...(env.SBA_ZINGO_LOCK ? { lock: env.SBA_ZINGO_LOCK } : {}),
  };
}

/** Holds cfg.lock (mkdir is atomic) for the length of fn; without a lock configured, runs fn directly. */
async function locked<T>(cfg: ZingoConfig, fn: () => Promise<T>): Promise<T> {
  if (!cfg.lock) return fn();
  for (;;) {
    try {
      mkdirSync(cfg.lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`cannot take the zingo-cli lock ${cfg.lock}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  try {
    return await fn();
  } finally {
    rmdirSync(cfg.lock);
  }
}

async function zingo(cfg: ZingoConfig, walletDir: string, args: string[], timeoutMs = 600_000): Promise<string> {
  if (args[0] === 'recovery_info') throw new Error('refusing recovery_info: it prints the seed');
  return locked(cfg, () => zingoUnlocked(cfg, walletDir, args, timeoutMs));
}

async function zingoUnlocked(cfg: ZingoConfig, walletDir: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout, stderr } = await run(cfg.bin, ['--chain', 'testnet', '--server', cfg.server, '--data-dir', walletDir, '--waitsync', ...args], {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      cwd: '/tmp',
      env: { ...process.env, ZINGO_SEED: '' },
    });
    return `${stdout}\n${stderr}`;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`zingo-cli ${args[0]} failed: ${(err.stderr || err.stdout || err.message).trim().split('\n').slice(-3).join(' | ')}`);
  }
}

export async function address(cfg: ZingoConfig, walletDir: string): Promise<string> {
  const out = await zingo(cfg, walletDir, ['addresses']);
  const m = out.match(/"encoded_address":\s*"(utest1[0-9a-z]+)"/);
  if (!m) throw new Error(`no unified address in zingo-cli output for ${walletDir}`);
  return m[1];
}

export async function spendable(cfg: ZingoConfig, walletDir: string): Promise<bigint> {
  const out = await zingo(cfg, walletDir, ['spendable_balance']);
  const m = out.match(/spendable_balance["\s:]+(\d+)/) ?? out.match(/"?balance"?:\s*(\d+)/);
  if (!m) throw new Error(`could not read spendable balance: ${out.slice(-300)}`);
  return BigInt(m[1]);
}

export interface Receiver {
  address: string;
  amount: bigint;
  memo?: string;
}

/** zingo-cli in interactive mode: the lines are written to its stdin, then `quit`; returns its output. */
async function zingoInteractive(cfg: ZingoConfig, walletDir: string, lines: string[], timeoutMs = 900_000): Promise<string> {
  if (lines.some((l) => /^\s*recovery_info/.test(l))) throw new Error('refusing recovery_info: it prints the seed');
  return locked(cfg, () => new Promise<string>((resolveOut, reject) => {
    const p = spawn(cfg.bin, ['--chain', 'testnet', '--server', cfg.server, '--data-dir', walletDir, '--waitsync'], { cwd: '/tmp', env: { ...process.env, ZINGO_SEED: '' } });
    let out = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`zingo-cli timed out after ${timeoutMs / 1000} s: ${out.trim().split('\n').slice(-3).join(' | ')}`));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`zingo-cli could not start: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !/quit successfully/i.test(out)) reject(new Error(`zingo-cli exited ${code}: ${out.trim().split('\n').slice(-3).join(' | ')}`));
      else resolveOut(out);
    });
    p.stdin.write(lines.map((l) => `${l}\n`).join('') + 'quit\n');
    p.stdin.end();
  }));
}

/**
 * One shielded transaction to all receivers. Returns the broadcast txids. The current zingo-cli has no
 * one-shot quicksend, so this proposes with `send` and transmits with `confirm` in interactive mode.
 */
export async function quicksend(cfg: ZingoConfig, walletDir: string, receivers: Receiver[]): Promise<string[]> {
  const json = JSON.stringify(receivers.map((r) => ({ address: r.address, amount: Number(r.amount), ...(r.memo ? { memo: r.memo } : {}) })));
  if (json.includes("'")) throw new Error('a memo or address contains a single quote; nothing was sent');
  const out = await zingoInteractive(cfg, walletDir, [`send '${json}'`, 'confirm']);
  const afterConfirm = out.slice(Math.max(0, out.search(/"?txids"?\s*:/)));
  const m = afterConfirm.match(/"?txids"?\s*:\s*\[([^\]]*)\]/);
  const txids = m ? [...m[1].matchAll(/[0-9a-f]{64}/g)].map((x) => x[0]) : [];
  if (txids.length === 0) {
    const tail = out.trim().split('\n').filter((l) => !/Sweep|Launching|shutdown|quit successfully/i.test(l)).slice(-5).join(' | ');
    throw new Error(`send/confirm did not report a txid: ${tail}`);
  }
  return txids;
}

export interface ValueTransfer {
  txid: string;
  status: string;
  blockheight: number | null;
  kind: string;
  value: bigint;
  memos: string[];
}

/** Parses zingo-cli's `value_transfers` listing. */
export async function valueTransfers(cfg: ZingoConfig, walletDir: string): Promise<ValueTransfer[]> {
  const out = await zingo(cfg, walletDir, ['value_transfers']);
  const blocks = out.split(/\n\{\n/).slice(1);
  return blocks.map((b) => {
    const field = (k: string) => b.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
    const memosLine = field('memos');
    return {
      txid: field('txid'),
      status: field('status'),
      blockheight: /^\d+$/.test(field('blockheight')) ? Number(field('blockheight')) : null,
      kind: field('kind'),
      value: BigInt(/^\d+$/.test(field('value')) ? field('value') : '0'),
      memos: memosLine ? memosLine.split(/,\s*/).filter(Boolean) : [],
    };
  });
}

export async function height(cfg: ZingoConfig, walletDir: string): Promise<number> {
  const out = await zingo(cfg, walletDir, ['height']);
  const m = out.match(/"?height"?:\s*(\d+)/) ?? out.match(/(\d{7})/);
  if (!m) throw new Error('could not read the chain height');
  return Number(m[1]);
}

export async function exportUfvk(cfg: ZingoConfig, walletDir: string): Promise<string> {
  const out = await zingo(cfg, walletDir, ['export_ufvk']);
  const m = out.match(/uviewtest1[0-9a-z]+/);
  if (!m) throw new Error('no UFVK in export_ufvk output');
  return m[0];
}
