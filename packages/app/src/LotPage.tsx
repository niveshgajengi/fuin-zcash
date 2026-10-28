import { useCallback, useEffect, useMemo, useState } from 'react';
import * as snarkjs from 'snarkjs';
import { checkResult } from '@sba/circuits/result';
import { emptyCommitment } from '@sba/circuits/poseidon';
import { api, EXPLORER, fate, num, short, taz, type Job, type Lot, type Opening } from './data';
import { refresh, setWallet, useJob, useStore } from './store';
import { BlockChart } from './BlockChart';
import { ART, CountdownText, Empty, PhasePill, SealAvatar, SetupRequired } from './ui';

const VK_URL = `${import.meta.env.BASE_URL}verification_key.json`;

/** The lot, the way on-chain auction houses show one (Nouns, Foundation): a stage band with the art,
 * ← → between lots, the title, two numbers side by side, and the one action for this phase. */
export function LotPage({ lot, lots }: { lot: Lot; lots: Lot[] }) {
  const s = useStore();
  const tip = s.health?.tip ?? 0;
  return (
    <div className="lot4">
      <StageBand lot={lot} lots={lots} tip={tip} mode="lot" />
      <PhaseStrip lot={lot} tip={tip} />
      {lot.phase === 'settled' && <Hammer lot={lot} />}
      <div className="lot4-grid">
        <section className="block4" id="bid-history">
          <div className="block4-head">
            <h2>bid history</h2>
            <span className="faint">every bid is the same deposit; the amount stays sealed</span>
          </div>
          <SealedHistory lot={lot} />
        </section>
        <aside className="lot4-side">
          <LotJobs lot={lot} />
          <MySeal lot={lot} />
          <section className="block4 compact">
            <div className="block4-head">
              <h2>by block</h2>
            </div>
            <BlockChart lot={lot} tip={tip} />
          </section>
        </aside>
      </div>
      <section className="block4">
        <div className="block4-head">
          <h2>reveal notes</h2>
          <span className="faint">a second shielded note per bidder, sealed to the house</span>
        </div>
        <Reveals lot={lot} />
      </section>
      {lot.record && (
        <section className="block4" id="check">
          <div className="block4-head">
            <h2>check the result</h2>
            <span className="faint">runs in this tab</span>
          </div>
          <Proof lot={lot} />
        </section>
      )}
      <section className="block4">
        <div className="block4-head">
          <h2>terms</h2>
          <span className="faint">hashed into the auction id</span>
        </div>
        <Terms lot={lot} />
      </section>
      <section className="block4">
        <div className="block4-head">
          <h2>all auctions</h2>
        </div>
        <AuctionsTable lots={lots} tip={tip} current={lot.sale} />
      </section>
    </div>
  );
}

const PHASE_WORD: Record<Lot['phase'], string> = { bidding: 'bidding open', reveal: 'reveal window', settle: 'awaiting the hammer', settling: 'settling', settled: 'hammered' };

export function StageBand({ lot, lots, tip, mode }: { lot: Lot; lots: Lot[]; tip: number; mode: 'home' | 'lot' }) {
  const order = [...lots].sort((a, b) => a.sale.localeCompare(b.sale));
  const i = order.findIndex((l) => l.sale === lot.sale);
  const prev = i > 0 ? order[i - 1] : null;
  const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  const valid = lot.bids.filter((b) => b.status === 'valid').length;
  const to = lot.phase === 'bidding' ? lot.card.closeHeight : lot.phase === 'reveal' ? lot.card.revealCloseHeight ?? null : null;
  const listed = lot.record?.blockTimes?.open?.time;
  const explorerTx = lot.record?.settlement?.txid ?? lot.bids.find((b) => b.status === 'valid')?.txid ?? null;
  return (
    <section className={`stage ph-${lot.phase}`}>
      <div className="stage-in">
        <div className="stage-art">
          <img src={ART(lot.meta.art)} alt="" />
          {lot.phase === 'settled' && <div className={`lp-stamp${lot.winner ? '' : ' none'}`}>{lot.winner ? 'opened' : 'no sale'}</div>}
        </div>
        <div className="stage-panel">
          <div className="lotnav">
            <a className={`navbtn${prev ? '' : ' off'}`} href={prev ? `#/lot/${prev.sale}` : undefined} aria-label="Previous lot">
              ←
            </a>
            <a className={`navbtn${next ? '' : ' off'}`} href={next ? `#/lot/${next.sale}` : undefined} aria-label="Next lot">
              →
            </a>
            <span className="mono">
              lot {lot.sale}
              {listed ? ` · ${new Date(listed * 1000).toUTCString().slice(5, 16)}` : ''} · {PHASE_WORD[lot.phase]}
            </span>
          </div>
          <h1>{lot.meta.title.toLowerCase()}</h1>
          <div className="duo">
            {lot.phase === 'settled' ? (
              <>
                <div>
                  <small>{lot.winner ? 'winning bid' : 'result'}</small>
                  <b className={lot.winner ? 'gold' : ''}>{lot.winner ? `${taz(lot.winner.bidZat)} TAZ` : 'no sale'}</b>
                </div>
                <div>
                  <small>hammer block</small>
                  <b>{num(lot.record!.settlement!.height)}</b>
                </div>
              </>
            ) : (
              <>
                <div>
                  <small>sealed bids</small>
                  <b>
                    {valid} <span className="sealed-chip">amounts sealed</span>
                  </b>
                </div>
                <div>
                  <small>{lot.phase === 'bidding' ? 'bidding ends in' : lot.phase === 'reveal' ? 'reveals close in' : 'reveal window'}</small>
                  <b>{to && tip ? <CountdownText to={to} tip={tip} /> : 'closed'}</b>
                </div>
              </>
            )}
          </div>
          <div className="deposit-line">
            everyone deposits <b className="mono">{taz(lot.card.depositZat)} TAZ</b> · reserve <b className="mono">{taz(lot.card.reserveZat)} TAZ</b>
          </div>
          {mode === 'lot' ? (
            <ActionSheet lot={lot} tip={tip} />
          ) : (
            <a className="btn primary big" href={`#/lot/${lot.sale}`}>
              {lot.phase === 'bidding' ? 'place a sealed bid' : lot.phase === 'settled' ? 'see the hammer' : 'follow this lot'}
            </a>
          )}
          <div className="stage-btns">
            <a className="btn soft" href={`#/lot/${lot.sale}`} onClick={() => setTimeout(() => document.getElementById('bid-history')?.scrollIntoView({ behavior: 'smooth' }), 50)}>
              bid history
            </a>
            {explorerTx && (
              <a className="btn soft" href={`${EXPLORER}${explorerTx}`} target="_blank" rel="noreferrer">
                {lot.record?.settlement ? 'settlement on explorer ↗' : 'a deposit on explorer ↗'}
              </a>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Seal a bid → reveal → hammer, with this lot's real block heights (ENS 2017 spelled its phases out). */
export function PhaseStrip({ lot, tip }: { lot: Lot; tip: number }) {
  const c = lot.card;
  const at = lot.phase === 'bidding' ? 0 : lot.phase === 'reveal' ? 1 : lot.phase === 'settled' ? 3 : 2;
  const steps = [
    { n: '1', t: 'seal a bid', d: `Everyone sends the same deposit; the amount is sealed inside. Until block ${num(c.closeHeight)}.` },
    { n: '2', t: 'reveal', d: `Each bidder sends its bid, locked to the house. Until block ${num(c.revealCloseHeight ?? c.closeHeight)}. Unrevealed bids go to the seller.` },
    { n: '3', t: 'hammer', d: lot.record?.settlement ? `Proved and paid at block ${num(lot.record.settlement.height)}. Only the winning bid is opened.` : 'A zero-knowledge proof opens only the winning bid; one shielded payment settles everyone.' },
  ];
  return (
    <ol className="phases">
      {steps.map((s, i) => (
        <li key={s.n} className={i < at ? 'done' : i === at ? 'now' : ''}>
          <span className="pn">{i < at ? '✓' : s.n}</span>
          <span>
            <b>{s.t}</b>
            <small>{s.d}</small>
          </span>
        </li>
      ))}
      {tip > 0 && lot.phase !== 'settled' && <li className="tipnow mono">now · block {num(tip)}</li>}
    </ol>
  );
}

/** Nouns' bid history, for a shielded auction: one row per deposit, the amount sealed until it is the winner. */
function SealedHistory({ lot }: { lot: Lot }) {
  const unrevealed = lot.record?.outcome?.unrevealed ?? [];
  const rows = lot.bids.filter((b) => b.status !== 'memo_mismatch');
  if (rows.length === 0 && lot.pending.length === 0)
    return (
      <Empty title="no sealed bids yet" art="envelope">
        Every bid lands here as an equal deposit with a sealed commitment. Nobody, not even the house, can read the amount until the reveal.
      </Empty>
    );
  return (
    <ul className="hist4">
      {lot.pending
        .filter((p) => p.kind === 'bid')
        .map((p) => (
          <li key={p.txid} className="pending">
            <span className="pulse" />
            <span className="h-main">
              <b>sealed bid · landing</b>
              <small className="mono">in the mempool · {short(p.txid, 8, 4)}</small>
            </span>
            <span className="h-amt sealed-bar">
              <i />
              <i />
              <i />
              sealed
            </span>
          </li>
        ))}
      {[...rows].reverse().map((b) => {
        const won = lot.winner?.ref === b.ref;
        const forfeit = unrevealed.includes(b.ref);
        return (
          <li key={b.ref} className={won ? 'won' : ''}>
            <SealAvatar seed={b.commitment ?? b.ref} size={40} open={won} />
            <span className="h-main">
              <b>
                {won ? 'winning bid' : b.status === 'valid' ? 'sealed bid' : STATUS[b.status] ?? b.status}
                {won ? ' 🏆' : ''}
              </b>
              <small className="mono">
                block {b.height ? num(b.height) : '—'} · deposit {taz(b.valueZat)} TAZ
              </small>
            </span>
            <span className="h-amt">
              {won ? (
                <span className="opened">{taz(lot.winner!.bidZat)} TAZ</span>
              ) : forfeit ? (
                <span className="refused">never revealed · to the seller</span>
              ) : b.status !== 'valid' ? (
                <span className="refused">refunded per the rules</span>
              ) : (
                <span className="sealed-bar">
                  <i />
                  <i />
                  <i />
                  <i />
                  sealed
                </span>
              )}
            </span>
            <a className="h-x mono" href={`${EXPLORER}${b.txid}`} target="_blank" rel="noreferrer" aria-label="Open on the explorer">
              {short(b.txid, 6, 4)} ↗
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** Every auction in one table (Uniswap Launches). */
export function AuctionsTable({ lots, tip, current }: { lots: Lot[]; tip: number; current?: string }) {
  return (
    <div className="atable" role="table">
      <div className="at-row at-head" role="row">
        <span>lot</span>
        <span>status</span>
        <span className="hide-sm">sealed bids</span>
        <span className="hide-sm">closes / hammer</span>
        <span>opened bid</span>
      </div>
      {lots.map((l) => {
        const valid = l.bids.filter((b) => b.status === 'valid').length;
        return (
          <a key={l.sale} role="row" className={`at-row${l.sale === current ? ' on' : ''}`} href={`#/lot/${l.sale}`}>
            <span className="at-lot">
              <img src={ART(l.meta.art)} alt="" />
              <span>
                <b>{l.meta.title.toLowerCase()}</b>
                <small className="mono">lot {l.sale}</small>
              </span>
            </span>
            <span>
              <PhasePill phase={l.phase} />
            </span>
            <span className="hide-sm mono">{valid}</span>
            <span className="hide-sm mono">
              {l.record?.settlement ? `hammer ${num(l.record.settlement.height)}` : l.phase === 'bidding' && tip ? `${l.card.closeHeight - tip} blocks` : `block ${num(l.card.revealCloseHeight ?? l.card.closeHeight)}`}
            </span>
            <span className={`mono${l.winner ? ' gold' : ''}`}>{l.winner ? `${taz(l.winner.bidZat)} TAZ` : l.noSale ? 'no sale' : 'sealed'}</span>
          </a>
        );
      })}
    </div>
  );
}

function Stat({ k, v, tone = '' }: { k: string; v: string; tone?: string }) {
  return (
    <div className="stat">
      <small>{k}</small>
      <b className={`mono ${tone}`}>{v}</b>
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
  // Check once per settlement: the node's poll hands this lot a new object every few seconds, which
  // must not re-run the checks (that undid the tamper button).
  const settled = r.settlement?.txid ?? r.auction.auctionId;
  useEffect(() => {
    void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);
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
