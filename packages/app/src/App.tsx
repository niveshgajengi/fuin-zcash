import { useEffect, useState } from 'react';
import { api, fate, num, REPO, taz, type Lot } from './data';
import { LotPage } from './LotPage';
import { refresh, startPolling, useLots, useRoute, useStore } from './store';
import { ART, ARTS, Countdown, Empty, FeedRow, LotCard, Logo, PhasePill, SealAvatar, SetupRequired, Ticker, Toasts } from './ui';

export function App() {
  useEffect(startPolling, []);
  const route = useRoute();
  const lots = useLots();
  const s = useStore();
  const [creating, setCreating] = useState(false);
  const lotMatch = route.match(/^\/lot\/(\d{3})$/);
  const lot = lotMatch ? lots.find((l) => l.sale === lotMatch[1]) : undefined;
  const page = lotMatch ? 'lot' : route === '/activity' ? 'activity' : route === '/seals' ? 'seals' : route === '/how' ? 'how' : 'floor';
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <Logo />
        <nav className="nav" aria-label="Main">
          <a href="#/" className={page === 'floor' || page === 'lot' ? 'on' : ''}>
            floor
          </a>
          <a href="#/activity" className={page === 'activity' ? 'on' : ''}>
            activity
          </a>
          <a href="#/seals" className={page === 'seals' ? 'on' : ''}>
            my seals
          </a>
          <a href="#/how" className={page === 'how' ? 'on' : ''}>
            how it works
          </a>
        </nav>
        <div className="top-right">
          <BlockChip />
          <button className="btn ghost sm hide-sm" onClick={() => setCreating(true)}>
            + list a lot
          </button>
        </div>
      </header>
      <Ticker items={s.feed} />
      <main id="main">
        {page === 'floor' && <Floor lots={lots} onCreate={() => setCreating(true)} />}
        {page === 'lot' && (lot ? <LotPage key={lot.sale} lot={lot} lots={lots} /> : <Empty title={`lot ${lotMatch![1]} is not on this page`}>It may live on another Fuin node. <a href="#/">Back to the floor</a></Empty>)}
        {page === 'activity' && <Activity />}
        {page === 'seals' && <Seals lots={lots} />}
        {page === 'how' && <How />}
      </main>
      <footer className="foot">
        <Logo size={22} />
        <span>Sealed bids on Zcash testnet. Only the winner is ever opened.</span>
        <span className="foot-links">
          <a href={REPO} target="_blank" rel="noreferrer">
            source
          </a>
          <a href="./saleroom/">saleroom</a>
          <a href="./evidence.html">evidence</a>
          <span className="faint">MIT · lot art is illustrative; bids, proofs and payouts are real testnet records</span>
        </span>
      </footer>
      <nav className="tabbar" aria-label="Main (mobile)">
        <a href="#/" className={page === 'floor' || page === 'lot' ? 'on' : ''}>
          <span>◎</span>floor
        </a>
        <a href="#/activity" className={page === 'activity' ? 'on' : ''}>
          <span>≋</span>activity
        </a>
        <button onClick={() => setCreating(true)}>
          <span>＋</span>list
        </button>
        <a href="#/seals" className={page === 'seals' ? 'on' : ''}>
          <span>◉</span>seals
        </a>
        <a href="#/how" className={page === 'how' ? 'on' : ''}>
          <span>?</span>how
        </a>
      </nav>
      {creating && <CreateLot onClose={() => setCreating(false)} />}
      <Toasts />
    </>
  );
}

function BlockChip() {
  const s = useStore();
  if (s.node === 'online' && s.health)
    return (
      <span className="block-chip" title="Chain tip read by your Fuin node from lightwalletd">
        <i className="dot" /> block {num(s.health.tip)}
      </span>
    );
  return (
    <span className="block-chip off" title={s.nodeError ?? ''}>
      <i className="dot" /> {s.node === 'checking' ? 'connecting…' : 'read-only'}
    </span>
  );
}

function Floor({ lots: all, onCreate }: { lots: Lot[]; onCreate: () => void }) {
  const s = useStore();
  const tip = s.health?.tip ?? 0;
  const [scope, setScope] = useState<'all' | 'node'>(() => (new URLSearchParams(location.hash.split('?')[1] ?? '').get('scope') === 'node' ? 'node' : 'all'));
  const lots = scope === 'node' ? all.filter((l) => l.source === 'node') : all;
  const live = lots.filter((l) => l.phase !== 'settled');
  const settled = lots.filter((l) => l.phase === 'settled');
  const hero = live[0] ?? settled[0];
  const opened = settled.filter((l) => l.winner).length;
  const sealedForever = settled.reduce((n, l) => n + l.bids.filter((b) => b.status === 'valid' && b.ref !== l.winner?.ref && !(l.record?.outcome?.unrevealed ?? []).includes(b.ref)).length, 0);
  return (
    <>
      {hero && <Hero lot={hero} tip={tip} />}
      {s.node === 'online' && (
        <div className="scope" role="tablist" aria-label="Which lots">
          <button role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
            all lots · {all.length}
          </button>
          <button role="tab" aria-selected={scope === 'node'} className={scope === 'node' ? 'on' : ''} onClick={() => setScope('node')}>
            run on this node · {all.filter((l) => l.source === 'node').length}
          </button>
        </div>
      )}
      <section className="stats3" aria-label="Totals from the published records">
        <div>
          <b>{settled.length}</b>
          <span>{scope === 'node' ? 'sales hammered on this node' : 'sales hammered on testnet'}</span>
        </div>
        <div>
          <b>{opened}</b>
          <span>winning bids opened</span>
        </div>
        <div>
          <b>{sealedForever}</b>
          <span>losing bids never published</span>
        </div>
      </section>
      <section className="shelf">
        <div className="shelf-head">
          <h2>live now</h2>
          <button className="btn ghost sm" onClick={onCreate}>
            + list a lot
          </button>
        </div>
        {live.length ? (
          <div className="grid">
            {live.map((l) => (
              <LotCard key={l.sale} lot={l} tip={tip} />
            ))}
          </div>
        ) : s.node === 'online' ? (
          <Empty title="nothing on the floor right now" art="lantern">
            List a lot and its sealed bidding opens at the next block. <button className="link" onClick={onCreate}>List a lot</button>
          </Empty>
        ) : (
          <Empty title="no live lots on this page" art="lantern">
            Live lots run on a Fuin node (it holds the house key and signs with local testnet wallets). This hosted page is read-only: below are the hammered sales, with their proofs checkable in your browser.
          </Empty>
        )}
      </section>
      <section className="shelf">
        <div className="shelf-head">
          <h2>hammered</h2>
          <span className="faint">real testnet sales · proofs check in your browser</span>
        </div>
        <div className="grid">
          {settled.map((l) => (
            <LotCard key={l.sale} lot={l} tip={tip} />
          ))}
        </div>
      </section>
      <section className="why">
        <div className="why-card">
          <span className="eyebrow mono">01 · sealed</span>
          <h3>nobody sees your bid</h3>
          <p>Every bidder sends the same deposit. Your amount hides inside a commitment in a shielded memo.</p>
        </div>
        <div className="why-card">
          <span className="eyebrow mono">02 · opened once</span>
          <h3>only the winner is opened</h3>
          <p>A zero-knowledge proof shows the winning bid beat every other one, without opening them.</p>
        </div>
        <div className="why-card dark">
          <span className="eyebrow mono">03 · checkable</span>
          <h3>anyone can audit it</h3>
          <p>The auction's viewing key is public: anyone can see every deposit arrived and none was left out.</p>
        </div>
      </section>
    </>
  );
}

function Hero({ lot, tip }: { lot: Lot; tip: number }) {
  const valid = lot.bids.filter((b) => b.status === 'valid');
  return (
    <section className="hero" style={{ backgroundImage: `linear-gradient(90deg, rgba(13,5,7,.96) 0%, rgba(13,5,7,.82) 45%, rgba(13,5,7,.35) 100%), url(${import.meta.env.BASE_URL}brand/hero.webp)` }}>
      <div className="hero-copy">
        <div className="hero-eyebrow">
          <PhasePill phase={lot.phase} />
          <span className="mono">lot {lot.sale}</span>
        </div>
        <h1>
          bid in private.
          <br />
          <em>only the winner is opened.</em>
        </h1>
        <p>Sealed-bid auctions on Zcash. Every bid is the same shielded deposit; the amount stays sealed. Losing bids are never published, not even after the hammer.</p>
        <div className="hero-cta">
          <a className="btn primary big" href={`#/lot/${lot.sale}`}>
            {lot.phase === 'bidding' ? 'place a sealed bid' : lot.phase === 'settled' ? 'see the hammer' : 'follow this lot'}
          </a>
          <a className="btn ghost big" href="#/how">
            how sealing works
          </a>
        </div>
      </div>
      <a className="hero-lot" href={`#/lot/${lot.sale}`}>
        <img src={ART(lot.meta.art)} alt="" />
        <div className="hl-body">
          <div className="hl-title">{lot.meta.title.toLowerCase()}</div>
          <div className="hl-row">
            <div className="lc-stack">
              {valid.slice(0, 6).map((b) => (
                <SealAvatar key={b.ref} seed={b.commitment ?? b.ref} size={24} open={lot.winner?.ref === b.ref} />
              ))}
              <span>{valid.length} sealed</span>
            </div>
            {lot.winner ? <span className="gold mono">opened {taz(lot.winner.bidZat)} TAZ</span> : <span className="mono faint">deposit {taz(lot.card.depositZat)} TAZ</span>}
          </div>
          {lot.phase === 'bidding' && tip > 0 && <Countdown to={lot.card.closeHeight} tip={tip} label="closes in" />}
        </div>
      </a>
    </section>
  );
}

function Activity() {
  const s = useStore();
  return (
    <section className="page narrow">
      <h1>activity</h1>
      <p className="lede">Everything the auction's public viewing key can see, as it lands: deposits, sealed reveal notes and hammers. Never an amount.</p>
      {s.node !== 'online' ? (
        <Empty title="the live feed comes from a Fuin node" art="koi">
          Your node watches each live auction's blocks with its public viewing key. This hosted page has no node, so there is no live feed here; the hammered sales are on the floor.
        </Empty>
      ) : s.feed.length === 0 ? (
        <Empty title="quiet so far" art="koi">
          List a lot, and its first sealed bid will show up here when its block lands.
        </Empty>
      ) : (
        <ul className="feed">
          {s.feed.map((f) => (
            <FeedRow key={f.id} f={f} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Seals({ lots }: { lots: Lot[] }) {
  const s = useStore();
  const [rows, setRows] = useState<{ lot: Lot; bidZat: string; deposit: string | null; revealTxid: string | null }[] | null>(null);
  const nodeLots = lots.filter((l) => l.source === 'node');
  useEffect(() => {
    if (s.node !== 'online') return;
    let live = true;
    Promise.all(nodeLots.map((l) => api<{ openings: { bidZat: string; deposit: string | null; revealTxid: string | null }[] }>(`/auctions/${l.sale}/mine?wallet=${s.wallet}`).then((r) => r.openings.map((o) => ({ lot: l, ...o })))))
      .then((x) => live && setRows(x.flat()))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [s.node, s.wallet, nodeLots.length]);
  return (
    <section className="page narrow">
      <h1>my seals</h1>
      <p className="lede">Your own bids, read from your bidder's local openings folder. Only you see these amounts; the chain sees equal deposits.</p>
      {s.node !== 'online' ? (
        <SetupRequired what="Bidding" />
      ) : (
        <>
          <div className="wallet-tabs">
            {s.wallets.map((w) => (
              <button key={w.name} className={s.wallet === w.name ? 'on' : ''} onClick={() => import('./store').then((m) => m.setWallet(w.name))}>
                <SealAvatar seed={w.address ?? w.name} size={20} /> {w.name}
                <small className="mono">{w.balance?.zat ? `${taz(w.balance.zat, 4)} TAZ` : ''}</small>
              </button>
            ))}
            <button className="link" onClick={() => void api('/wallets/refresh', { method: 'POST' }).then(refresh)}>
              refresh balances
            </button>
          </div>
          {!rows ? (
            <p className="faint">reading…</p>
          ) : rows.length === 0 ? (
            <Empty title={`${s.wallet} has no seals yet`} art="hanko">
              Open a live lot and place a sealed bid.
            </Empty>
          ) : (
            <div className="table">
              <div className="tr th">
                <span>lot</span>
                <span>your bid</span>
                <span className="hide-sm">deposit</span>
                <span>status</span>
              </div>
              {rows.map((r, i) => {
                const won = r.lot.winner?.ref === r.deposit;
                return (
                  <a className={`tr${won ? ' won' : ''}`} key={i} href={`#/lot/${r.lot.sale}`}>
                    <span className="who">
                      <img className="thumb" src={ART(r.lot.meta.art)} alt="" /> lot {r.lot.sale} · {r.lot.meta.title.toLowerCase()}
                    </span>
                    <span className="mono">{taz(r.bidZat)}</span>
                    <span className="hide-sm mono">{r.deposit ? `${r.deposit.slice(0, 8)}…` : 'not mined'}</span>
                    <span>{(() => { const f = fate(r.lot, r.deposit, !!r.revealTxid); return <span className={f.cls}>{f.text}</span>; })()}</span>
                  </a>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function How() {
  return (
    <section className="page narrow how">
      <h1>how sealing works</h1>
      <p className="lede">In an open auction everyone sees every bid. Bots snipe the last second, the house can shill against you, and your maximum price is public forever. Fuin keeps every bid sealed, and opens only the winner.</p>
      <ol className="how-steps">
        <li>
          <b>1 · seal</b>
          <span>You pick a bid. Your wallet sends the same deposit as everyone else, a shielded Zcash payment whose memo is a commitment to your bid (a hash with a random salt). The chain sees equal deposits.</span>
        </li>
        <li>
          <b>2 · reveal</b>
          <span>When bidding closes, your wallet sends a second shielded note: your bid, encrypted to the house's key. The chain timestamps it; nobody else can read it.</span>
        </li>
        <li>
          <b>3 · hammer</b>
          <span>The house proves, with a zero-knowledge proof (Groth16), which sealed bid is highest. Only that one is opened. One shielded transaction pays the seller and refunds everyone else.</span>
        </li>
        <li>
          <b>4 · check</b>
          <span>The auction's viewing key is public, so anyone can scan its blocks, see every deposit, and check the proof covers exactly those deposits. Each bidder checks its own refund with its own key.</span>
        </li>
      </ol>
      <div className="privacy">
        <div className="pv-head">
          <span>who learns what</span>
          <span>public</span>
          <span>house</span>
          <span>you</span>
        </div>
        {[
          ['that a deposit arrived', '✓', '✓', '✓'],
          ['a losing bid amount', '—', '✓ at reveal', 'your own'],
          ['the winning bid', '✓', '✓', '✓'],
          ['who you are', '—', '—', '✓'],
        ].map((r) => (
          <div key={r[0]} className="pv-row">
            {r.map((c, i) => (
              <span key={i}>{c}</span>
            ))}
          </div>
        ))}
      </div>
      <p className="faint">
        Honest limits: the house learns the bids when they are revealed and is trusted to settle; the audit trusts the lightwalletd it reads; this runs on Zcash testnet (TAZ has no value). Details: <a href={`${REPO}/tree/main/packages/docs`}>protocol notes</a>.
      </p>
    </section>
  );
}

function CreateLot({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [title, setTitle] = useState('');
  const [art, setArt] = useState('envelope');
  const [blurb, setBlurb] = useState('');
  const [deposit, setDeposit] = useState('0.002');
  const [reserve, setReserve] = useState('0.0005');
  const [closeBlocks, setCloseBlocks] = useState('16');
  const [revealBlocks, setRevealBlocks] = useState('14');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, [onClose]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const a = await api<{ sale: string }>('/auctions', { method: 'POST', body: JSON.stringify({ title, art, blurb, depositTaz: Number(deposit), reserveTaz: Number(reserve), closeBlocks: Number(closeBlocks), revealBlocks: Number(revealBlocks) }) });
      await refresh();
      onClose();
      location.hash = `#/lot/${a.sale}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="List a lot" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>list a lot</h2>
          <button className="x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {s.node !== 'online' ? (
          <SetupRequired what="Listing a lot" />
        ) : (
          <>
            <div className="art-pick" role="radiogroup" aria-label="Lot art">
              {ARTS.map((a) => (
                <button key={a} role="radio" aria-checked={art === a} className={art === a ? 'on' : ''} onClick={() => setArt(a)}>
                  <img src={ART(a)} alt={a} />
                </button>
              ))}
            </div>
            <label className="field">
              <span>title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={48} placeholder="e.g. Ember Envelope" autoFocus />
            </label>
            <label className="field">
              <span>one line about it</span>
              <input value={blurb} onChange={(e) => setBlurb(e.target.value)} maxLength={200} placeholder="optional" />
            </label>
            <div className="field-row">
              <label className="field">
                <span>equal deposit (TAZ)</span>
                <input inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
              </label>
              <label className="field">
                <span>reserve (TAZ)</span>
                <input inputMode="decimal" value={reserve} onChange={(e) => setReserve(e.target.value)} />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>bidding (blocks)</span>
                <input inputMode="numeric" value={closeBlocks} onChange={(e) => setCloseBlocks(e.target.value)} />
              </label>
              <label className="field">
                <span>reveal window (blocks)</span>
                <input inputMode="numeric" value={revealBlocks} onChange={(e) => setRevealBlocks(e.target.value)} />
              </label>
            </div>
            <p className="faint">
              Testnet blocks are about 75 s. The house makes a fresh reveal key; the auction id is a hash of every term, so nothing can change after the first bid. Listing sends no transaction.
            </p>
            {error && (
              <div className="job bad" role="alert">
                {error}
              </div>
            )}
            <button className="btn primary big" disabled={busy || !title.trim()} onClick={() => void submit()}>
              {busy ? 'listing…' : 'open sealed bidding'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
