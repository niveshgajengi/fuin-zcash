import { useEffect, useState } from 'react';
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
const taz = (z: string | number) => `${(Number(z) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 6 })} TAZ`;
const short = (s: string, a = 8, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const valid = r.deposits.filter((d) => d.status === 'valid');
const winner = valid[r.outcome.winnerSlot];
const commitmentOf = (d: Deposit) => d.memo.split(':')[2] ?? '';

/** The commitment's first bytes as a colour, so each seal is visibly distinct. */
function sealHue(c: string): number {
  let h = 0;
  for (const ch of c.slice(0, 12)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function Envelope({ d, open }: { d: Deposit; open: boolean }) {
  const c = commitmentOf(d);
  return (
    <li className={`env ${open ? 'env-open' : ''} ${d.status !== 'valid' ? 'env-out' : ''}`}>
      <div className="flap" aria-hidden="true" />
      <div className="seal" style={{ ['--hue' as string]: c ? sealHue(c) : 0 }} aria-hidden="true">
        {d.status === 'valid' ? '' : '×'}
      </div>
      <div className="env-body">
        {open ? (
          <p className="env-bid">
            {taz(r.outcome.winningBidZat)}
            <span>winning bid, opened by the proof</span>
          </p>
        ) : d.status === 'valid' ? (
          <p className="env-sealed">Sealed. The bid inside is never published.</p>
        ) : (
          <p className="env-reject">
            Not a bid: <strong>{d.status.replace('_', ' ')}</strong>
            {d.reason && <span>{d.reason}</span>}
          </p>
        )}
        <p className="env-meta">
          {taz(d.valueZat)} deposit · block {d.height ?? 'pending'} ·{' '}
          <a href={EXPLORER + d.txid} target="_blank" rel="noreferrer">
            <code>{short(d.txid)}</code>
          </a>
        </p>
        {c && <p className="env-c" title={c}>commitment <code>{short(c, 10, 6)}</code></p>}
      </div>
    </li>
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
    <div className="verify" aria-live="polite">
      <p className={`verdict v-${state}`}>
        {state === 'checking' && 'Checking the Groth16 proof in this tab…'}
        {state === 'ok' && 'The proof verifies: the opened envelope holds the highest bid, at or above the reserve.'}
        {state === 'bad' && 'The proof does not verify for these numbers.'}
        {state === 'error' && `Could not verify: ${detail}`}
      </p>
      {(state === 'ok' || state === 'bad') && <p className="muted small">{tampered ? 'Tampered input: ' : 'Checked: '}{detail}</p>}
      <div className="row">
        <button onClick={() => void check(false)} disabled={state === 'checking'}>
          Verify the published result
        </button>
        <button className="ghost" onClick={() => void check(true)} disabled={state === 'checking'}>
          Try claiming a higher winning bid
        </button>
      </div>
    </div>
  );
}

export function App() {
  return (
    <>
      <header className="top">
        <span className="brand">Sealed-Bid Auction</span>
        <span className="muted small">Zcash testnet · {r.auction.name}</span>
      </header>
      <main>
        <section className="hero" aria-labelledby="t">
          <h1 id="t">{valid.length} sealed bids. One opened. The others stay sealed for good.</h1>
          <p className="lede">
            Every bidder sent the same {taz(r.auction.depositZat)} shielded deposit, its memo a Poseidon commitment to the bid. After the close, a Groth16 proof showed which
            commitment holds the highest bid, so only the winning bid is ever published.
          </p>
          <ul className="envelopes">
            {r.deposits.map((d) => (
              <Envelope key={d.txid} d={d} open={d.txid === winner?.txid} />
            ))}
          </ul>
          <Verify />
        </section>

        <section aria-labelledby="settle">
          <h2 id="settle">Settlement, checked by each recipient&apos;s viewing key</h2>
          <p className="muted">
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
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {r.settlement.viewingKeyChecks.map((c) => (
                  <tr key={c.recipient}>
                    <td>{c.recipient}</td>
                    <td>{c.expected.split('+').map((x) => taz(x)).join(' + ')}</td>
                    <td>{c.seen.map((x) => taz(x)).join(' + ')}</td>
                    <td>{c.ok ? <span className="ok">match</span> : <span className="bad">mismatch</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Every deposit and the settlement have only an Ironwood bundle (no transparent part): {r.ironwoodOnly ? 'yes' : 'no'}. An altered reveal (a bidder claiming a
            different amount with its salt) was refused: {r.alteredReveal.reason}.
          </p>
        </section>

        <section aria-labelledby="audit">
          <h2 id="audit">Audit it yourself</h2>
          <ol className="steps">
            <li>
              Decrypt the deposits with the auction&apos;s incoming viewing key: <code>SBA_UIVK=&lt;key&gt; sba-verify tx &lt;txid&gt;…</code>. It shows each deposit&apos;s
              amount and commitment memo, never a bid.
            </li>
            <li>Check that the proof&apos;s public commitments are exactly the valid deposits&apos; memos, in deposit order.</li>
            <li>
              Verify the proof with the verification key (sha256 <code>{short(r.verificationKeySha256, 10, 6)}</code>), as this page does.
            </li>
          </ol>
          <details>
            <summary>Auction incoming viewing key</summary>
            <p>
              <code className="key">{r.auction.uivk}</code>
            </p>
            <p className="muted small">It can read deposits to the auction address. It cannot spend, and it cannot see bids, only commitments.</p>
          </details>
        </section>
      </main>
      <footer>MIT · Copyright (c) 2026 Nivesh Gajengi · the auctioneer learns every bid at the reveal; the public learns only the winner&apos;s</footer>
    </>
  );
}
