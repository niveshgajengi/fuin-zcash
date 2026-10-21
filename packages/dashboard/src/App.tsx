import { useCallback, useEffect, useMemo, useState } from 'react';
import * as snarkjs from 'snarkjs';
import { checkResult, readPublic, type ResultCheck } from '@sba/circuits/result';
import { emptyCommitment } from '@sba/circuits/poseidon';
import run from '@deployments/testnet.json';

type Deposit = { txid: string; height: number | null; valueZat: string; memo: string; status: string; reason: string | null; label?: string };
type BlockTime = { height: number; time: number; hash: string };
const r = run as unknown as {
  auction: { name: string; auctionId: string; address: string; uivk: string; depositZat: string; reserveZat: string; openHeight: number; closeHeight: number };
  deposits: Deposit[];
  alteredReveal: { rejected: boolean; reason: string };
  outcome: { winnerSlot: number; winningBidZat: string; reserveZat: string; commitments: string[]; proof: object; publicSignals: string[]; unrevealed?: string[] };
  settlement: { txid: string; height: number; outputs: { amountZat: string; why: string; recipient: string }[]; viewingKeyChecks: { recipient: string; expected: string; seen: number[]; ok: boolean }[] };
  ironwoodOnly: boolean;
  blockTimes: { open: BlockTime; close: BlockTime; settlement: BlockTime };
  verificationKeySha256: string;
};

const EXPLORER = 'https://testnet.zcashexplorer.app/transactions/';
const REPO = 'https://github.com/nickthelegend/zec-sealed-bid-auction';
const taz = (z: string | number) => `${(Number(z) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 6 })} TAZ`;
const zat = (z: string | number) => Number(z).toLocaleString('en-US');
const short = (s: string, a = 8) => (s.length > a + 1 ? `${s.slice(0, a)}…` : s);
const utc = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);
const commitmentOf = (d: Deposit) => d.memo.split(':')[2] ?? null;
const pad = (n: number) => String(n).padStart(2, '0');

const valid = r.deposits.filter((d) => d.status === 'valid');
const winnerTxid = valid[r.outcome.winnerSlot]?.txid;
type Kind = 'sealed' | 'opened' | 'refused';
const kindOf = (d: Deposit): Kind => (d.txid === winnerTxid ? 'opened' : d.status === 'valid' ? 'sealed' : 'refused');
const STATUS: Record<string, string> = { wrong_amount: 'Wrong amount', memo_mismatch: 'Memo mismatch', duplicate: 'Duplicate', late: 'Late', pending: 'Pending' };

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

function Clock() {
  const [d, h, m, s] = useSince(r.blockTimes.settlement.time);
  return (
    <div className="clock" role="timer" aria-label={`${d} days ${h} hours ${m} minutes since the hammer`}>
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
function Plate({ d, kind }: { d: Deposit; kind: Kind }) {
  if (kind === 'opened')
    return (
      <div className="plate plate-open">
        <span className="plate-flap" aria-hidden="true" />
        <span className="plate-letter">
          <small>Winning bid</small>
          <strong>{taz(r.outcome.winningBidZat)}</strong>
        </span>
      </div>
    );
  if (kind === 'sealed') return <div className="plate plate-sealed" aria-hidden="true" />;
  return (
    <div className="plate plate-refused">
      <span>{STATUS[d.status] ?? d.status}</span>
    </div>
  );
}

function Lot({ d, n }: { d: Deposit; n: number }) {
  const kind = kindOf(d);
  const c = commitmentOf(d);
  const tag = kind === 'opened' ? 'Opened' : kind === 'sealed' ? 'Sealed' : 'Refused';
  return (
    <li className={`lot lot-${kind}`}>
      <div className="lot-top">
        <b>LOT {pad(n)}</b>
        <span className={`tag tag-${kind}`}>{tag}</span>
      </div>
      <Plate d={d} kind={kind} />
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
            <a href={EXPLORER + d.txid} target="_blank" rel="noreferrer" aria-label={`Transaction ${d.txid} on the explorer`}>
              {short(d.txid)} ↗
            </a>
          </dd>
        </div>
        {c && (
          <div>
            <dt>Commitment</dt>
            <dd title={c}>{short(c, 10)}</dd>
          </div>
        )}
      </dl>
      <p className="why">
        {kind === 'opened' && 'Opened by the MaxBid proof: the highest bid, at or above the reserve.'}
        {kind === 'sealed' && 'A losing bid. Refunded in full; the amount is never published.'}
        {kind === 'refused' && (d.reason ?? 'not a bid')}
      </p>
    </li>
  );
}

const FILTERS: { id: 'all' | Kind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'sealed', label: 'Sealed' },
  { id: 'opened', label: 'Opened' },
  { id: 'refused', label: 'Refused' },
];

function Catalogue() {
  const [filter, setFilter] = useState<'all' | Kind>('all');
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: r.deposits.length, sealed: 0, opened: 0, refused: 0 };
    r.deposits.forEach((d) => c[kindOf(d)]++);
    return c;
  }, []);
  const shown = r.deposits.map((d, i) => ({ d, n: i + 1 })).filter(({ d }) => filter === 'all' || kindOf(d) === filter);
  return (
    <section className="block" aria-labelledby="lots-title">
      <div className="block-head">
        <div>
          <span className="eyebrow">The lots</span>
          <h2 id="lots-title">Every deposit to the auction</h2>
        </div>
        <div className="chips" role="group" aria-label="Filter lots">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} <span>{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="block-sub">
        In chain order, as the audit finds them by scanning blocks {r.auction.openHeight.toLocaleString('en-US')} to {r.settlement.height.toLocaleString('en-US')} with the
        auction&apos;s incoming viewing key.
      </p>
      {shown.length === 0 ? (
        <p className="empty">No lots in this group.</p>
      ) : (
        <ul className="lots">
          {shown.map(({ d, n }) => (
            <Lot key={d.txid} d={d} n={n} />
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

async function sha256Hex(buf: ArrayBuffer) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function Verify() {
  const [steps, setSteps] = useState<Step[]>(fresh);
  const [tamper, setTamper] = useState<Tamper>('none');
  const [busy, setBusy] = useState(false);
  const set = (name: string, state: Step['state'], detail: string) => setSteps((s) => s.map((x) => (x.name === name ? { ...x, state, detail } : x)));

  const runChecks = useCallback(async (t: Tamper) => {
    setBusy(true);
    setTamper(t);
    setSteps(fresh());
    const signals = [...r.outcome.publicSignals];
    if (t === 'bid') signals[signals.length - 1] = String(BigInt(signals[signals.length - 1]) + 1n);
    if (t === 'phantom') signals[2 + valid.length] = signals[2]; // a copy of lot 1's commitment where an empty slot must be
    try {
      set('vk', 'run', '');
      const res = await fetch('/verification_key.json');
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
        deposits: r.deposits.map((d) => ({ txid: d.txid, height: d.height, status: d.status, commitment: d.status === 'memo_mismatch' ? null : commitmentOf(d) })),
        unrevealed: r.outcome.unrevealed ?? [],
        publicSignals: signals,
        emptyCommitment: await emptyCommitment(BigInt(r.auction.auctionId)),
      });
      const by = (n: string) => check.checks.find((c) => c.name === n)!;
      const slotsOk = by('slots').ok && by('unrevealed').ok && by('auction').ok;
      set('slots', slotsOk ? 'ok' : 'bad', [by('auction'), by('unrevealed'), by('slots')].filter((c) => !slotsOk ? !c.ok : c.name === 'slots').map((c) => c.detail).join('; '));
      set('winner', by('winner').ok ? 'ok' : 'bad', by('winner').detail);
    } catch (e) {
      setSteps((s) => s.map((x) => (x.state === 'run' || x.state === 'wait' ? { ...x, state: 'error', detail: (e as Error).message } : x)));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void runChecks('none');
  }, [runChecks]);

  const done = steps.every((s) => s.state !== 'wait' && s.state !== 'run');
  const allOk = steps.every((s) => s.state === 'ok');
  const verdict = !done ? 'Checking in this tab…' : allOk ? 'The result holds.' : steps.some((s) => s.state === 'error') ? 'Could not finish the checks.' : 'The result does not hold.';

  return (
    <section className={`verify ${done ? (allOk ? 'is-ok' : 'is-bad') : ''}`} aria-labelledby="verify-title">
      <span className="eyebrow">Verify in this tab</span>
      <h2 id="verify-title" aria-live="polite">
        {verdict}
      </h2>
      <p className="verify-sub">
        {tamper === 'none' && 'Against the published record, with the proof and checks the audit uses.'}
        {tamper === 'bid' && 'Tampered: the winning bid was raised by 1 zat.'}
        {tamper === 'phantom' && `Tampered: slot ${valid.length}, which must be empty, now holds a commitment.`}
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
        This page checks the record against itself. Only the audit (<code>pnpm --filter @sba/service audit</code>) re-reads the deposits from the chain.
      </p>
    </section>
  );
}

/* ---------- settlement ---------- */
function Provenance() {
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
        <li>
          An altered reveal (a bidder claiming a different bid with its real salt) was refused: <b>{r.alteredReveal.reason}</b>.
        </li>
        <li>
          Valid deposits declared unrevealed: <b>{(r.outcome.unrevealed ?? []).length}</b>.
        </li>
      </ul>
    </section>
  );
}

function Audit() {
  return (
    <section className="block" aria-labelledby="audit-title">
      <div className="block-head">
        <div>
          <span className="eyebrow">Audit</span>
          <h2 id="audit-title">Re-read it from the chain</h2>
        </div>
      </div>
      <ol className="howto">
        <li>
          <code>pnpm --filter @sba/service audit</code> scans the auction&apos;s blocks with its incoming viewing key, so a deposit left out of the record shows up.
        </li>
        <li>It re-applies the rules to what the chain shows: late, duplicate, wrong amount, memo mismatch.</li>
        <li>It verifies the proof and ties it to those deposits, the same checks this page runs.</li>
      </ol>
      <details className="key">
        <summary>Auction incoming viewing key</summary>
        <code>{r.auction.uivk}</code>
        <p>Reads deposits to the auction address: amounts and commitment memos. It cannot spend, and it never shows a bid.</p>
      </details>
    </section>
  );
}

export function App() {
  const t = r.blockTimes;
  return (
    <div className="page">
      <a className="skip" href="#main">
        Skip to the saleroom
      </a>
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
            <a href={REPO} target="_blank" rel="noreferrer">
              Code ↗
            </a>
          </nav>
        </div>
      </header>

      <main id="main" className="main">
        <section className="sale" aria-labelledby="sale-title">
          <div className="sale-meta">
            <span className="lotno">SALE 001</span>
            <code>{r.auction.name}</code>
          </div>
          <div className="sale-grid">
            <div>
              <h1 id="sale-title">
                <span>Hammer price</span>
                {taz(r.outcome.winningBidZat)}
              </h1>
              <p className="sale-lede">
                {valid.length} sealed bids, each an equal {taz(r.auction.depositZat)} shielded deposit. The proof opened the highest one; the other {valid.length - 1} are never
                published.
              </p>
            </div>
            <Clock />
          </div>
          <ol className="timeline" aria-label="Auction timeline">
            <li>
              <span>Open</span>
              <b>{t.open.height.toLocaleString('en-US')}</b>
              <small>{utc(t.open.time)} UTC</small>
            </li>
            <li>
              <span>Close</span>
              <b>{t.close.height.toLocaleString('en-US')}</b>
              <small>{utc(t.close.time)} UTC</small>
            </li>
            <li>
              <span>Hammer</span>
              <b>{t.settlement.height.toLocaleString('en-US')}</b>
              <small>{utc(t.settlement.time)} UTC</small>
            </li>
            <li>
              <span>Reserve</span>
              <b>{taz(r.auction.reserveZat)}</b>
              <small>met</small>
            </li>
          </ol>
        </section>

        <div className="layout">
          <div className="col">
            <Catalogue />
            <Provenance />
            <Audit />
          </div>
          <aside className="side">
            <Verify />
          </aside>
        </div>
      </main>
      <footer className="foot">
        MIT · Copyright (c) 2026 Nivesh Gajengi · the auctioneer learns every bid at the reveal; the public learns only the winner&apos;s
      </footer>
    </div>
  );
}
