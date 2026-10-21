// Runs the Rust sba-verify binary: decrypts transactions with an incoming viewing key via lightwalletd.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface DecryptedTx {
  txid: string;
  height: number | null;
  confirmations: number;
  /** One entry per output the key decrypts; `index` is the output's action index in its pool's bundle. */
  outputs: { pool: string; index: number; value: number; memo: { text: string } | { non_text: true } | null }[];
  pools: { sapling: boolean; orchard: boolean; ironwood: boolean; transparent: boolean };
}

export function verifierBin(env: Record<string, string | undefined> = process.env): string {
  const bin = env.SBA_VERIFY_BIN ?? resolve(import.meta.dirname, '../../verifier/target/release/sba-verify');
  if (!existsSync(bin)) throw new Error(`Setup required: SBA_VERIFY_BIN (sba-verify not built at ${bin}; run pnpm build:verifier)`);
  return bin;
}

/** Decrypts `txids` with `uivk`. A tx with no decryptable output comes back with `outputs: []`. */
export async function decrypt(uivk: string, txids: string[]): Promise<DecryptedTx[]> {
  if (txids.length === 0) return [];
  try {
    const { stdout } = await run(verifierBin(), ['tx', ...txids], { env: { ...process.env, SBA_UIVK: uivk }, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as DecryptedTx);
  } catch (e) {
    throw new Error(`sba-verify failed: ${((e as { stderr?: string }).stderr ?? (e as Error).message).trim()}`);
  }
}

/**
 * Every transaction mined in blocks from..=to with an output `uivk` decrypts. An auditor uses this to
 * find all deposits to an auction instead of trusting the auctioneer's list.
 */
export async function scan(uivk: string, from: number, to: number): Promise<DecryptedTx[]> {
  try {
    const { stdout } = await run(verifierBin(), ['scan', String(from), String(to)], { env: { ...process.env, SBA_UIVK: uivk }, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as DecryptedTx);
  } catch (e) {
    throw new Error(`sba-verify scan failed: ${((e as { stderr?: string }).stderr ?? (e as Error).message).trim()}`);
  }
}

/** The chain tip height, from lightwalletd. */
export async function chainTip(): Promise<number> {
  try {
    const { stdout } = await run(verifierBin(), ['tip'], { timeout: 60_000 });
    return Number(stdout.trim());
  } catch (e) {
    throw new Error(`sba-verify tip failed: ${((e as { stderr?: string }).stderr ?? (e as Error).message).trim()}`);
  }
}

/** A block's header time (Unix seconds) and hash, from lightwalletd. */
export async function blockTime(height: number): Promise<{ height: number; time: number; hash: string }> {
  try {
    const { stdout } = await run(verifierBin(), ['block', String(height)], { timeout: 60_000 });
    return JSON.parse(stdout.trim());
  } catch (e) {
    throw new Error(`sba-verify block failed: ${((e as { stderr?: string }).stderr ?? (e as Error).message).trim()}`);
  }
}

/** UFVK → UIVK (UFVK passed by environment only). */
export async function uivkOf(ufvk: string): Promise<string> {
  const { stdout } = await run(verifierBin(), ['derive'], { env: { ...process.env, SBA_UFVK: ufvk }, timeout: 60_000 });
  return stdout.trim();
}

export const memoText = (m: DecryptedTx['outputs'][number]['memo']) => (m && 'text' in m ? m.text : '');

/** True when the transaction has only an Ironwood bundle (no transparent, Sapling or Orchard parts). */
export const ironwoodOnly = (t: DecryptedTx) => t.pools.ironwood && !t.pools.transparent && !t.pools.sapling && !t.pools.orchard;

/** Memo prefixes of channel messages (reveals, complaint anchors): notes that carry them are not deposits. */
export const CHANNEL_PREFIXES = ['sba1r:', 'sba1d:'];
const isChannel = (memo: string) => CHANNEL_PREFIXES.some((p) => memo.startsWith(p));
const outputName = (o: DecryptedTx['outputs'][number]) => `${o.pool === 'Ironwood' ? '' : o.pool === 'Orchard' ? 'o' : 's'}${o.index}`;

/**
 * Every deposit output of a decrypted transaction (channel messages left out). A transaction that
 * pays the auction once is one deposit named by its txid; one that pays it several times is one
 * deposit per output, each named `txid:<index>` (`o<index>` / `s<index>` for Orchard / Sapling).
 */
export function asDeposits(t: DecryptedTx): { txid: string; output?: string; height: number | null; value: bigint; memo: string }[] {
  const outs = t.outputs.filter((o) => !isChannel(memoText(o.memo)));
  return outs.map((o) => ({
    txid: t.txid,
    ...(outs.length > 1 ? { output: outputName(o) } : {}),
    height: t.height,
    value: BigInt(o.value),
    memo: memoText(o.memo),
  }));
}

/** The outputs of a decrypted transaction whose memo starts with `prefix` (e.g. `sba1r:`), named like deposits. */
export function asMessages(t: DecryptedTx, prefix: string): { txid: string; output?: string; height: number | null; value: bigint; memo: string }[] {
  const outs = t.outputs.filter((o) => memoText(o.memo).startsWith(prefix));
  return outs.map((o) => ({
    txid: t.txid,
    ...(outs.length > 1 ? { output: outputName(o) } : {}),
    height: t.height,
    value: BigInt(o.value),
    memo: memoText(o.memo),
  }));
}
