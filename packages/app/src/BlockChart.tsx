import { num, type Lot } from './data';
import { SealAvatar } from './ui';

/**
 * The lot's life in blocks, drawn from chain data only: x is the block height from listing to the
 * hammer (or the tip), the coral step is sealed deposits so far, the gold step reveal notes so far,
 * with the close, reveal close and hammer marked. Every marker is a real transaction.
 */
export function BlockChart({ lot, tip }: { lot: Lot; tip: number }) {
  const c = lot.card;
  const hammer = lot.record?.settlement?.height ?? null;
  const start = c.openHeight;
  const end = Math.max(hammer ?? 0, c.revealCloseHeight ?? c.closeHeight, Math.min(tip || 0, (c.revealCloseHeight ?? c.closeHeight) + 12)) + 2;
  const W = 1000;
  const H = 260;
  const padL = 34;
  const padR = 16;
  const padT = 34;
  const padB = 34;
  const x = (h: number) => padL + ((h - start) / Math.max(1, end - start)) * (W - padL - padR);
  const bids = lot.bids.filter((b) => b.height !== null).sort((a, b) => a.height! - b.height!);
  const reveals = lot.reveals.filter((r) => r.height !== null).sort((a, b) => a.height! - b.height!);
  const maxN = Math.max(3, bids.length, reveals.length);
  const y = (n: number) => H - padB - (n / maxN) * (H - padT - padB);
  const now = Math.min(tip || end, end);
  const step = (hs: number[], upto: number) => {
    let d = `M ${x(start)} ${y(0)}`;
    let n = 0;
    for (const h of hs) {
      d += ` L ${x(h)} ${y(n)} L ${x(h)} ${y(n + 1)}`;
      n++;
    }
    return { d: d + ` L ${x(upto)} ${y(n)}`, n };
  };
  const last = hammer ?? now;
  const b = step(bids.map((v) => v.height!), last);
  const r = step(reveals.map((v) => v.height!), last);
  const marks = [
    { h: c.closeHeight, label: 'bids close' },
    ...(c.revealCloseHeight ? [{ h: c.revealCloseHeight, label: 'reveals close' }] : []),
    ...(hammer ? [{ h: hammer, label: 'hammer' }] : []),
  ];
  return (
    <div className="chart">
      <div className="chart-head">
        <span>
          <i className="sw coral" /> sealed deposits <b className="mono">{bids.filter((v) => v.status === 'valid').length}</b>
        </span>
        <span>
          <i className="sw gold" /> reveal notes <b className="mono">{reveals.length}</b>
        </span>
        <span className="mono faint">
          blocks {num(start)} → {num(end - 2)}
        </span>
      </div>
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Deposits and reveal notes by block">
          <defs>
            <linearGradient id="cfill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#b9a6ff" stopOpacity="0.55" />
              <stop offset="1" stopColor="#b9a6ff" stopOpacity="0.1" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={padL} x2={W - padR} y1={padT + f * (H - padT - padB)} y2={padT + f * (H - padT - padB)} className="grid-l" />
          ))}
          {lot.phase !== 'settled' && tip > 0 && <rect x={x(start)} y={padT} width={Math.max(0, x(now) - x(start))} height={H - padT - padB} className="elapsed" />}
          {marks.map((m) => (
            <g key={m.label}>
              <line x1={x(m.h)} x2={x(m.h)} y1={padT - 6} y2={H - padB} className={`mark ${m.label === 'hammer' ? 'm-gold' : ''}`} />
            </g>
          ))}
          <path d={`${b.d} L ${x(last)} ${y(0)} Z`} fill="url(#cfill)" />
          <path d={b.d} className="line coral" />
          <path d={r.d} className="line gold" />
          {lot.phase !== 'settled' && tip > 0 && <line x1={x(now)} x2={x(now)} y1={padT - 6} y2={H - padB} className="now" />}
        </svg>
        {bids.map((v, i) => (
          <span key={v.ref} className={`pin${v.status === 'valid' ? '' : ' off'}`} style={{ left: `${(x(v.height!) / W) * 100}%`, top: `${(y(i + 1) / H) * 100}%` }} title={`deposit ${v.txid.slice(0, 10)}… block ${num(v.height!)}: ${v.status}`}>
            <SealAvatar seed={v.commitment ?? v.ref} size={22} open={lot.winner?.ref === v.ref} />
          </span>
        ))}
        {marks.map((m) => (
          <span key={m.label} className={`mark-label${m.label === 'hammer' ? ' gold' : ''}`} style={{ left: `${(x(m.h) / W) * 100}%` }}>
            {m.label}
          </span>
        ))}
        {lot.phase !== 'settled' && tip > 0 && (
          <span className="now-label mono" style={{ left: `${(x(now) / W) * 100}%` }}>
            now · {num(tip)}
          </span>
        )}
      </div>
    </div>
  );
}
