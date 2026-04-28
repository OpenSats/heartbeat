import { useEffect, useMemo, useState } from 'react';
import { loadEvents } from './lib/loadEvents';
import { useUrlSet } from './lib/useUrlSet';
import { Timeline } from './components/Timeline';
import { FilterBar } from './components/FilterBar';
import type { Dataset } from './types';

export function App() {
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fundFilter = useUrlSet('funds');
  const repoFilter = useUrlSet('repos');
  const typeFilter = useUrlSet('types');
  const actorFilter = useUrlSet('actors');

  useEffect(() => {
    loadEvents()
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, []);

  const fundReposUnion = useMemo(() => {
    const sel = fundFilter.selected;
    if (!data || !sel || sel.size === 0) return null;
    const out = new Set<string>();
    for (const f of sel) for (const r of data.funds[f] ?? []) out.add(r);
    return out;
  }, [data, fundFilter.selected]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const inSet = (s: Set<string> | null, v: string) => !s || s.size === 0 || s.has(v);
    return data.events.filter(
      (e) =>
        (!fundReposUnion || fundReposUnion.has(e.repo)) &&
        inSet(repoFilter.selected, e.repo) &&
        inSet(typeFilter.selected, e.type) &&
        inSet(actorFilter.selected, e.actor),
    );
  }, [data, fundReposUnion, repoFilter.selected, typeFilter.selected, actorFilter.selected]);

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

  return (
    <div className="min-h-full">
      <div className="sm:sticky sm:top-0 z-10">
        <FilterBar
          repos={data.repos}
          funds={data.funds}
          fundFilter={fundFilter}
          repoFilter={repoFilter}
          typeFilter={typeFilter}
          actorFilter={actorFilter}
        />
      </div>
      <Timeline
        events={filtered}
        onSelectRepo={(r) => repoFilter.set(new Set([r]))}
        onSelectActor={(a) => actorFilter.set(new Set([a]))}
      />
      <footer className="px-3 py-4 text-xs text-zinc-600 border-t border-zinc-900">
        last fetched {generatedLabel} - window {data.windowDays}d - {data.repos.length} repo(s)
      </footer>
    </div>
  );
}
