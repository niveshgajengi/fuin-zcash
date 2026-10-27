// One polling store for the whole app: node health, live auctions, feed, wallets and jobs.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, lotFromNode, PUBLISHED, type FeedItem, type Health, type Job, type Lot, type NodeAuction, type Wallet } from './data';

interface State {
  node: 'checking' | 'online' | 'offline';
  nodeError: string | null;
  health: Health | null;
  auctions: NodeAuction[];
  feed: FeedItem[];
  wallets: Wallet[];
  jobs: Job[];
  wallet: string;
}
let state: State = {
  node: 'checking',
  nodeError: null,
  health: null,
  auctions: [],
  feed: [],
  wallets: [],
  jobs: [],
  wallet: (() => {
    try {
      return localStorage.getItem('fuin.wallet') ?? 'bidder1';
    } catch {
      return 'bidder1';
    }
  })(),
};
const subs = new Set<() => void>();
const set = (p: Partial<State>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

let started = false;
async function poll() {
  try {
    const health = await api<Health>('/health');
    const [a, f, w, j] = await Promise.all([api<{ auctions: NodeAuction[] }>('/auctions'), api<{ feed: FeedItem[] }>('/feed'), api<{ wallets: Wallet[] }>('/wallets'), api<{ jobs: Job[] }>('/jobs')]);
    set({ node: 'online', nodeError: null, health, auctions: a.auctions, feed: f.feed, wallets: w.wallets, jobs: j.jobs });
  } catch (e) {
    set({ node: 'offline', nodeError: (e as Error).message });
  }
}
export function startPolling() {
  if (started) return;
  started = true;
  void poll();
  setInterval(() => void poll(), 4000);
}
export const refresh = () => poll();
export function setWallet(w: string) {
  try {
    localStorage.setItem('fuin.wallet', w);
  } catch {
    /* per-viewer convenience only */
  }
  set({ wallet: w });
}

export function useStore() {
  return useSyncExternalStore(subscribe, () => state);
}

/** Every lot: the node's live and settled auctions first, then published records it does not hold. */
export function useLots(): Lot[] {
  const s = useStore();
  return useMemo(() => {
    const live = s.auctions.map(lotFromNode);
    const have = new Set(live.map((l) => l.card.auctionId));
    return [...live, ...PUBLISHED.filter((l) => !have.has(l.card.auctionId))].sort((a, b) => rank(a) - rank(b) || b.sale.localeCompare(a.sale));
  }, [s.auctions]);
}
const rank = (l: Lot) => ({ bidding: 0, reveal: 1, settle: 2, settling: 3, settled: 4 })[l.phase];

/** Starts a node job and follows it until it ends. */
export function useJob() {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);
  const run = useCallback(async (path: string, body: object) => {
    setError(null);
    setJob(null);
    try {
      const j = await api<Job>(path, { method: 'POST', body: JSON.stringify(body) });
      setJob(j);
      timer.current = window.setInterval(async () => {
        try {
          const n = await api<Job>(`/jobs/${j.id}`);
          setJob(n);
          if (n.status !== 'running') {
            clearInterval(timer.current!);
            void refresh();
          }
        } catch (e) {
          setError((e as Error).message);
        }
      }, 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const reset = useCallback(() => {
    setJob(null);
    setError(null);
  }, []);
  return { job, error, run, reset };
}

/** The current hash route. */
export function useRoute() {
  const [h, setH] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const f = () => {
      setH(location.hash.slice(1) || '/');
      window.scrollTo({ top: 0 });
    };
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return h;
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
