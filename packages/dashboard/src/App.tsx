import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import * as snarkjs from 'snarkjs';
import run from '@deployments/testnet.json';

type Deposit = { txid: string; height: number | null; valueZat: string; memo: string; status: string; reason: string | null; label?: string };
const r = run as unknown as {
  auction: { name: string; auctionId: string; address: string; uivk: string; depositZat: string; reserveZat: string; closeHeight: number };
  deposits: Deposit[];
  alteredReveal: { rejected: boolean; reason: string };
  outcome: { winnerSlot: number; winningBidZat: string; reserveZat: string; commitments: string[]; proof: object; publicSignals: string[]; proofVerifies: boolean; slotsMatchDeposits: boolean };
  settlement: { txid: string; height: number; outputs: { amountZat: string; why: string; recipient: string }[]; viewingKeyChecks: { recipient: string; expected: string; seen: number[]; ok: boolean }[] };
  ironwoodOnly: boolean;
  verificationKeySha256: string;
};

const EXPLORER = 'https://testnet.zcashexplorer.app/transactions/';
const REPO = 'https://github.com/nickthelegend/zec-sealed-bid-auction';
const taz = (z: string | number) => `${(Number(z) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 6 })} TAZ`;
const short = (s: string, a = 8, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const valid = r.deposits.filter((d) => d.status === 'valid');
const refused = r.deposits.length - valid.length;
const winner = valid[r.outcome.winnerSlot];
const commitmentOf = (d: Deposit) => d.memo.split(':')[2] ?? '';
const matched = r.settlement.viewingKeyChecks.filter((c) => c.ok).length;

/** The commitment's first bytes as a colour, so each sealed deposit is visibly distinct. */
function sealHue(c: string): number {
  let h = 0;
  for (const ch of c.slice(0, 12)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Balance-style amount: whole part bright, decimals and unit faded. Formatting comes from `taz`. */
function Amount({ zat, className = '' }: { zat: string | number; className?: string }) {
  const s = taz(zat);
  const m = s.match(/^(.*?)([.,]\d+)? (TAZ)$/);
  return (
    <span className={`amount ${className}`}>
      {m ? (
        <>
          {m[1]}
          {m[2] && <span className="amount-dec">{m[2]}</span>}
          <span className="amount-unit"> {m[3]}</span>
        </>
      ) : (
        s
      )}
    </span>
  );
}

type Variant = 'sealed' | 'opened' | 'refused';
const PILL: Record<Variant, string> = { sealed: 'Sealed', opened: 'Opened · winner', refused: 'Refused' };

function Icon({ name }: { name: Variant | 'mark' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="icon">
      {name === 'sealed' && (
        <>
          <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
        </>
      )}
      {name === 'opened' && (
        <>
          <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" />
        </>
      )}
      {name === 'refused' && (
        <>
          <circle cx="12" cy="12" r="7.5" />
          <path d="M6.8 17.2 17.2 6.8" />
        </>
      )}
      {name === 'mark' && (
        <>
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1.4" className="icon-fill" />
        </>
      )}
    </svg>
  );
}

/** The Fuin mark: a flat, modern seal. */
function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="logo-mark">
      <circle cx="16" cy="16" r="15" fill="#ff5a5f" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="#1a0b0f" strokeWidth="2" />
      <circle cx="16" cy="16" r="3" fill="#1a0b0f" />
    </svg>
  );
}

function Lot({ d, open, index }: { d: Deposit; open: boolean; index: number }) {
  const c = commitmentOf(d);
  const variant: Variant = open ? 'opened' : d.status === 'valid' ? 'sealed' : 'refused';
  return (
    <li className={`tile tile-${variant}`} style={{ ['--i' as string]: index } as CSSProperties}>
      <div className="tile-top">
        <span className={`glyph glyph-${variant}`}>
          <Icon name={variant} />
        </span>
        <span className={`pill pill-${variant}`}>{PILL[variant]}</span>
      </div>
      <p className="tile-no">Deposit {String(index + 1).padStart(2, '0')}</p>
      <div className="tile-body">
        {open ? (
          <p className="tile-bid">
            <Amount zat={r.outcome.winningBidZat} />
            <span className="tile-caption">winning bid, opened by the proof</span>
          </p>
        ) : d.status === 'valid' ? (
          <p className="tile-sealed">Sealed. The bid inside is never published.</p>
        ) : (
          <p className="tile-reject">
            Not a bid: <strong>{d.status.replace('_', ' ')}</strong>
            {d.reason && <span>{d.reason}</span>}
          </p>
        )}
      </div>
      <dl className="kv">
        <div>
          <dt>Deposit</dt>
          <dd>{taz(d.valueZat)}</dd>
        </div>
        <div>
          <dt>Block</dt>
          <dd className="tnum">{d.height ?? 'pending'}</dd>
        </div>
        <div>
          <dt>Transaction</dt>
          <dd>
            <a href={EXPLORER + d.txid} target="_blank" rel="noreferrer" aria-label={`Transaction ${d.txid} on the explorer`}>
              <code>{short(d.txid)}</code> <span aria-hidden="true">↗</span>
            </a>
          </dd>
        </div>
        {c && (
          <div>
            <dt>Commitment</dt>
            <dd title={c}>
              <span className="hue-dot" style={{ ['--hue' as string]: sealHue(c) } as CSSProperties} aria-hidden="true" />
              <code>{short(c, 10, 6)}</code>
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

function StateIcon({ state }: { state: 'idle' | 'checking' | 'ok' | 'bad' | 'error' }) {
  if (state === 'checking') return <span className="spinner" aria-hidden="true" />;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="icon">
      {state === 'ok' && <path d="M5.5 12.5 10 17l8.5-9.5" />}
      {(state === 'bad' || state === 'error') && <path d="M7.5 7.5l9 9M16.5 7.5l-9 9" />}
      {state === 'idle' && <circle cx="12" cy="12" r="4" />}
    </svg>
  );
}

function Verify() {
  const [state, setState] = useState<'idle' | 'checking' | 'ok' | 'bad' | 'error'>('idle');
  const [tampered, setTampered] = useState(false);
  const [detail, setDetail] = useState('');
  async function check(tamper: boolean) {
    setState('checking');
    setTampered(tamper);
    try {
      const vk = await (await fetch('/verification_key.json')).json();
      const signals = [...r.outcome.publicSignals];
      if (tamper) signals[signals.length - 1] = String(BigInt(signals[signals.length - 1]) + 1n);
      const ok = await snarkjs.groth16.verify(vk, signals, r.outcome.proof);
      setState(ok ? 'ok' : 'bad');
      setDetail(tamper ? `winning bid changed from ${Number(r.outcome.winningBidZat).toLocaleString()} to ${Number(signals[signals.length - 1]).toLocaleString()} zat` : `${r.outcome.commitments.length} commitments, reserve ${taz(r.outcome.reserveZat)}`);
    } catch (e) {
      setState('error');
      setDetail((e as Error).message);
    }
  }
  useEffect(() => {
    void check(false);
  }, []);
  return (
    <section id="verify" className={`panel verify verify-${state}`} aria-labelledby="verify-title">
      <div className="panel-head">
        <h2 id="verify-title">Verify the proof</h2>
        <span className="pill pill-quiet">Groth16 · MaxBid</span>
      </div>
      <p className="muted small">Runs in this tab with snarkjs against the published verification key.</p>
      <div className="verdict-box" aria-live="polite">
        <span className="verdict-icon">
          <StateIcon state={state} />
        </span>
        <div className="verdict-text">
          <p className={`verdict v-${state}`}>
            {state === 'idle' && 'Not checked yet.'}
            {state === 'checking' && 'Checking the Groth16 proof in this tab…'}
            {state === 'ok' && 'The proof verifies: the opened envelope holds the highest bid, at or above the reserve.'}
            {state === 'bad' && 'The proof does not verify for these numbers.'}
            {state === 'error' && `Could not verify: ${detail}`}
          </p>
          {(state === 'ok' || state === 'bad') && (
            <p className="verdict-detail">
              {tampered ? 'Tampered input: ' : 'Checked: '}
              {detail}
            </p>
          )}
        </div>
      </div>
      <div className="actions">
        <button className="btn btn-coral" onClick={() => void check(false)} disabled={state === 'checking'}>
          Verify the published result
        </button>
        <button className="btn btn-dark" onClick={() => void check(true)} disabled={state === 'checking'}>
          Try claiming a higher winning bid
        </button>
      </div>
      <p className="vk-line">
        <span>Verification key sha256</span>
        <code title={r.verificationKeySha256}>{short(r.verificationKeySha256, 10, 6)}</code>
      </p>
    </section>
  );
}

function Tile({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <li className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{children}</span>
      {note && <span className="stat-note">{note}</span>}
    </li>
  );
}

const NAV = [
  ['#overview', 'Overview'],
  ['#deposits', 'Deposits'],
  ['#verify', 'Verify'],
  ['#settlement', 'Settlement'],
  ['#audit', 'Audit'],
] as const;

export function App() {
  return (
    <div className="page">
      <div className="frame">
        <header className="nav">
          <a className="brand" href="#overview" aria-label="Fuin, overview">
            <Logo />
            <span className="brand-word">Fuin</span>
          </a>
          <nav className="nav-links" aria-label="Sections">
            {NAV.map(([href, label], i) => (
              <a key={href} href={href} className={i === 0 ? 'is-active' : undefined}>
                {label}
              </a>
            ))}
          </nav>
          <div className="nav-right">
            <span className="pill pill-net">
              <span className="net-dot" aria-hidden="true" />
              Zcash testnet
            </span>
            <a className="btn btn-coral btn-sm" href={REPO} target="_blank" rel="noreferrer">
              GitHub <span aria-hidden="true">↗</span>
            </a>
          </div>
        </header>

        <div className="layout">
          <main className="main">
            <section id="overview" className="overview" aria-labelledby="t">
              <div className="title-row">
                <span className="glyph-pair" aria-hidden="true">
                  <span className="glyph glyph-coral">
                    <Icon name="mark" />
                  </span>
                  <span className="glyph glyph-zec">Z</span>
                </span>
                <span className="title-text">
                  Auction
                  <code>{r.auction.name}</code>
                </span>
              </div>

              <h1 id="t">{valid.length} sealed bids. One opened. The others stay sealed for good.</h1>
              <p className="lede">
                Every bidder sent the same {taz(r.auction.depositZat)} shielded deposit, its memo a Poseidon commitment to the bid. After the close, a Groth16 proof showed which
                commitment holds the highest bid, so only the winning bid is ever published.
              </p>

              <div className="balance">
                <span className="balance-label">Winning bid</span>
                <div className="balance-row">
                  <Amount zat={r.outcome.winningBidZat} className="amount-xl" />
                  <span className="pill pill-opened">Opened by the proof</span>
                </div>
              </div>

              <ul className="stats" aria-label="Auction at a glance">
                <Tile label="Valid sealed bids" note={`of ${r.deposits.length} deposits`}>
                  {valid.length}
                </Tile>
                <Tile label="Refused deposits" note="not counted as bids">
                  {refused}
                </Tile>
                <Tile
                  label="Settlement block"
                  note={
                    <a href={EXPLORER + r.settlement.txid} target="_blank" rel="noreferrer">
                      <code>{short(r.settlement.txid)}</code> ↗
                    </a>
                  }
                >
                  <span className="tnum">{r.settlement.height}</span>
                </Tile>
                <Tile label="Closed at block">
                  <span className="tnum">{r.auction.closeHeight}</span>
                </Tile>
              </ul>
            </section>

            <section id="deposits" className="block" aria-labelledby="lots">
              <div className="block-head">
                <h2 id="lots">Deposits</h2>
                <ul className="legend" aria-label="Counts">
                  <li>
                    <span className="pill pill-opened">Opened {winner ? 1 : 0}</span>
                  </li>
                  <li>
                    <span className="pill pill-sealed">Sealed {valid.length - (winner ? 1 : 0)}</span>
                  </li>
                  <li>
                    <span className="pill pill-refused">Refused {refused}</span>
                  </li>
                </ul>
              </div>
              <p className="muted block-sub">Every deposit to the auction address. Only the winner&apos;s bid is ever shown.</p>
              <ul className="tiles">
                {r.deposits.map((d, i) => (
                  <Lot key={d.txid} d={d} index={i} open={d.txid === winner?.txid} />
                ))}
              </ul>
            </section>

            <section id="settlement" className="block" aria-labelledby="settle">
              <div className="block-head">
                <h2 id="settle">Settlement, checked by each recipient&apos;s viewing key</h2>
              </div>
              <p className="muted block-sub">
                One shielded transaction (
                <a href={EXPLORER + r.settlement.txid} target="_blank" rel="noreferrer">
                  <code>{short(r.settlement.txid)}</code>
                </a>
                , block {r.settlement.height}) paid the seller and refunded every other revealed deposit. Each recipient decrypted only its own outputs.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Recipient</th>
                      <th scope="col">Expected</th>
                      <th scope="col">Decrypted with its key</th>
                      <th scope="col" className="right">
                        Result
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.settlement.viewingKeyChecks.map((c) => (
                      <tr key={c.recipient}>
                        <td className="recipient">{c.recipient}</td>
                        <td className="tnum">{c.expected.split('+').map((x) => taz(x)).join(' + ')}</td>
                        <td className="tnum">{c.seen.map((x) => taz(x)).join(' + ')}</td>
                        <td className="right">{c.ok ? <span className="pill pill-ok">match</span> : <span className="pill pill-bad">mismatch</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="notes">
                <li>
                  <span className={`note-dot ${r.ironwoodOnly ? 'note-yes' : 'note-no'}`} aria-hidden="true" />
                  <span>
                    Every deposit and the settlement have only an Ironwood bundle (no transparent part): <strong>{r.ironwoodOnly ? 'yes' : 'no'}</strong>.
                  </span>
                </li>
                <li>
                  <span className="note-dot note-yes" aria-hidden="true" />
                  <span>
                    An altered reveal (a bidder claiming a different amount with its salt) was refused: <strong>{r.alteredReveal.reason}</strong>.
                  </span>
                </li>
              </ul>
            </section>

            <section id="audit" className="block" aria-labelledby="audit-title">
              <div className="block-head">
                <h2 id="audit-title">Audit it yourself</h2>
              </div>
              <ol className="steps">
                <li>
                  <span>
                    Decrypt the deposits with the auction&apos;s incoming viewing key: <code>SBA_UIVK=&lt;key&gt; sba-verify tx &lt;txid&gt;…</code>. It shows each
                    deposit&apos;s amount and commitment memo, never a bid.
                  </span>
                </li>
                <li>
                  <span>Check that the proof&apos;s public commitments are exactly the valid deposits&apos; memos, in deposit order.</span>
                </li>
                <li>
                  <span>
                    Verify the proof with the verification key (sha256 <code>{short(r.verificationKeySha256, 10, 6)}</code>), as this page does.
                  </span>
                </li>
              </ol>
              <details className="key-details">
                <summary>Auction incoming viewing key</summary>
                <p>
                  <code className="key">{r.auction.uivk}</code>
                </p>
                <p className="muted small">It can read deposits to the auction address. It cannot spend, and it cannot see bids, only commitments.</p>
              </details>
            </section>
          </main>

          <aside className="side">
            <Verify />
            <section className="panel panel-outline" aria-labelledby="terms">
              <h2 id="terms" className="panel-label">
                Auction terms
              </h2>
              <Amount zat={r.auction.depositZat} className="amount-lg" />
              <p className="muted small terms-sub">equal shielded deposit per bid</p>
              <dl className="terms">
                <div>
                  <dt>Reserve</dt>
                  <dd>{taz(r.auction.reserveZat)}</dd>
                </div>
                <div>
                  <dt>Close</dt>
                  <dd className="tnum">{r.auction.closeHeight}</dd>
                </div>
                <div>
                  <dt>Keys match</dt>
                  <dd className="tnum">
                    {matched} / {r.settlement.viewingKeyChecks.length}
                  </dd>
                </div>
              </dl>
            </section>
          </aside>
        </div>
      </div>
      <footer className="footer">MIT · Copyright (c) 2026 Nivesh Gajengi · the auctioneer learns every bid at the reveal; the public learns only the winner&apos;s</footer>
    </div>
  );
}
