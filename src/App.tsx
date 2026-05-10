import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadEvents } from './lib/loadEvents';
import { useUrlSet } from './lib/useUrlSet';
import { useUrlString } from './lib/useUrlString';
import { Timeline } from './components/Timeline';
import { FilterBar } from './components/FilterBar';
import type { Dataset, Event } from './types';

const WINDOW_OPTIONS = [30, 60, 90, 180, 365] as const;
const DEFAULT_WINDOW = 365;

// Index derived from data.events at runtime so the UI can:
//   - know the canonical repoKey for a plain repo display name
//   - detect collisions (same plain "owner/name" appearing under multiple hosts)
//   - look up the host for any repoKey when rendering the [host] badge
export type RepoIndex = {
  byRepo: Map<string, Set<string>>;   // plain repo -> repoKeys observed
  hostOf: Map<string, string>;        // repoKey -> host
  hasCollision: (repo: string) => boolean;
};

function useUrlWindow(): [number, (n: number) => void] {
  const read = () => {
    if (typeof window === 'undefined') return DEFAULT_WINDOW;
    const raw = new URLSearchParams(window.location.search).get('window');
    const n = raw ? Number(raw) : NaN;
    return (WINDOW_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_WINDOW;
  };
  const [value, setValue] = useState(read);
  useEffect(() => {
    const onPop = () => setValue(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const set = useCallback((n: number) => {
    const params = new URLSearchParams(window.location.search);
    if (n === DEFAULT_WINDOW) params.delete('window');
    else params.set('window', String(n));
    const qs = params.toString();
    const url = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    window.history.replaceState(null, '', url);
    setValue(n);
  }, []);
  return [value, set];
}

export function App() {
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [windowDays, setWindowDays] = useUrlWindow();
  const fundFilter = useUrlSet('funds');
  const repoFilter = useUrlSet('repos');
  const typeFilter = useUrlSet('types');
  const actorFilter = useUrlSet('devs');
  const [authorQuery, setAuthorQuery] = useUrlString('author');

  useEffect(() => {
    loadEvents()
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, []);

  // Track the filter bar's height so day headers in the Timeline can
  // stick just below it on desktop instead of being hidden behind it.
  const filterBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = filterBarRef.current;
    if (!el) return;
    const update = () => {
      document.documentElement.style.setProperty('--filter-bar-h', `${el.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  // Build the host-aware index from the loaded events. Recomputed only when
  // data changes, then passed down to FilterBar for chip rendering.
  const repoIndex = useMemo<RepoIndex | null>(() => {
    if (!data) return null;
    const byRepo = new Map<string, Set<string>>();
    const hostOf = new Map<string, string>();
    for (const e of data.events) {
      let s = byRepo.get(e.repo);
      if (!s) {
        s = new Set();
        byRepo.set(e.repo, s);
      }
      s.add(e.repoKey);
      hostOf.set(e.repoKey, e.host);
    }
    return {
      byRepo,
      hostOf,
      hasCollision: (r: string) => (byRepo.get(r)?.size ?? 0) > 1,
    };
  }, [data]);

  const fundReposUnion = useMemo(() => {
    const sel = fundFilter.selected;
    if (!data || !sel || sel.size === 0) return null;
    const out = new Set<string>();
    for (const f of sel) for (const r of data.funds[f] ?? []) out.add(r);
    return out;
  }, [data, fundFilter.selected]);

  const cutoffMs = useMemo(
    () => Date.now() - windowDays * 24 * 60 * 60 * 1000,
    [windowDays],
  );

  const authorExact = authorQuery.trim();

  // Repo selections may contain either:
  //   - a repoKey ("github:owner/name", "codeberg:owner/name") -- post-Step-4 default
  //   - a plain repo ("owner/name")                            -- backward compatibility
  // An event matches if its repoKey OR plain repo is in the selection.
  const matchRepoSelection = (sel: Set<string> | null, e: Event) => {
    if (!sel || sel.size === 0) return true;
    return sel.has(e.repoKey) || sel.has(e.repo);
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const inSet = (s: Set<string> | null, v: string) => !s || s.size === 0 || s.has(v);
    return data.events.filter(
      (e) =>
        Date.parse(e.timestamp) >= cutoffMs &&
        (!fundReposUnion || fundReposUnion.has(e.repo)) &&
        matchRepoSelection(repoFilter.selected, e) &&
        inSet(typeFilter.selected, e.type) &&
        inSet(actorFilter.selected, e.actor) &&
        (authorExact === '' || e.actor === authorExact),
    );
  }, [
    data,
    cutoffMs,
    fundReposUnion,
    repoFilter.selected,
    typeFilter.selected,
    actorFilter.selected,
    authorExact,
  ]);

  const { set: setRepoSelection } = repoFilter;
  const { set: setActorSelection } = actorFilter;

  // Clicking a repo in a timeline row selects that exact host's activity by
  // storing the repoKey. Events always carry a repoKey so no fallback needed.
  const onSelectRepo = useCallback(
    (repoKey: string) => setRepoSelection(new Set([repoKey])),
    [setRepoSelection],
  );
  const onSelectActor = useCallback(
    (a: string) => setActorSelection(new Set([a])),
    [setActorSelection],
  );

  if (error) {
    return (
      <div className="p-6 text-red-400">
        <p>Failed to load events: {error}</p>
        <p className="text-zinc-500 text-sm mt-2">
          Run <code className="text-zinc-300">npm run fetch</code> first to populate{' '}
          <code className="text-zinc-300">public/data/events.json</code>.
        </p>
      </div>
    );
  }

  if (!data) {
    return <div className="p-6 text-zinc-500">loading...</div>;
  }

  const generated = new Date(data.generatedAt);
  const generatedLabel = isNaN(generated.getTime())
    ? 'never'
    : generated.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const totals = filtered.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});
  const fmt = (n: number) => n.toLocaleString();
  const statParts: string[] = [];
  const pushStat = (n: number, singular: string, plural = singular + 's') => {
    if (n > 0) statParts.push(`${fmt(n)} ${n === 1 ? singular : plural}`);
  };
  pushStat(totals.commit ?? 0, 'commit');
  pushStat(totals.pr_opened ?? 0, 'PR opened', 'PRs opened');
  pushStat(totals.pr_merged ?? 0, 'PR merged', 'PRs merged');
  pushStat(totals.pr_closed ?? 0, 'PR closed', 'PRs closed');
  pushStat(totals.issue_opened ?? 0, 'issue opened', 'issues opened');
  pushStat(totals.issue_closed ?? 0, 'issue closed', 'issues closed');
  pushStat(totals.release ?? 0, 'release');

  return (
    <div className="min-h-full">
      <div ref={filterBarRef} className="sm:sticky sm:top-0 z-10">
        <FilterBar
          repos={data.repos}
          funds={data.funds}
          repoIndex={repoIndex}
          fundFilter={fundFilter}
          repoFilter={repoFilter}
          typeFilter={typeFilter}
          actorFilter={actorFilter}
          windowOptions={WINDOW_OPTIONS}
          windowDays={windowDays}
          setWindowDays={setWindowDays}
          builtWindowDays={data.windowDays}
          authorQuery={authorQuery}
          setAuthorQuery={setAuthorQuery}
        />
      </div>
      <Timeline events={filtered} onSelectRepo={onSelectRepo} onSelectActor={onSelectActor} />
      <footer className="px-3 py-4 text-xs text-zinc-600 border-t border-zinc-900 space-y-1">
        <div>
          {fmt(filtered.length)} of {fmt(data.events.length)} events shown
          {statParts.length > 0 ? ': ' + statParts.join(', ') : ''}
        </div>
        <div>
          last fetched {generatedLabel} - window {windowDays}d (built {data.windowDays}d) -{' '}
          {data.repos.length} repo(s)
        </div>
        <div>
          repo missing?{' '}
          <a
            href="https://github.com/OpenSats/heartbeat"
            target="_blank"
            rel="noreferrer noopener"
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            create a PR
          </a>
        </div>
      </footer>
    </div>
  );
}
