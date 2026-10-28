import { useEffect, useRef, useState, type ReactNode } from 'react';
import { eta, sealHue, short, taz, num, type FeedItem, type Lot, type Phase } from './data';
import { useNow, useStore } from './store';

export const ART = (name: string) => `${import.meta.env.BASE_URL}brand/lot-${name}.webp`;
export const ARTS = ['envelope', 'hanko', 'koi', 'key', 'lucky-cat', 'lantern'];

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <a className="logo" href="#/" aria-label="Fuin home">
      <img src={`${import.meta.env.BASE_URL}brand/mark-512.png`} width={size} height={size} alt="" />
      <span>fuin</span>
    </a>
  );
}

/** A small generative seal per commitment: the only "face" a sealed bid has. */
export function SealAvatar({ seed, size = 32, open = false }: { seed: string; size?: number; open?: boolean }) {
  const h = sealHue(seed || 'x');
  const petals = 5 + (h % 4);
  const rot = h % 360;
  const tone = ['#ff5a5f', '#ff7b72', '#e8474f', '#ff8f8a', '#d93d4a'][h % 5];
  return (
    <svg className={`seal-avatar${open ? ' open' : ''}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="19" fill={open ? '#f2c46d' : tone} />
      <circle cx="20" cy="20" r="14.5" fill="none" stroke="rgba(58,10,20,.35)" strokeWidth="1.2" />
      <g transform={`rotate(${rot} 20 20)`} fill="rgba(58,10,20,.55)">
        {Array.from({ length: petals }, (_, i) => (
          <ellipse key={i} cx="20" cy="12.4" rx="2.4" ry="5" transform={`rotate(${(360 / petals) * i} 20 20)`} />
        ))}
      </g>
      <circle cx="20" cy="20" r="2.6" fill={open ? '#3a0a14' : '#fbe9ec'} />
    </svg>
  );
}

const PHASE: Record<Phase, { label: string; cls: string }> = {
  bidding: { label: 'live', cls: 'live' },
  reveal: { label: 'revealing', cls: 'reveal' },
  settle: { label: 'awaiting hammer', cls: 'reveal' },
  settling: { label: 'settling', cls: 'reveal' },
  settled: { label: 'hammered', cls: 'done' },
};
export function PhasePill({ phase }: { phase: Phase }) {
  const p = PHASE[phase];
  return (
    <span className={`pill pill-${p.cls}`}>
      {p.cls === 'live' && <i className="dot" />}
      {p.label}
    </span>
  );
}

/** Blocks left to a height, with a live estimate (testnet blocks are about 75 s). */
export function Countdown({ to, tip, label, big = false }: { to: number; tip: number; label: string; big?: boolean }) {
  const now = useNow(1000);
  const s = useStore();
  const left = to - tip;
  const age = s.health?.tipAgeS ?? 0;
  const secs = Math.max(0, left * 75 - age - Math.floor((now / 1000) % 1));
  const mm = Math.floor(secs / 60);
  const ss = Math.floor(secs % 60);
  return (
    <div className={`countdown${big ? ' big' : ''}`}>
      <span className="cd-label">{label}</span>
      <span className="cd-time">{left > 0 ? `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : '00:00'}</span>
      <span className="cd-blocks">{left > 0 ? `${left} block${left === 1 ? '' : 's'} · est.` : `block ${num(to)} passed`}</span>
    </div>
  );
}

/** HH : MM : SS tiles, estimated from blocks left (testnet blocks are about 75 s). */
export function CountdownTiles({ to, tip, label }: { to: number; tip: number; label: string }) {
  const now = useNow(1000);
  const s = useStore();
  const left = to - tip;
  const age = s.health?.tipAgeS ?? 0;
  // Seconds since the node last reported (left, age), so the tiles tick between polls.
  const mark = useRef({ key: '', at: now });
  const key = `${left}:${age}`;
  if (mark.current.key !== key) mark.current = { key, at: now };
  const secs = Math.max(0, Math.round(left * 75 - age - (now - mark.current.at) / 1000));
  const parts = [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), Math.floor(secs % 60)];
  return (
    <div className="tiles">
      <div className="tiles-label">
        <span>{label}</span>
        <span className="mono">{left > 0 ? `${left} block${left === 1 ? '' : 's'} · est.` : `block ${num(to)} passed`}</span>
      </div>
      <div className="tiles-row">
        {parts.map((n, i) => (
          <div key={i} className="tile">
            <b>{String(n).padStart(2, '0')}</b>
            <small>{['hours', 'minutes', 'seconds'][i]}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

/** "10h 33m 35s", estimated from blocks left and ticking between node polls. */
export function CountdownText({ to, tip }: { to: number; tip: number }) {
  const now = useNow(1000);
  const s = useStore();
  const left = to - tip;
  const age = s.health?.tipAgeS ?? 0;
  const mark = useRef({ key: '', at: now });
  const key = `${left}:${age}`;
  if (mark.current.key !== key) mark.current = { key, at: now };
  const secs = Math.max(0, Math.round(left * 75 - age - (now - mark.current.at) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return (
    <span className="cdt">
      {h > 0 ? `${h}h ` : ''}
      {m}m {String(secs % 60).padStart(2, '0')}s <small className="mono">{left > 0 ? `${left} blocks` : 'closed'}</small>
    </span>
  );
}

/** A compact lot row: thumbnail, title, state and the one number that matters. */
export function LotRow({ lot, tip }: { lot: Lot; tip: number }) {
  const valid = lot.bids.filter((b) => b.status === 'valid').length;
  const left = lot.phase === 'bidding' ? lot.card.closeHeight - tip : null;
  return (
    <a className="lot-row" href={`#/lot/${lot.sale}`}>
      <img src={ART(lot.meta.art)} alt="" loading="lazy" />
      <span className="lr-main">
        <b>{lot.meta.title.toLowerCase()}</b>
        <small className="mono">
          lot {lot.sale} · {valid} sealed{left !== null && tip > 0 ? ` · ${left} blocks left` : ''}
        </small>
      </span>
      <span className="lr-end">
        <PhasePill phase={lot.phase} />
        <b className={`mono${lot.winner ? ' gold' : ''}`}>{lot.winner ? `${taz(lot.winner.bidZat)}` : lot.noSale ? 'no sale' : 'sealed'}</b>
      </span>
    </a>
  );
}

export function LotCard({ lot, tip }: { lot: Lot; tip: number }) {
  const valid = lot.bids.filter((b) => b.status === 'valid').length;
  const pending = lot.pending.filter((p) => p.kind === 'bid').length;
  return (
    <a className={`lot-card ph-${lot.phase}`} href={`#/lot/${lot.sale}`}>
      <div className="lc-art">
        <img src={ART(lot.meta.art)} alt="" loading="lazy" />
        <div className="lc-top">
          <PhasePill phase={lot.phase} />
          <span className="lc-no">lot {lot.sale}</span>
        </div>
        {lot.phase === 'bidding' && tip > 0 && (
          <div className="lc-timer">
            <Countdown to={lot.card.closeHeight} tip={tip} label="closes in" />
          </div>
        )}
      </div>
      <div className="lc-body">
        <div className="lc-title">{lot.meta.title.toLowerCase()}</div>
        <div className="lc-stack" aria-label={`${valid} sealed bids`}>
          {lot.bids
            .filter((b) => b.status === 'valid')
            .slice(0, 5)
            .map((b) => (
              <SealAvatar key={b.ref} seed={b.commitment ?? b.ref} size={22} open={lot.winner?.ref === b.ref} />
            ))}
          <span>
            {valid} sealed{pending ? ` · ${pending} landing` : ''}
          </span>
        </div>
        <div className="lc-foot">
          <div>
            <span className="k">deposit</span>
            <span className="v">{taz(lot.card.depositZat)} TAZ</span>
          </div>
          <div className="r">
            {lot.winner ? (
              <>
                <span className="k">opened</span>
                <span className="v gold">{taz(lot.winner.bidZat)} TAZ</span>
              </>
            ) : lot.noSale ? (
              <>
                <span className="k">result</span>
                <span className="v">no sale</span>
              </>
            ) : (
              <>
                <span className="k">top bid</span>
                <span className="v sealed">sealed</span>
              </>
            )}
          </div>
          <span className={`lc-cta${lot.phase === 'bidding' ? ' hot' : ''}`}>{lot.phase === 'bidding' ? 'place bid' : lot.phase === 'settled' ? 'view' : 'follow'}</span>
        </div>
      </div>
    </a>
  );
}

const FEED_ICON: Record<FeedItem['kind'], string> = { bid: '◉', reveal: '✉', settle: '⚖', created: '✦', other: '·' };
export function Ticker({ items }: { items: FeedItem[] }) {
  if (items.length === 0) return null;
  const row = [...items.slice(0, 14)];
  return (
    <div className="ticker" aria-label="Live chain activity">
      <div className="ticker-track">
        {[...row, ...row].map((f, i) => (
          <a key={`${f.id}-${i}`} href={`#/lot/${f.sale}`} className={`tk tk-${f.kind}`} aria-hidden={i >= row.length}>
            <b>{FEED_ICON[f.kind]}</b> lot {f.sale} · {f.text}
            {f.height ? <em> · block {num(f.height)}</em> : null}
          </a>
        ))}
      </div>
    </div>
  );
}

export function FeedRow({ f }: { f: FeedItem }) {
  const isTx = /^[0-9a-f]{64}/.test(f.txid);
  return (
    <li className={`feed-row fk-${f.kind}`}>
      <span className="fr-icon">{FEED_ICON[f.kind]}</span>
      <div className="fr-main">
        <div>
          <span className={`tag t-${f.kind}`}>{({ bid: 'bid', reveal: 'reveal', settle: 'hammer', created: 'listed', other: 'note' } as const)[f.kind]}</span>
          <a href={`#/lot/${f.sale}`}>
            lot {f.sale} · {f.lot.toLowerCase()}
          </a>{' '}
          <span className="fr-text">{f.text}</span>
        </div>
        <div className="fr-meta mono">
          {f.height ? `block ${num(f.height)} · ` : ''}
          {isTx ? (
            <a href={`https://testnet.zecblock.com/tx/${f.txid.slice(0, 64)}`} target="_blank" rel="noreferrer">
              {short(f.txid.slice(0, 64), 8, 6)} ↗
            </a>
          ) : (
            'auction card'
          )}
        </div>
      </div>
    </li>
  );
}

/** Pops a toast for each feed item that arrives while the page is open. */
export function Toasts() {
  const s = useStore();
  const seen = useRef<Set<string> | null>(null);
  const [toasts, setToasts] = useState<FeedItem[]>([]);
  useEffect(() => {
    if (s.node !== 'online') return;
    if (seen.current === null) {
      seen.current = new Set(s.feed.map((f) => f.id));
      return;
    }
    const fresh = s.feed.filter((f) => !seen.current!.has(f.id));
    fresh.forEach((f) => seen.current!.add(f.id));
    if (fresh.length) {
      setToasts((t) => [...fresh.slice(0, 3), ...t].slice(0, 3));
      const ids = fresh.map((f) => f.id);
      setTimeout(() => setToasts((t) => t.filter((x) => !ids.includes(x.id))), 6500);
    }
  }, [s.feed, s.node]);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <a key={t.id} className={`toast fk-${t.kind}`} href={`#/lot/${t.sale}`}>
          <span className="fr-icon">{FEED_ICON[t.kind]}</span>
          <span>
            <b>lot {t.sale}</b> {t.text}
            {t.height ? <em className="mono"> · block {num(t.height)}</em> : null}
          </span>
        </a>
      ))}
    </div>
  );
}

export function Empty({ title, children, art = 'envelope' }: { title: string; children?: ReactNode; art?: string }) {
  return (
    <div className="empty">
      <img src={ART(art)} alt="" />
      <div>
        <div className="empty-title">{title}</div>
        {children && <div className="empty-body">{children}</div>}
      </div>
    </div>
  );
}

export function SetupRequired({ what }: { what: string }) {
  const s = useStore();
  return (
    <div className="setup" role="alert">
      <div className="setup-title">Setup required</div>
      <p>
        {what} signs a real Zcash testnet transaction with a local wallet, so it needs a Fuin node on this machine. This hosted page is read-only: it shows the published sales and checks their proofs in your browser.
      </p>
      <pre className="mono">pnpm install && pnpm fuin{'\n'}pnpm --filter @sba/app dev   # http://localhost:5180</pre>
      {s.node === 'online' && s.health && s.health.setup.length > 0 && (
        <ul className="mono">
          {s.health.setup.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { eta };
