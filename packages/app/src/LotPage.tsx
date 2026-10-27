import { useCallback, useEffect, useMemo, useState } from 'react';
import * as snarkjs from 'snarkjs';
import { checkResult } from '@sba/circuits/result';
import { emptyCommitment } from '@sba/circuits/poseidon';
import { api, EXPLORER, fate, num, short, taz, type Job, type Lot, type Opening } from './data';
import { refresh, setWallet, useJob, useStore } from './store';
import { ART, CountdownTiles, Empty, LotRow, PhasePill, SealAvatar, SetupRequired } from './ui';

const VK_URL = `${import.meta.env.BASE_URL}verification_key.json`;

export function LotPage({ lot, lots }: { lot: Lot; lots: Lot[] }) {
  const s = useStore();
  const tip = s.health?.tip ?? 0;
  const [tab, setTab] = useState<'about' | 'bids' | 'reveals' | 'proof' | 'terms'>(lot.phase === 'settled' ? 'proof' : 'bids');
  const valid = lot.bids.filter((b) => b.status === 'valid');
  const to = lot.phase === 'bidding' ? lot.card.closeHeight : lot.phase === 'reveal' ? lot.card.revealCloseHeight ?? null : null;
  return (
    <div className="lot-page">
      <nav className="crumbs mono" aria-label="Breadcrumb">
        <a href="#/">floor</a> <span>/</span> <span>lot {lot.sale}</span> <span>/</span> <span className="faint">{lot.source === 'node' ? 'live on your node' : 'published record'}</span>
      </nav>
      <section className="lp-top">
        <div className="lp-art">
          <img src={ART(lot.meta.art)} alt="" />
          <div className="lp-art-top">
            <PhasePill phase={lot.phase} />
            <span className="lc-no">lot {lot.sale}</span>
          </div>
          {lot.phase === 'settled' && <div className={`lp-stamp${lot.winner ? '' : ' none'}`}>{lot.winner ? 'opened' : 'no sale'}</div>}
        </div>
        <div className="lp-info">
          <h1>{lot.meta.title.toLowerCase()}</h1>
          {lot.meta.blurb && <p className="lp-blurb">{lot.meta.blurb}</p>}
          <div className="seller">
            <img src={`${import.meta.env.BASE_URL}brand/mark-512.png`} alt="" />
            <span>
              <small>house</small>
              <b>{lot.source === 'node' ? 'this Fuin node' : 'Fuin testnet house'}</b>
            </span>
            <span>
              <small>chain</small>
              <b>Zcash testnet · shielded</b>
            </span>
            <span className="hide-sm">
              <small>auction id</small>
              <b className="mono">{short(lot.card.auctionId, 6, 4)}</b>
            </span>
          </div>
          <div className={`auction-card ph-${lot.phase}`}>
            <div className="ac-head">
              <span>sealed auction</span>
              <span className="mono">{lot.phase === 'bidding' ? 'bidding open' : lot.phase === 'reveal' ? 'reveal window' : lot.phase === 'settled' ? 'hammered' : 'awaiting hammer'}</span>
            </div>
            {to && tip > 0 ? (
              <CountdownTiles to={to} tip={tip} label={lot.phase === 'bidding' ? 'bidding closes in' : 'reveals close in'} />
            ) : (
              <div className="ac-result">
                <span className="k">{lot.winner ? 'winning bid · opened' : lot.noSale ? 'result' : 'status'}</span>
                <b className={lot.winner ? 'gold' : ''}>{lot.winner ? `${taz(lot.winner.bidZat)} TAZ` : lot.noSale ? 'no sale' : 'reveals closed'}</b>
              </div>
            )}
            <div className="ac-stats">
              <Chip k="equal deposit" v={`${taz(lot.card.depositZat)} TAZ`} />
              <Chip k="reserve" v={`${taz(lot.card.reserveZat)} TAZ`} />
              <Chip k="sealed bids" v={String(valid.length)} />
              <Chip k={lot.winner ? 'winning bid' : 'top bid'} v={lot.winner ? `${taz(lot.winner.bidZat)} TAZ` : lot.noSale ? 'no sale' : 'sealed'} gold={!!lot.winner} />
            </div>
            <ActionSheet lot={lot} tip={tip} />
          </div>
          <LotJobs lot={lot} />
          <MySeal lot={lot} />
        </div>
      </section>

      <Rail lot={lot} tip={tip} />

      {lot.phase === 'settled' && <Hammer lot={lot} />}

      <div className="tabs" role="tablist">
        {(
          [
            ['bids', `sealed bids · ${lot.bids.length}`],
            ['reveals', `reveal notes · ${lot.reveals.length}`],
            ...(lot.record ? [['proof', 'proof']] : []),
            ['terms', 'terms'],
            ['about', 'about this lot'],
          ] as [typeof tab, string][]
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'bids' && <Bids lot={lot} />}
      {tab === 'reveals' && <Reveals lot={lot} />}
      {tab === 'proof' && lot.record && <Proof lot={lot} />}
      {tab === 'terms' && <Terms lot={lot} />}
      {tab === 'about' && (
        <div className="about">
          <p>{lot.meta.blurb || 'A lot on Fuin.'}</p>
          <p className="faint">Lot art is illustrative. Everything else on this page, every deposit, reveal note, proof and payout, is read from Zcash testnet or from the record the house published.</p>
        </div>
      )}

      <section className="more">
        <div className="shelf-head">
          <h2>more lots</h2>
          <a className="btn ghost sm" href="#/">
            all lots
          </a>
        </div>
        <div className="rows">
          {lots
            .filter((l) => l.sale !== lot.sale)
            .slice(0, 6)
            .map((l) => (
              <LotRow key={l.sale} lot={l} tip={tip} />
            ))}
        </div>
      </section>
    </div>
  );
}

function Chip({ k, v, gold = false }: { k: string; v: string; gold?: boolean }) {
  return (
    <div className="chip">
      <span className="k">{k}</span>
      <span className={`v${gold ? ' gold' : ''}${v === 'sealed' ? ' sealed' : ''}`}>{v}</span>
    </div>
  );
}

function Rail({ lot, tip }: { lot: Lot; tip: number }) {
  const c = lot.card;
  const steps = [
    { k: 'open', label: 'listed', at: c.openHeight },
    { k: 'close', label: 'bids close', at: c.closeHeight },
    ...(c.revealCloseHeight ? [{ k: 'reveal', label: 'reveals close', at: c.revealCloseHeight }] : []),
    { k: 'settle', label: 'hammer', at: lot.record?.settlement?.height ?? null },
  ];
  const doneIdx = lot.phase === 'settled' ? steps.length : lot.phase === 'bidding' ? 1 : lot.phase === 'reveal' ? 2 : 3;
  const span = (c.revealCloseHeight ?? c.closeHeight) - c.openHeight;
  const pct = lot.phase === 'settled' ? 100 : Math.max(2, Math.min(100, ((tip - c.openHeight) / span) * 100));
  return (
    <div className="rail">
      <div className="rail-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <ol>
        {steps.map((st, i) => (
          <li key={st.k} className={i < doneIdx ? 'done' : i === doneIdx ? 'now' : ''}>
            <span className="rl">{st.label}</span>
            <span className="rb mono">{st.at ? `block ${num(st.at)}` : '—'}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Hammer({ lot }: { lot: Lot }) {
  const r = lot.record!;
  const unrevealed = r.outcome?.unrevealed ?? [];
  const sealedForever = lot.bids.filter((b) => b.status === 'valid' && b.ref !== lot.winner?.ref && !unrevealed.includes(b.ref)).length;
  return (
    <section className="hammer">
      <div className="hm-art">
        <img src={`${import.meta.env.BASE_URL}brand/opened.webp`} alt="" onError={(e) => ((e.target as HTMLImageElement).src = ART('envelope'))} />
      </div>
      <div className="hm-body">
        <div className="hm-eyebrow mono">hammer · block {num(r.settlement!.height)}</div>
        {lot.winner ? (
          <>
            <div className="hm-amount">
              {taz(lot.winner.bidZat)} <span>TAZ</span>
            </div>
            <p>The only bid ever opened. A zero-knowledge proof shows it beat every other sealed bid, without opening them.</p>
          </>
        ) : (
          <>
            <div className="hm-amount">no sale</div>
            <p>{lot.noSale?.detail}</p>
          </>
        )}
        <div className="hm-row">
          <div>
            <b>{sealedForever}</b> losing bid{sealedForever === 1 ? '' : 's'} sealed forever
          </div>
          {unrevealed.length > 0 && (
            <div>
              <b>{unrevealed.length}</b> unrevealed, forfeited to the seller
            </div>
          )}
          <div>
            <b>{r.settlement!.outputs.length}</b> payouts in one shielded tx
          </div>
          <a className="mono" href={`${EXPLORER}${r.settlement!.txid}`} target="_blank" rel="noreferrer">
            {short(r.settlement!.txid, 8, 6)} ↗
          </a>
        </div>
      </div>
    </section>
  );
}

const STATUS: Record<string, string> = { valid: 'sealed', late: 'late', pending: 'pending', wrong_amount: 'wrong amount', memo_mismatch: 'not a bid', duplicate: 'duplicate', over_capacity: 'over capacity' };
function Bids({ lot }: { lot: Lot }) {
  const unrevealed = lot.record?.outcome?.unrevealed ?? [];
  if (lot.bids.length === 0 && lot.pending.length === 0)
    return (
      <Empty title="no sealed bids yet" art="envelope">
        Every bid lands here as an equal deposit with a sealed commitment. Nobody, not even the house, can read the amount until the reveal.
      </Empty>
    );
  return (
    <div className="table" role="table">
      <div className="tr th" role="row">
        <span>bid</span>
        <span>block</span>
        <span className="hide-sm">deposit</span>
        <span>amount</span>
      </div>
      {lot.pending
        .filter((p) => p.kind === 'bid')
        .map((p) => (
          <div className="tr pending" role="row" key={p.txid}>
            <span className="who">
              <span className="pulse" />
              <a className="mono" href={`${EXPLORER}${p.txid}`} target="_blank" rel="noreferrer">
                {short(p.txid, 8, 4)} ↗
              </a>
            </span>
            <span className="mono faint">in mempool</span>
            <span className="hide-sm mono">{taz(lot.card.depositZat)}</span>
            <span className="sealed-bar">landing…</span>
          </div>
        ))}
      {lot.bids.map((b) => {
        const won = lot.winner?.ref === b.ref;
        const forfeit = unrevealed.includes(b.ref);
        return (
          <div className={`tr${won ? ' won' : ''}`} role="row" key={b.ref}>
            <span className="who">
              <SealAvatar seed={b.commitment ?? b.ref} size={28} open={won} />
              <span>
                <a className="mono" href={`${EXPLORER}${b.txid}`} target="_blank" rel="noreferrer">
                  {short(b.ref, 8, b.ref.length > 64 ? 3 : 4)} ↗
                </a>
                <small className="mono faint">{b.commitment ? `commitment ${short(b.commitment, 6, 4)}` : 'no commitment'}</small>
              </span>
            </span>
            <span className="mono">{b.height ? num(b.height) : '—'}</span>
            <span className="hide-sm mono">{taz(b.valueZat)}</span>
            <span>
              {won ? (
                <span className="opened">opened · {taz(lot.winner!.bidZat)}</span>
              ) : b.status !== 'valid' ? (
                <span className="refused">{STATUS[b.status] ?? b.status}</span>
              ) : forfeit ? (
                <span className="refused">never revealed · forfeited</span>
              ) : (
                <span className="sealed-bar" title="The amount is inside a Poseidon commitment; it is never published">
                  <i />
                  <i />
                  <i />
                  <i />
                  sealed
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Reveals({ lot }: { lot: Lot }) {
  if (lot.reveals.length === 0)
    return (
      <Empty title="no reveal notes yet" art="key">
        After bidding closes, each bidder sends a second shielded note: its bid, sealed to the house's key. The chain timestamps it; only the house can open it.
      </Empty>
    );
  return (
    <div className="table" role="table">
      <div className="tr th" role="row">
        <span>reveal note</span>
        <span>block</span>
        <span className="hide-sm">names deposit</span>
        <span>status</span>
      </div>
      {lot.reveals.map((r) => (
        <div className="tr" role="row" key={r.txid}>
          <span className="who">
            <span className="env">✉</span>
            <a className="mono" href={`${EXPLORER}${r.txid}`} target="_blank" rel="noreferrer">
              {short(r.txid, 8, 4)} ↗
            </a>
          </span>
          <span className="mono">{r.height ? num(r.height) : '—'}</span>
          <span className="hide-sm mono">{r.deposit ? short(r.deposit, 8, 4) : '—'}</span>
          <span className={r.status === 'accepted' ? 'ok' : r.late || (r.status && r.status !== 'accepted') ? 'refused' : 'sealed-txt'}>{r.status ? r.status.replace('_', ' ') : r.late ? 'late' : 'sealed to the house'}</span>
        </div>
      ))}
    </div>
  );
}

function Terms({ lot }: { lot: Lot }) {
  const c = lot.card;
  const rows: [string, string][] = [
    ['auction id', c.auctionId],
    ['name', c.name],
    ['equal deposit', `${num(Number(c.depositZat))} zat`],
    ['reserve', `${num(Number(c.reserveZat))} zat`],
    ['opens at block', num(c.openHeight)],
    ['bids close after block', num(c.closeHeight)],
    ...(c.revealCloseHeight ? ([['reveals close after block', num(c.revealCloseHeight)]] as [string, string][]) : []),
    ['auction address', c.address],
    ['incoming viewing key (public)', c.uivk],
    ...(c.revealKey ? ([['house reveal key (X25519)', c.revealKey]] as [string, string][]) : []),
  ];
  return (
    <dl className="terms">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="mono">{v}</dd>
        </div>
      ))}
      <p className="faint">The auction id is a hash of every term above, so none of them can change after the first bid.</p>
    </dl>
  );
}

type StepState = 'wait' | 'run' | 'ok' | 'bad';
function Proof({ lot }: { lot: Lot }) {
  const r = lot.record!;
  const [steps, setSteps] = useState<{ k: string; label: string; st: StepState; d: string }[]>([]);
  const [tamper, setTamper] = useState(false);
  const run = useCallback(
    async (t: boolean) => {
      setTamper(t);
      const init = [
        { k: 'vk', label: 'verification key matches the record', st: 'wait' as StepState, d: '' },
        { k: 'proof', label: 'Groth16 proof verifies', st: 'wait' as StepState, d: '' },
        { k: 'slots', label: 'proof covers exactly the on-chain deposits', st: 'wait' as StepState, d: '' },
        { k: 'winner', label: 'winner is a real deposit', st: 'wait' as StepState, d: '' },
      ];
      setSteps(init);
      const upd = (k: string, st: StepState, d: string) => setSteps((s) => s.map((x) => (x.k === k ? { ...x, st, d } : x)));
      if (!r.outcome?.proof || !r.outcome.publicSignals) {
        setSteps([{ k: 'none', label: 'nothing to prove: no valid bid was revealed, so no bid was opened', st: 'ok', d: r.outcome?.noSale?.detail ?? '' }]);
        return;
      }
      const signals = [...r.outcome.publicSignals];
      if (t) signals[signals.length - 1] = String(BigInt(signals[signals.length - 1]) + 1n);
      try {
        upd('vk', 'run', '');
        const res = await fetch(VK_URL);
        if (!res.ok) throw new Error(`verification_key.json: HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const vk = JSON.parse(new TextDecoder().decode(buf));
        const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
        upd('vk', hex === r.verificationKeySha256 ? 'ok' : 'bad', `sha256 ${hex.slice(0, 12)}…`);
        upd('proof', 'run', '');
        const ok = await snarkjs.groth16.verify(vk, signals, r.outcome.proof);
        upd('proof', ok ? 'ok' : 'bad', ok ? 'pairing check passes in this tab' : t ? 'claiming 1 zat more breaks the proof' : 'does not verify');
        upd('slots', 'run', '');
        const check = checkResult({
          auctionId: BigInt(r.auction.auctionId),
          reserve: BigInt(r.auction.reserveZat),
          deposits: lot.bids.map((b) => ({ txid: b.ref, height: b.height, status: b.status, commitment: b.status === 'memo_mismatch' ? null : b.commitment })),
          unrevealed: r.outcome.unrevealed ?? [],
          publicSignals: signals,
          emptyCommitment: await emptyCommitment(BigInt(r.auction.auctionId)),
        });
        const by = (n: string) => check.checks.find((c) => c.name === n)!;
        upd('slots', by('slots').ok && by('auction').ok ? 'ok' : 'bad', by('slots').detail);
        upd('winner', by('winner').ok ? 'ok' : 'bad', by('winner').detail);
      } catch (e) {
        setSteps((s) => s.map((x) => (x.st === 'run' || x.st === 'wait' ? { ...x, st: 'bad', d: (e as Error).message } : x)));
      }
    },
    [r, lot.bids],
  );
  useEffect(() => {
    void run(false);
  }, [run]);
  return (
    <div className="proof">
      <ol>
        {steps.map((s) => (
          <li key={s.k} className={`ps-${s.st}`}>
            <span className="ps-icon">{s.st === 'ok' ? '✓' : s.st === 'bad' ? '✕' : s.st === 'run' ? '…' : '·'}</span>
            <span>
              <b>{s.label}</b>
              <small className="mono">{s.d}</small>
            </span>
          </li>
        ))}
      </ol>
      <div className="proof-actions">
        <button className="btn ghost" onClick={() => void run(!tamper)}>
          {tamper ? 'restore the published result' : 'try to claim 1 zat more'}
        </button>
        <span className="faint">Runs in this tab with snarkjs. Nothing is sent anywhere.</span>
      </div>
    </div>
  );
}

/* ---------- the action sheet: bid, reveal, hammer ---------- */
function ActionSheet({ lot, tip }: { lot: Lot; tip: number }) {
  const s = useStore();
  if (lot.phase === 'settled') {
    return (
      <div className="sheet">
        <div className="sheet-title">hammered</div>
        <p className="sheet-note">
          This lot is settled. Losing bids stay sealed: they are not on chain, not in the proof, not in the record. Check the proof yourself in the proof tab.
        </p>
        {lot.record?.settlement?.viewingKeyChecks && (
          <ul className="vk">
            {lot.record.settlement.viewingKeyChecks.map((c) => (
              <li key={c.recipient}>
                <span>{c.recipient}</span>
                <span className="mono">{c.seen.length ? c.seen.map((v) => num(v)).join(' + ') : '0'} zat</span>
                <span className={c.ok ? 'ok' : 'refused'}>{c.ok ? '✓ own key' : '✕'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (s.node !== 'online' || lot.source !== 'node') return <SetupRequired what={lot.phase === 'bidding' ? 'Placing a sealed bid' : 'This step'} />;
  if (lot.phase === 'bidding') return <BidSheet lot={lot} tip={tip} />;
  if (lot.phase === 'reveal') return <RevealSheet lot={lot} />;
  return <HouseSheet lot={lot} />;
}

function WalletPicker() {
  const s = useStore();
  return (
    <div className="wallets" role="radiogroup" aria-label="Bidder wallet">
      {s.wallets.map((w) => (
        <button key={w.name} role="radio" aria-checked={s.wallet === w.name} className={s.wallet === w.name ? 'on' : ''} onClick={() => setWallet(w.name)}>
          <SealAvatar seed={w.address ?? w.name} size={22} />
          <span>
            <b>{w.name}</b>
            <small className="mono">{w.balance?.zat ? `${taz(w.balance.zat, 4)} TAZ` : w.refreshing ? 'reading…' : 'balance —'}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function JobView({ job, error, onDone }: { job: Job | null; error: string | null; onDone?: () => void }) {
  if (error) return <div className="job bad" role="alert">{error}</div>;
  if (!job) return null;
  const tx = job.result?.txid ?? job.result?.settlement ?? job.result?.txids?.[0];
  return (
    <div className={`job ${job.status}`} role="status">
      <ol>
        {job.stages.map((st, i) => (
          <li key={i} className={i === job.stages.length - 1 && job.status === 'running' ? 'now' : ''}>
            {st.text}
          </li>
        ))}
      </ol>
      {job.status === 'failed' && <div className="bad">{job.error}</div>}
      {tx && (
        <a className="mono" href={`${EXPLORER}${tx}`} target="_blank" rel="noreferrer">
          {short(tx, 10, 6)} on the explorer ↗
        </a>
      )}
      {job.status !== 'running' && onDone && (
        <button className="btn ghost sm" onClick={onDone}>
          done
        </button>
      )}
    </div>
  );
}

function BidSheet({ lot, tip }: { lot: Lot; tip: number }) {
  const s = useStore();
  const dep = Number(lot.card.depositZat);
  const res = Number(lot.card.reserveZat);
  const max = dep - 60_000;
  const [amt, setAmt] = useState(() => ((res + max) / 2 / 1e8).toFixed(5));
  const { job, error, run, reset } = useJob();
  const zat = Math.round(Number(amt) * 1e8);
  const invalid = !Number.isFinite(zat) || zat < res ? `at least the reserve, ${taz(res)} TAZ` : zat > max ? `at most ${taz(max)} TAZ (the deposit minus the fee budget)` : null;
  const running = job?.status === 'running';
  const chips = [res, Math.round((res + max) / 2), Math.round(res + (max - res) * 0.8), max];
  return (
    <div className="sheet">
      <div className="sheet-title">place a sealed bid</div>
      <WalletPicker />
      <label className="amount">
        <span className="k">your bid</span>
        <span className="amount-in">
          <input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Bid in TAZ" disabled={running} />
          <span>TAZ</span>
        </span>
        <span className={`hint${invalid && amt ? ' bad' : ''}`}>{invalid ?? `${num(zat)} zat · sealed inside the commitment`}</span>
      </label>
      <div className="quick">
        {chips.map((c) => (
          <button key={c} onClick={() => setAmt((c / 1e8).toFixed(5))} disabled={running}>
            {taz(c, 5)}
          </button>
        ))}
      </div>
      <div className="explain">
        <div>
          <span>you deposit</span>
          <b className="mono">{taz(dep)} TAZ</b>
        </div>
        <div>
          <span>everyone deposits</span>
          <b className="mono">{taz(dep)} TAZ</b>
        </div>
        <div>
          <span>the chain sees your bid as</span>
          <b className="sealed-bar">
            <i />
            <i />
            <i />
            sealed
          </b>
        </div>
      </div>
      <button className="btn primary big" disabled={!!invalid || running || tip >= lot.card.closeHeight} onClick={() => void run(`/auctions/${lot.sale}/bid`, { wallet: s.wallet, bidZat: zat })}>
        {running ? 'sealing & sending…' : `seal bid as ${s.wallet}`}
      </button>
      <p className="sheet-note">Signed by {s.wallet}'s own wallet through its sba-mcp server. A real shielded testnet transaction; it takes a minute or two to build and send.</p>
      <JobView job={job} error={error} onDone={reset} />
    </div>
  );
}

function RevealSheet({ lot }: { lot: Lot }) {
  const s = useStore();
  const { job, error, run, reset } = useJob();
  const running = job?.status === 'running';
  return (
    <div className="sheet">
      <div className="sheet-title">reveal to the house</div>
      <p className="sheet-note">
        Bidding is closed. Send your opening to the house as a second shielded note, sealed to its reveal key. The public sees that a reveal arrived and when, never what it says. A bid nobody reveals is forfeited to the seller.
      </p>
      <WalletPicker />
      <button className="btn primary big" disabled={running} onClick={() => void run(`/auctions/${lot.sale}/reveal`, { wallet: s.wallet })}>
        {running ? 'sealing & sending…' : `reveal ${s.wallet}'s bid`}
      </button>
      <JobView job={job} error={error} onDone={reset} />
    </div>
  );
}

function HouseSheet({ lot }: { lot: Lot }) {
  const { job, error, run } = useJob();
  const s = useStore();
  const running = job?.status === 'running' || s.jobs.some((j) => j.kind === 'settle' && j.auctionId === lot.card.auctionId && j.status === 'running');
  const existing = s.jobs.filter((j) => j.kind === 'settle' && j.auctionId === lot.card.auctionId).at(-1) ?? null;
  return (
    <div className="sheet house">
      <div className="sheet-title">bring down the hammer</div>
      <p className="sheet-note">
        The reveal window is over. The house opens the sealed reveal notes, proves which bid is highest with a Groth16 proof, and pays the seller and refunds every other bidder in one shielded transaction. Only the winning bid is published.
      </p>
      <button className="btn primary big" disabled={running} onClick={() => void run(`/auctions/${lot.sale}/settle`, {})}>
        {running ? 'settling…' : 'open the winner & settle'}
      </button>
      <JobView job={job ?? existing} error={error} />
    </div>
  );
}

function MySeal({ lot }: { lot: Lot }) {
  const s = useStore();
  const [mine, setMine] = useState<Opening[] | null>(null);
  useEffect(() => {
    if (s.node !== 'online' || lot.source !== 'node') return;
    let live = true;
    api<{ openings: Opening[] }>(`/auctions/${lot.sale}/mine?wallet=${s.wallet}`)
      .then((r) => live && setMine(r.openings))
      .catch(() => live && setMine(null));
    return () => {
      live = false;
    };
  }, [s.node, s.wallet, lot.sale, lot.source, s.jobs.length, lot.bids.length, lot.reveals.length]);
  const wonByMe = useMemo(() => mine?.some((o) => o.deposit === lot.winner?.ref), [mine, lot.winner]);
  if (!mine || mine.length === 0) return null;
  return (
    <div className="myseal">
      <div className="more-title">only you can see this · {s.wallet}</div>
      {mine.map((o, i) => (
        <div key={i} className="my-row">
          <SealAvatar seed={o.deposit ?? String(i)} size={26} open={o.deposit === lot.winner?.ref} />
          <span>
            <b className="mono">{taz(o.bidZat)} TAZ</b>
            <small>{fate(lot, o.deposit, !!o.revealTxid).text}</small>
          </span>
        </div>
      ))}
      {lot.phase === 'settled' && !wonByMe && mine.some((o) => fate(lot, o.deposit, true).text.startsWith('lost')) && <p className="faint">Your bid lost and stays sealed: it was never published. Your deposit came back in the settlement.</p>}
      <button className="link" onClick={() => void refresh()}>
        refresh
      </button>
    </div>
  );
}

/** Recent wallet actions on this lot from the node, so a send that outlives its sheet stays visible. */
function LotJobs({ lot }: { lot: Lot }) {
  const s = useStore();
  const mine = s.jobs.filter((j) => j.auctionId === lot.card.auctionId).slice(-3).reverse();
  if (lot.source !== 'node' || mine.length === 0) return null;
  return (
    <div className="myseal">
      <div className="more-title">wallet activity on this lot</div>
      {mine.map((j) => {
        const tx = j.result?.txid ?? j.result?.settlement ?? j.result?.txids?.[0];
        return (
          <div key={j.id} className={`jrow j-${j.status}`}>
            <span className="jdot" />
            <span>
              <b>
                {j.kind === 'settle' ? 'house' : j.wallet} · {j.kind}
              </b>
              <small className="mono">
                {j.status === 'running' ? j.stage : j.status === 'failed' ? j.error : tx ? `${short(tx, 8, 4)} sent` : 'done'}
              </small>
            </span>
          </div>
        );
      })}
    </div>
  );
}
