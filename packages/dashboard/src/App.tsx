import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import * as snarkjs from 'snarkjs';
import { checkResult, isCanonicalCommitment, type ResultCheck } from '@sba/circuits/result';
import { emptyCommitment } from '@sba/circuits/poseidon';
import run1 from '@deployments/testnet.json';
import run2 from '@deployments/testnet-reveal.json';
import run3 from '@deployments/testnet-sale003.json';
import complaint2 from '@deployments/complaints/2582488456264710777-07ec9dcd0814d5557ebf72932e1e4931c8ea944b5a8e87a641c2df45062d5553.complaint.json';
import complaint3 from '@deployments/complaints/131728459360241149736859342020074215002-6e9e9cf97c662997b116e7cb20c9709f14433bea8591ab4d3c8659f46f1f7f5a.complaint.json';

/* ---------- the published sales ---------- */
type Deposit = { txid: string; output?: string; height: number | null; valueZat: string; memo: string; status: string; reason: string | null; label?: string | null };
type BlockTime = { height: number; time: number; hash: string };
type RevealEntry = { ref: string; txid: string; height: number | null; deposit: string | null; status: string; reason: string | null; label: string | null };
type SaleRecord = {
  auction: { name: string; auctionId: string; uivk: string; depositZat: string; reserveZat: string; openHeight: number; closeHeight: number; revealCloseHeight?: number; disputeBlocks?: number };
  deposits: Deposit[];
  alteredReveal?: { rejected: boolean; reason: string };
  reveals?: RevealEntry[];
  outcome: { winnerSlot: number; winningBidZat: string; proof: object; publicSignals: string[]; unrevealed?: string[] };
  settlement: { txid: string; height: number; outputs: { amountZat: string; why: string; recipient: string }[]; viewingKeyChecks: { recipient: string; expected: string; seen: number[]; ok: boolean }[] };
  ironwoodOnly: boolean;
  blockTimes: { open: BlockTime; close: BlockTime; revealClose?: BlockTime; settlement: BlockTime };
  verificationKeySha256: string;
  complaints?: { file: string; by: string; anchor: { txid: string; height: number } }[];
};
type Complaint = { kind: string; auctionId: string; deposit: string; reveal: string; revealSecret: string; refundViewingKey: string | null; signature: string };

export type SaleId = '003' | '002' | '001';
/** The audit's verdict on a sale's complaint, from a live run (an e2e test re-runs the audit and compares). */
interface Verdict {
  date: string;
  verdict: string;
  reason: string;
  /** What the audit said about the payment. */
  paid: string;
  /** Why this complaint matters for privacy. */
  note: string;
}
interface Sale {
  id: SaleId;
  tab: string;
  r: SaleRecord;
  /** The audit command for this sale, from the repository root. */
  audit: string;
  /** Before bound terms, tagged settlement memos and forfeits to the seller (Sales 001 and 002). */
  legacy: boolean;
  complaint?: Complaint;
  verdict?: Verdict;
}
const ref = (d: { txid: string; output?: string }) => (d.output === undefined ? d.txid : `${d.txid}:${d.output}`);
const auditOf = (file: string, r: SaleRecord) => `pnpm --filter @sba/service run audit deployments/${file} deployments/${r.complaints?.[0]?.file ?? ''}`.trim();
const SALES: Sale[] = [
  {
    id: '003',
    tab: 'Sale 003 · current rules',
    r: run3 as unknown as SaleRecord,
    audit: auditOf('testnet-sale003.json', run3 as unknown as SaleRecord),
    legacy: false,
    complaint: complaint3 as Complaint,
    verdict: {
      date: '23 Oct 2026',
      verdict: 'unfounded',
      reason: 'reveal 6e9e9cf97c (block 4530306) was honoured',
      paid: 'payment not checked: the complaint gives no refund viewing key',
      note: "Filing it made bidder2's own bid public (it is the winning bid). It was filed without a refund key, so it publishes no viewing key.",
    },
  },
  {
    id: '002',
    tab: 'Sale 002 · reveal channel',
    r: run2 as unknown as SaleRecord,
    audit: auditOf('testnet-reveal.json', run2 as unknown as SaleRecord),
    legacy: true,
    complaint: complaint2 as Complaint,
    verdict: {
      date: '22 Oct 2026',
      verdict: 'unfounded',
      reason: 'reveal 07ec9dcd08 (block 4526464) was honoured',
      paid: 'paid in full: the refund address received 5000 zat in settlement e84de386e2, owed 5000',
      note: "Filing it made bidder2's own bid public (it is the winning bid). It was filed before the refund key became opt-in, so it also carries the incoming viewing key of bidder2's whole demo wallet: every testnet payment to that wallet is readable with it.",
    },
  },
  { id: '001', tab: 'Sale 001 · first sale', r: run1 as unknown as SaleRecord, audit: 'pnpm --filter @sba/service run audit deployments/testnet.json', legacy: true },
];

const EXPLORER = 'https://testnet.zecblock.com/tx/';
const REPO = 'https://github.com/nickthelegend/zec-sealed-bid-auction';
const taz = (z: string | number) => `${(Number(z) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 6 })} TAZ`;
const zat = (z: string | number) => Number(z).toLocaleString('en-US');
const short = (s: string, a = 8) => (s.length > a + 1 ? `${s.slice(0, a)}…` : s);
const shortRef = (s: string) => (s.length > 64 ? `${s.slice(0, 8)}…${s.slice(64)}` : short(s));
const utc = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);
// Only a canonical commitment (no leading zero, below the field modulus) is a bid, as in the service's parseMemo.
const commitmentOf = (d: Deposit) => {
  const c = d.memo.split(':')[2];
  return c !== undefined && isCanonicalCommitment(c) ? c : null;
};
const pad = (n: number) => String(n).padStart(2, '0');
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

type Kind = 'sealed' | 'opened' | 'unrevealed' | 'refused';
/** What the page derives from a record: the proven deposits (valid, revealed, chain order), the winner, each lot's kind. */
function view(s: Sale) {
  const unrevealed = s.r.outcome.unrevealed ?? [];
  const proven = s.r.deposits.filter((d) => d.status === 'valid' && !unrevealed.includes(ref(d)));
  const winner = proven[s.r.outcome.winnerSlot] ? ref(proven[s.r.outcome.winnerSlot]) : null;
  const kindOf = (d: Deposit): Kind => (ref(d) === winner ? 'opened' : d.status !== 'valid' ? 'refused' : unrevealed.includes(ref(d)) ? 'unrevealed' : 'sealed');
  return { unrevealed, proven, winner, kindOf };
}
const STATUS: { [k: string]: string } = { wrong_amount: 'Wrong amount', memo_mismatch: 'Memo mismatch', duplicate: 'Duplicate', late: 'Late', pending: 'Pending', over_capacity: 'Over capacity' };

/* ---------- live clock: time since the settlement block's header time ---------- */
function useSince(t: number) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, now - t);
  return [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60];
}

function Clock({ since }: { since: number }) {
  const [d, h, m, s] = useSince(since);
  return (
    <div className="clock" role="timer" aria-label={`${plural(d, 'day')} ${plural(h, 'hour')} ${plural(m, 'minute')} since the hammer`}>
      <span className="clock-label">Since the hammer</span>
      <span className="digits" aria-hidden="true">
        {[
          [d, 'D'],
          [h, 'H'],
          [m, 'M'],
          [s, 'S'],
        ].map(([v, u]) => (
          <span key={u as string}>
            {pad(v as number)}
            <small>{u}</small>
          </span>
        ))}
      </span>
    </div>
  );
}

/* ---------- lot cards ---------- */
function Plate({ d, kind, sale }: { d: Deposit; kind: Kind; sale: Sale }) {
  if (kind === 'opened')
    return (
      <div className="plate plate-open">
        <span className="plate-flap" aria-hidden="true" />
        <span className="plate-letter">
          <small>Winning bid</small>
          <strong>{taz(sale.r.outcome.winningBidZat)}</strong>
        </span>
      </div>
    );
  if (kind === 'sealed') return <div className="plate plate-sealed" aria-hidden="true" />;
  if (kind === 'unrevealed')
    return (
      <div className="plate plate-sealed plate-unrevealed">
        <span>Never opened</span>
      </div>
    );
  return (
    <div className="plate plate-refused">
      <span>{STATUS[d.status] ?? d.status}</span>
    </div>
  );
}

const TAG: { [k in Kind]: string } = { opened: 'Opened', sealed: 'Sealed', unrevealed: 'Unrevealed', refused: 'Refused' };

function Lot({ d, n, sale, kind }: { d: Deposit; n: number; sale: Sale; kind: Kind }) {
  const c = commitmentOf(d);
  return (
    <li className={`lot lot-${kind}`}>
      <div className="lot-top">
        <b>LOT {pad(n)}</b>
        <span className={`tag tag-${kind}`}>{TAG[kind]}</span>
      </div>
      <Plate d={d} kind={kind} sale={sale} />
      <dl>
        <div>
          <dt>Deposit</dt>
          <dd>{taz(d.valueZat)}</dd>
        </div>
        <div>
          <dt>Block</dt>
          <dd>{d.height?.toLocaleString('en-US') ?? 'pending'}</dd>
        </div>
        <div>
          <dt>Tx</dt>
          <dd>
            <a href={EXPLORER + d.txid} target="_blank" rel="noreferrer" aria-label={`Transaction ${d.txid}${d.output === undefined ? '' : ` output ${d.output}`} on the explorer`}>
              {short(d.txid)}
              {d.output === undefined ? '' : `:${d.output}`} ↗
            </a>
          </dd>
        </div>
        {c && d.status !== 'memo_mismatch' && (
          <div>
            <dt>Commitment</dt>
            <dd title={c}>{short(c, 10)}</dd>
          </div>
        )}
      </dl>
      <p className="why">
        {kind === 'opened' && 'Opened by the MaxBid proof: the highest bid, at or above the reserve.'}
        {kind === 'sealed' && 'A losing bid. Refunded in full; the amount is never published.'}
        {kind === 'unrevealed' &&
          (sale.legacy
            ? 'Never revealed: left out of the proof and listed in the outcome. With no refund address it was not refunded; this sale predates the rule that forfeits it to the seller.'
            : 'Never revealed: left out of the proof, listed in the outcome and forfeited to the seller (memo forfeit:<deposit>), minus its 5,000 zat output fee.')}
        {kind === 'refused' && (d.reason ?? 'not a bid')}
      </p>
    </li>
  );
}

const FILTERS: { id: 'all' | Kind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'sealed', label: 'Sealed' },
  { id: 'opened', label: 'Opened' },
  { id: 'unrevealed', label: 'Unrevealed' },
  { id: 'refused', label: 'Refused' },
];

function Catalogue({ sale }: { sale: Sale }) {
  const [filter, setFilter] = useState<'all' | Kind>('all');
  const { kindOf } = useMemo(() => view(sale), [sale]);
  const counts = useMemo(() => {
    const c: { [k: string]: number } = { all: sale.r.deposits.length, sealed: 0, opened: 0, unrevealed: 0, refused: 0 };
    sale.r.deposits.forEach((d) => c[kindOf(d)]++);
    return c;
  }, [sale, kindOf]);
  const shown = sale.r.deposits.map((d, i) => ({ d, n: i + 1, kind: kindOf(d) })).filter(({ kind }) => filter === 'all' || kind === filter);
  return (
    <section className="block" aria-labelledby="lots-title">
      <div className="block-head">
        <div>
          <span className="eyebrow">The lots</span>
          <h2 id="lots-title">Every deposit to the auction</h2>
        </div>
        <div className="chips" role="group" aria-label="Filter lots">
          {FILTERS.filter((f) => f.id !== 'unrevealed' || counts.unrevealed > 0).map((f) => (
            <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} <span>{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="block-sub">
        In chain order, as the audit finds them by scanning blocks {sale.r.auction.openHeight.toLocaleString('en-US')} to {sale.r.settlement.height.toLocaleString('en-US')} with
        the auction&apos;s incoming viewing key. A transaction that pays the auction twice is two lots.
      </p>
      {shown.length === 0 ? (
        <p className="empty">No lots in this group.</p>
      ) : (
        <ul className="lots">
          {shown.map(({ d, n, kind }) => (
            <Lot key={ref(d)} d={d} n={n} sale={sale} kind={kind} />
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- verification, in this tab ---------- */
type Step = { name: string; label: string; state: 'wait' | 'run' | 'ok' | 'bad' | 'error'; detail: string };
type Tamper = 'none' | 'bid' | 'phantom';
const STEP_LABELS: [string, string][] = [
  ['vk', 'Verification key is the published one'],
  ['proof', 'Groth16 proof verifies'],
  ['slots', 'Proof covers exactly the valid deposits'],
  ['winner', 'Winner is a real deposit'],
];
const fresh = (): Step[] => STEP_LABELS.map(([name, label]) => ({ name, label, state: 'wait', detail: '' }));

async function sha256Hex(buf: ArrayBuffer | Uint8Array) {
  const h = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Served next to the page: './verification_key.json' under the hosted subpath, '/verification_key.json' in dev. */
export const VK_URL = `${import.meta.env.BASE_URL}verification_key.json`;

function Verify({ sale }: { sale: Sale }) {
  const [steps, setSteps] = useState<Step[]>(fresh);
  const [tamper, setTamper] = useState<Tamper>('none');
  const [busy, setBusy] = useState(false);
  const set = (name: string, state: Step['state'], detail: string) => setSteps((s) => s.map((x) => (x.name === name ? { ...x, state, detail } : x)));
  const { proven, unrevealed } = useMemo(() => view(sale), [sale]);

  const runChecks = useCallback(
    async (t: Tamper) => {
      const r = sale.r;
      setBusy(true);
      setTamper(t);
      setSteps(fresh());
      const signals = [...r.outcome.publicSignals];
      if (t === 'bid') signals[signals.length - 1] = String(BigInt(signals[signals.length - 1]) + 1n);
      if (t === 'phantom') signals[2 + proven.length] = signals[2]; // a copy of the first proven commitment where an empty slot must be
      try {
        set('vk', 'run', '');
        const res = await fetch(VK_URL);
        if (!res.ok) throw new Error(`verification_key.json: HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const hex = await sha256Hex(buf);
        set('vk', hex === r.verificationKeySha256 ? 'ok' : 'bad', `sha256 ${hex.slice(0, 12)}… ${hex === r.verificationKeySha256 ? 'matches' : 'does not match'} the record`);
        const vk = JSON.parse(new TextDecoder().decode(buf));

        set('proof', 'run', '');
        const ok = await snarkjs.groth16.verify(vk, signals, r.outcome.proof);
        set('proof', ok ? 'ok' : 'bad', ok ? 'pairing check passes in this tab (snarkjs)' : 'the proof does not verify for these public signals');

        set('slots', 'run', '');
        const check: ResultCheck = checkResult({
          auctionId: BigInt(r.auction.auctionId),
          reserve: BigInt(r.auction.reserveZat),
          deposits: r.deposits.map((d) => ({ txid: ref(d), height: d.height, status: d.status, commitment: d.status === 'memo_mismatch' ? null : commitmentOf(d) })),
          unrevealed,
          publicSignals: signals,
          emptyCommitment: await emptyCommitment(BigInt(r.auction.auctionId)),
        });
        const by = (n: string) => check.checks.find((c) => c.name === n)!;
        const slotsOk = by('slots').ok && by('unrevealed').ok && by('auction').ok;
        set('slots', slotsOk ? 'ok' : 'bad', [by('auction'), by('unrevealed'), by('slots')].filter((c) => (!slotsOk ? !c.ok : c.name === 'slots')).map((c) => c.detail).join('; '));
        set('winner', by('winner').ok ? 'ok' : 'bad', by('winner').detail);
      } catch (e) {
        // The step that was running failed; the ones after it never ran, so they say that instead of repeating its error.
        setSteps((s) => s.map((x) => (x.state === 'run' ? { ...x, state: 'error', detail: (e as Error).message } : x.state === 'wait' ? { ...x, state: 'error', detail: 'not run: an earlier check could not finish' } : x)));
      } finally {
        setBusy(false);
      }
    },
    [sale, proven, unrevealed],
  );

  useEffect(() => {
    void runChecks('none');
  }, [runChecks]);

  const done = steps.every((s) => s.state !== 'wait' && s.state !== 'run');
  const allOk = steps.every((s) => s.state === 'ok');
  const verdict = !done ? 'Checking in this tab…' : allOk ? 'The result holds.' : steps.some((s) => s.state === 'error') ? 'Could not finish the checks.' : 'The result does not hold.';

  return (
    <section className={`verify ${done ? (allOk ? 'is-ok' : 'is-bad') : ''}`} aria-labelledby="verify-title">
      <span className="eyebrow">Verify in this tab · Sale {sale.id}</span>
      <h2 id="verify-title" aria-live="polite">
        {verdict}
      </h2>
      <p className="verify-sub">
        {tamper === 'none' && `Against the published Sale ${sale.id} record, with the proof and checks the audit uses.`}
        {tamper === 'bid' && 'Tampered: the winning bid was raised by 1 zat.'}
        {tamper === 'phantom' && `Tampered: slot ${proven.length}, which must be empty, now holds a commitment.`}
      </p>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.name} className={`step step-${s.state}`}>
            <span className="step-mark" aria-hidden="true" />
            <span>
              <b>{s.label}</b>
              <small>{s.state === 'wait' ? 'waiting' : s.state === 'run' ? 'running…' : s.detail}</small>
            </span>
            <span className="sr-only">{s.state}</span>
          </li>
        ))}
      </ol>
      <div className="verify-actions">
        <button className="btn btn-ox" type="button" disabled={busy} onClick={() => void runChecks('none')}>
          Check the published result
        </button>
        <button className="btn btn-line" type="button" disabled={busy} onClick={() => void runChecks('bid')}>
          Claim 1 zat more
        </button>
        <button className="btn btn-line" type="button" disabled={busy} onClick={() => void runChecks('phantom')}>
          Slip in a phantom bid
        </button>
      </div>
      <p className="fineprint">
        This page checks the record against itself. Only the audit (<code>pnpm --filter @sba/service run audit</code>) re-reads the deposits from the chain.
      </p>
    </section>
  );
}

/* ---------- settlement ---------- */
function Provenance({ sale }: { sale: Sale }) {
  const r = sale.r;
  const { unrevealed } = view(sale);
  return (
    <section className="block" aria-labelledby="prov-title">
      <div className="block-head">
        <div>
          <span className="eyebrow">Provenance</span>
          <h2 id="prov-title">The settlement, checked by each recipient</h2>
        </div>
        <a className="btn btn-line" href={EXPLORER + r.settlement.txid} target="_blank" rel="noreferrer">
          {short(r.settlement.txid)} ↗
        </a>
      </div>
      <p className="block-sub">
        One shielded transaction at block {r.settlement.height.toLocaleString('en-US')} ({utc(r.blockTimes.settlement.time)} UTC), {r.settlement.outputs.length} outputs. Each
        recipient decrypted only its own with its own incoming viewing key.
      </p>
      <div className="ledger" role="table" aria-label="Settlement outputs by recipient">
        <div className="ledger-row ledger-head" role="row">
          <span role="columnheader">Recipient</span>
          <span role="columnheader">Expected</span>
          <span role="columnheader">Decrypted with its key</span>
          <span role="columnheader">Result</span>
        </div>
        {r.settlement.viewingKeyChecks.map((c) => (
          <div className="ledger-row" role="row" key={c.recipient}>
            <span role="cell" className="who">
              {c.recipient}
            </span>
            <span role="cell" className="num">
              {c.expected.split('+').map(zat).join(' + ')} zat
            </span>
            <span role="cell" className="num">
              {c.seen.map(zat).join(' + ')} zat
            </span>
            <span role="cell">{c.ok ? <span className="res res-ok">match</span> : <span className="res res-bad">mismatch</span>}</span>
          </div>
        ))}
      </div>
      <ul className="facts">
        <li>
          Every deposit and the settlement carry only an Ironwood bundle, no transparent part: <b>{r.ironwoodOnly ? 'yes' : 'no'}</b>.
        </li>
        {r.alteredReveal && (
          <li>
            An altered reveal (a bidder claiming a different bid with its real salt) was refused: <b>{r.alteredReveal.reason}</b>.
          </li>
        )}
        <li>
          Valid deposits declared unrevealed: <b>{unrevealed.length}</b>.
        </li>
      </ul>
    </section>
  );
}

function Audit({ sale }: { sale: Sale }) {
  return (
    <section className="block" aria-labelledby="audit-title">
      <div className="block-head">
        <div>
          <span className="eyebrow">Audit</span>
          <h2 id="audit-title">Re-read it from the chain</h2>
        </div>
      </div>
      <p className="block-sub">
        From the repository root: <code className="cmd">{sale.audit}</code>
      </p>
      <ol className="howto">
        <li>It reads the settlement&apos;s block height from the chain and scans the auction&apos;s blocks up to it with the incoming viewing key, so a deposit left out of the record shows up.</li>
        <li>It re-applies the rules to what the chain shows: late, duplicate, wrong amount, memo mismatch. A transaction that pays the auction twice is two deposits.</li>
        <li>It verifies the proof and ties it to those deposits, the same checks this page runs.</li>
        <li>
          It says whether the auction id commits to the terms. {sale.legacy ? 'This sale predates that, so its windows and reserve are read from the record ("legacy").' : "This sale's id is the hash of every term on its card (\"bound\")."}
        </li>
        <li>Given the seller&apos;s incoming viewing key (<code>SBA_SELLER_UIVK</code>) it checks the seller was paid the winning bid and every forfeit; without it the run ends &quot;payments not checked&quot;.</li>
        <li>On an auction with the reveal channel it checks the reveal log: every reveal note on chain is listed, and every status the chain alone decides (window, auction, named deposit) is right.</li>
        <li>
          Given a bidder&apos;s complaint file, it opens that bidder&apos;s reveal with the published secret and says <b>rejected</b>, <b>unfounded</b> or <b>upheld</b>, naming what the auctioneer did wrong.
        </li>
      </ol>
      <details className="key">
        <summary>Auction incoming viewing key</summary>
        <code>{sale.r.auction.uivk}</code>
        <p>Reads deposits to the auction address: amounts and commitment memos. It cannot spend, and it never shows a bid.</p>
      </details>
    </section>
  );
}

const REVEAL_STATUS: { [k: string]: string } = {
  accepted: 'accepted',
  duplicate: 'duplicate',
  conflicting: 'conflicting',
  wrong_commitment: 'wrong deposit',
  tampered: 'tampered',
  late: 'late',
  early: 'early',
  pending: 'pending',
  malformed: 'malformed',
  other_auction: 'other auction',
  unknown_deposit: 'no such deposit',
  bid_over_deposit: 'over deposit',
};

/** The complaint's digest, as the audit computes it (complaintDigest): sha256 of the signed body, then the signature. */
async function complaintDigest(c: Complaint) {
  const body = JSON.stringify([c.kind, c.auctionId, c.deposit, c.reveal, c.revealSecret, c.refundViewingKey]);
  return sha256Hex(new TextEncoder().encode(body + c.signature));
}

function ComplaintCard({ sale }: { sale: Sale }) {
  const meta = sale.r.complaints?.[0];
  const complaint = sale.complaint;
  const v = sale.verdict;
  const [digest, setDigest] = useState<string | null>(null);
  useEffect(() => {
    setDigest(null);
    if (complaint) void complaintDigest(complaint).then(setDigest);
  }, [complaint]);
  if (!meta || !complaint || !v) return null;
  return (
    <div className="complaint" aria-labelledby="complaint-title">
      <span className="eyebrow">Dispute</span>
      <h3 id="complaint-title">The winner&apos;s complaint</h3>
      <dl className="kv">
        <div>
          <dt>Filed by</dt>
          <dd>{meta.by} with MCP complain</dd>
        </div>
        <div>
          <dt>Deposit</dt>
          <dd className="num">{short(complaint.deposit)}</dd>
        </div>
        <div>
          <dt>Reveal it opens</dt>
          <dd className="num">{short(complaint.reveal)}</dd>
        </div>
        <div>
          <dt>Digest (computed here)</dt>
          <dd className="num" title={digest ?? undefined}>
            {digest ? `${digest.slice(0, 16)}…` : 'hashing…'}
          </dd>
        </div>
        <div>
          <dt>Anchored on chain</dt>
          <dd className="num">
            <a href={EXPLORER + meta.anchor.txid} target="_blank" rel="noreferrer">
              {short(meta.anchor.txid)} ↗
            </a>{' '}
            block {meta.anchor.height.toLocaleString('en-US')}
          </dd>
        </div>
      </dl>
      <p className="verdict">
        <span className="res res-ok">{v.verdict}</span> {v.reason}; {v.paid}.
      </p>
      <p className="fineprint">
        The audit&apos;s verdict from a live run on {v.date}; the command above re-checks it against the chain. {v.note}
      </p>
    </div>
  );
}

/* ---------- sale 2: openings read from sealed reveal notes on chain ---------- */
function RevealChannel({ sale }: { sale: Sale }) {
  const { reveals, settlement } = sale.r;
  const { unrevealed } = view(sale);
  if (!reveals) return null;
  // A bid transaction that pays the auction more than once (its payments are separate deposits).
  const multiTx = sale.r.deposits.find((d) => d.output !== undefined && d.status === 'valid')?.txid;
  const multi = sale.r.deposits.filter((d) => d.txid === multiTx);
  const checks = settlement.viewingKeyChecks;
  return (
    <section className="block" aria-labelledby="sale2-title">
      <div className="block-head">
        <div>
          <span className="eyebrow">Sale {sale.id} · the reveal channel</span>
          <h2 id="sale2-title">Bids opened by sealed memo</h2>
        </div>
      </div>
      <p className="block-sub">
        <code>{sale.r.auction.name}</code>. Three bidders, each its own <code>sba-mcp</code> server process with only its own wallet, bid and revealed through the MCP tools, driven by the <code>reveal-run</code> script (no language model chose a bid). After the
        close, each sent a 1-zat note to the auction address whose memo is its bid, salt and refund address sealed to the auction&apos;s reveal key. The public viewing key sees only which
        deposit a reveal names and when. The auctioneer read the openings from the chain, never from the bidders. Hammer price {taz(sale.r.outcome.winningBidZat)}.
      </p>
      <div className="ledger" role="table" aria-label="Reveal notes on chain">
        <div className="reveal-row ledger-head" role="row">
          <span role="columnheader">Block</span>
          <span role="columnheader">Reveal note</span>
          <span role="columnheader">Opens deposit</span>
          <span role="columnheader">Status</span>
        </div>
        {reveals.map((v) => (
          <div className="reveal-row" role="row" key={v.ref}>
            <span role="cell" className="num">
              {v.height?.toLocaleString('en-US') ?? 'mempool'}
            </span>
            <span role="cell">
              <a href={EXPLORER + v.txid} target="_blank" rel="noreferrer">
                {short(v.txid)}
              </a>
              {v.label ? <small>{v.label}</small> : null}
            </span>
            <span role="cell" className="num">
              {v.deposit ? shortRef(v.deposit) : '—'}
            </span>
            <span role="cell" title={v.reason ?? undefined}>
              <span className={`res ${v.status === 'accepted' ? 'res-ok' : 'res-bad'}`}>{REVEAL_STATUS[v.status] ?? v.status}</span>
            </span>
          </div>
        ))}
      </div>
      <ul className="facts">
        <li>
          Reveal window: blocks <b>{(sale.r.auction.closeHeight + 1).toLocaleString('en-US')}</b>–<b>{sale.r.auction.revealCloseHeight?.toLocaleString('en-US')}</b>; complaints
          until {sale.r.auction.disputeBlocks} blocks after the settlement.
        </li>
        {multi.length > 0 ? (
          <li>
            Transaction <b>{short(multi[0].txid)}</b> pays the auction {multi.length} times: read as {multi.length} deposits ({multi.map((d) => (d.status === 'valid' ? 'valid' : (STATUS[d.status]?.toLowerCase() ?? d.status))).join(', ')}).
          </li>
        ) : null}
        <li>
          Deposits never revealed, listed in the outcome: <b>{unrevealed.length}</b>
          {unrevealed.length ? ` (${unrevealed.map((t) => short(t)).join(', ')})` : ''}.
        </li>
        <li>
          Settlement outputs each recipient decrypted with its own key: <b>{checks.filter((c) => c.ok).length} of {checks.length} match</b>.
        </li>
      </ul>
      <ComplaintCard sale={sale} />
    </section>
  );
}

/* ---------- the page ---------- */
const initialSale = (): SaleId => {
  const q = new URLSearchParams(window.location.search).get('sale');
  return q === '001' || q === '002' ? q : '003';
};

export function App() {
  const [saleId, setSaleId] = useState<SaleId>(initialSale);
  const sale = SALES.find((s) => s.id === saleId)!;
  const { proven } = view(sale);
  const t = sale.r.blockTimes;
  const choose = (id: SaleId) => {
    setSaleId(id);
    const u = new URL(window.location.href);
    u.searchParams.set('sale', id);
    window.history.replaceState(null, '', u);
  };
  const timeline: [string, string, string][] = [
    ['Open', t.open.height.toLocaleString('en-US'), `${utc(t.open.time)} UTC`],
    ['Close', t.close.height.toLocaleString('en-US'), `${utc(t.close.time)} UTC`],
    ...(t.revealClose ? ([['Reveals close', t.revealClose.height.toLocaleString('en-US'), `${utc(t.revealClose.time)} UTC`]] as [string, string, string][]) : []),
    ['Hammer', t.settlement.height.toLocaleString('en-US'), `${utc(t.settlement.time)} UTC`],
    ['Reserve', taz(sale.r.auction.reserveZat), 'met'],
  ];
  return (
    <div className="page">
      <header className="bar">
        <div className="bar-in">
          <a className="word" href="#main" aria-label="Fuin saleroom">
            <b>Fuin</b>
            <span>Saleroom</span>
          </a>
          <nav aria-label="Links">
            <span className="net">
              <i aria-hidden="true" /> Zcash testnet
            </span>
            {import.meta.env.PROD && <a href={import.meta.env.VITE_CATALOGUE_URL || (window.location.hostname === 'fuin-dashboard.vercel.app' ? 'https://fuin-landing.vercel.app/' : '../')}>Catalogue</a>}
            <a href={REPO} target="_blank" rel="noreferrer">
              Code ↗
            </a>
          </nav>
        </div>
      </header>

      <main id="main" className="main" tabIndex={-1}>
        <div className="sales" role="tablist" aria-label="Sales">
          {SALES.map((s) => (
            <button key={s.id} type="button" role="tab" id={`tab-${s.id}`} aria-selected={s.id === saleId} aria-controls="sale-panel" className="sale-tab" onClick={() => choose(s.id)}>
              {s.tab}
            </button>
          ))}
        </div>
        <div id="sale-panel" role="tabpanel" aria-labelledby={`tab-${saleId}`}>
          <section className="sale" aria-labelledby="sale-title">
            <div className="sale-meta">
              <span className="lotno">SALE {sale.id}</span>
              <code>{sale.r.auction.name}</code>
            </div>
            <div className="sale-grid">
              <div>
                <h1 id="sale-title">
                  <span>Hammer price</span>
                  {taz(sale.r.outcome.winningBidZat)}
                </h1>
                <p className="sale-lede">
                  {sale.id !== '001'
                    ? `${proven.length} revealed sealed bids, each an equal ${taz(sale.r.auction.depositZat)} shielded deposit, placed through three separate sba-mcp servers driven by the reveal-run script. The proof opened the highest one; the other ${proven.length - 1} are never published.`
                    : `${proven.length} sealed bids, each an equal ${taz(sale.r.auction.depositZat)} shielded deposit. The proof opened the highest one; the other ${proven.length - 1} are never published.`}
                </p>
              </div>
              <Clock since={t.settlement.time} />
            </div>
            <ol className="timeline" aria-label="Auction timeline" style={{ '--n': timeline.length } as CSSProperties}>
              {timeline.map(([label, big, small]) => (
                <li key={label} className={label === 'Hammer' ? 'is-hammer' : undefined}>
                  <span>{label}</span>
                  <b>{big}</b>
                  <small>{small}</small>
                </li>
              ))}
            </ol>
          </section>

          <div className="layout">
            <div className="col">
              <Catalogue key={`lots-${sale.id}`} sale={sale} />
              <Provenance sale={sale} />
              <RevealChannel sale={sale} />
              <Audit sale={sale} />
            </div>
            <aside className="side">
              <Verify key={`verify-${sale.id}`} sale={sale} />
            </aside>
          </div>
        </div>
      </main>
      <footer className="foot">
        MIT · Copyright (c) 2026 Nivesh Gajengi · the auctioneer learns every bid at the reveal; the public learns only the winner&apos;s
      </footer>
    </div>
  );
}
