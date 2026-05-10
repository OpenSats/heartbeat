import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadEvents } from './lib/loadEvents';
import { useUrlSet } from './lib/useUrlSet';
import { useUrlString } from './lib/useUrlString';
import { filterEvents } from './lib/filterEvents';
import { Timeline } from './components/Timeline';
import { FilterBar } from './components/FilterBar';
import type { Dataset } from './types';

export function App() {
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groupFilter = useUrlSet('groups');
  const repoFilter = useUrlSet('repos');
  const typeFilter = useUrlSet('types');
  const actorFilter = useUrlSet('devs');
  const [repoQuery, setRepoQuery] = useUrlString('q');

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

  const groupReposUnion = useMemo(() => {
    const sel = groupFilter.selected;
    if (!data || !sel || sel.size === 0) return null;
    const out = new Set<string>();
    for (const group of sel) for (const repo of data.groups[group] ?? []) out.add(repo);
    return out;
  }, [data, groupFilter.selected]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return filterEvents(data.events, {
      groupRepos: groupReposUnion,
      repoSelection: repoFilter.selected,
      typeSelection: typeFilter.selected,
      actorSelection: actorFilter.selected,
      repoQuery,
    });
  }, [
    data,
    groupReposUnion,
    repoFilter.selected,
    typeFilter.selected,
    actorFilter.selected,
    repoQuery,
  ]);

  const { set: setRepoSelection } = repoFilter;
  const { set: setActorSelection } = actorFilter;
  const onSelectRepo = useCallback(
    (r: string) => setRepoSelection(new Set([r])),
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
          Run <code className="text-zinc-300">bun run fetch</code> first to populate{' '}
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

  const totals = data.events.reduce<Record<string, number>>((acc, e) => {
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
  const catalogStatus = data.catalog
    ? `${fmt(data.catalog.projectCount)} project(s) - ${fmt(data.catalog.skippedLinkCount)} skipped link(s) - ${fmt(data.catalog.emptyGroups.length)} empty group(s)`
    : null;

  return (
    <div className="min-h-full">
      <div ref={filterBarRef} className="sm:sticky sm:top-0 z-10">
        <FilterBar
          repos={data.repos}
          groups={data.groups}
          groupFilter={groupFilter}
          repoFilter={repoFilter}
          typeFilter={typeFilter}
          actorFilter={actorFilter}
          repoQuery={repoQuery}
          setRepoQuery={setRepoQuery}
        />
      </div>
      <Timeline events={filtered} onSelectRepo={onSelectRepo} onSelectActor={onSelectActor} />
      <footer className="px-3 py-4 text-xs text-zinc-600 border-t border-zinc-900 space-y-1">
        <div>
          {fmt(data.events.length)} events: {statParts.join(', ')}
        </div>
        <div>
          last fetched {generatedLabel} - window {data.windowDays}d - {data.repos.length} repo(s)
        </div>
        {catalogStatus && <div title={data.catalog?.source}>catalog {catalogStatus}</div>}
        <div>
          repo missing?{' '}
          <a
            href="https://github.com/soveng/heartbeat"
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
