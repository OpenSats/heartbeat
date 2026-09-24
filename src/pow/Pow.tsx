import { useEffect, useMemo, useState } from 'react';
import { sourcesFromUrl, type Source, type SourceResult } from './model';

const initial = new URLSearchParams(window.location.search);
const inputClass =
  'w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none focus:border-emerald-500 placeholder:text-zinc-700';
const short = (s: string) => (s.startsWith('npub') ? `${s.slice(0, 12)}…${s.slice(-6)}` : s);
const sourceColor = (s: Source) =>
  s.kind === 'nostr'
    ? 'text-violet-300'
    : s.kind === 'repo'
      ? 'text-amber-300'
      : 'text-emerald-300';

function SourceCard({
  source,
  onResult,
}: {
  source: Source;
  onResult: (key: string, result: SourceResult) => void;
}) {
  const [result, setResult] = useState<SourceResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;
    const load = async () => {
      try {
        const query = new URLSearchParams({
          kind: source.kind,
          value: source.kind === 'nostr' ? source.label : source.value,
        });
        const response = await fetch(`/api/pow/source?${query}`, {
          signal: controller.signal,
          referrerPolicy: 'no-referrer',
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Unable to load source.');
        setResult(data);
        onResult(source.key, data);
        if (data.refreshing && polls++ < 20) timer = setTimeout(load, 3000);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [source, onResult]);
  const status =
    error || result?.error
      ? 'unavailable'
      : !result
        ? 'fetching'
        : result.refreshing
          ? 'refreshing'
          : result.stale
            ? 'stale'
            : 'cached';
  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/30 p-4 min-w-0">
      <div className="flex justify-between gap-3 text-[10px] uppercase tracking-widest text-zinc-500">
        <span>{source.kind === 'repo' ? 'repository context' : source.kind}</span>
        <span className={status === 'cached' ? 'text-emerald-500' : 'text-amber-400'}>
          ● {status}
        </span>
      </div>
      <div className={`my-3 truncate text-sm ${sourceColor(source)}`} title={source.label}>
        {result?.snapshot ? (
          <a href={result.snapshot.profileUrl} target="_blank" rel="noreferrer">
            {short(source.label)} ↗
          </a>
        ) : (
          short(source.label)
        )}
      </div>
      <div className="text-xs text-zinc-500">
        {result?.snapshot
          ? `${result.snapshot.events.length} activities`
          : 'Looking for public activity…'}
      </div>
      {result?.fetchedAt && (
        <div className="mt-2 text-[10px] text-zinc-600">
          Fetched {new Date(result.fetchedAt).toLocaleString()}
        </div>
      )}
      {(error || result?.error) && (
        <p className="mt-3 text-xs text-amber-300">{error || result?.error}</p>
      )}
      {result?.snapshot && (
        <details className="mt-3 text-[11px] text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-300">Coverage</summary>
          <p className="mt-2 leading-relaxed">{result.snapshot.coverage}</p>
        </details>
      )}
    </div>
  );
}

export function Pow() {
  const [gh, setGh] = useState(initial.getAll('gh').join(', '));
  const [npub, setNpub] = useState(initial.get('p') ?? '');
  const [repos, setRepos] = useState(initial.getAll('repo').join(', '));
  const [params, setParams] = useState(initial);
  const [results, setResults] = useState<Record<string, SourceResult>>({});
  const [filter, setFilter] = useState('all');
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const { sources, errors } = useMemo(() => sourcesFromUrl(params), [params]);
  // Stable callback prevents source requests from restarting when another source finishes.
  const onResult = useMemo(
    () => (key: string, result: SourceResult) => setResults((prev) => ({ ...prev, [key]: result })),
    [],
  );
  useEffect(() => {
    const pop = () => {
      const next = new URLSearchParams(location.search);
      setParams(next);
      setGh(next.getAll('gh').join(', '));
      setNpub(next.get('p') ?? '');
      setRepos(next.getAll('repo').join(', '));
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  const events = useMemo(() => {
    const all = new Map<
      string,
      { event: NonNullable<SourceResult['snapshot']>['events'][number]; source: Source }
    >();
    for (const source of sources) {
      if (filter !== 'all' && source.kind !== filter) continue;
      for (const event of results[source.key]?.snapshot?.events ?? []) {
        if (!all.has(event.id)) all.set(event.id, { event, source });
      }
    }
    return [...all.values()].sort((a, b) => b.event.timestamp.localeCompare(a.event.timestamp));
  }, [sources, results, filter]);
  const types = [...new Set(events.map(({ event }) => event.type))].sort();
  const visible = events.filter(
    ({ event }) =>
      (kind === 'all' || event.type === kind) &&
      `${event.title} ${event.repo ?? ''} ${event.actor}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const groups = new Map<string, typeof visible>();
  for (const entry of visible) {
    const date = entry.event.timestamp.slice(0, 10);
    groups.set(date, [...(groups.get(date) ?? []), entry]);
  }
  const loaded = sources.filter((s) => results[s.key]).length;
  const activeDays = new Set(events.map(({ event }) => event.timestamp.slice(0, 10))).size;
  const repoCount = new Set(events.map(({ event }) => event.repo).filter(Boolean)).size;
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams();
    if (npub.trim()) next.set('p', npub.trim());
    for (const value of gh
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean))
      next.append('gh', value);
    for (const value of repos
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean))
      next.append('repo', value);
    history.pushState(null, '', `/pow${next.size ? `?${next}` : ''}`);
    setParams(next);
    setFilter('all');
    setKind('all');
  }
  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-900 px-5 sm:px-10 py-4 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2 text-sm">
          <span className="text-emerald-400">♥</span> heartbeat{' '}
          <span className="text-zinc-600">/</span> <span className="text-zinc-400">pow</span>
        </a>
        <span className="text-[10px] tracking-widest uppercase text-zinc-600">
          public activity explorer
        </span>
      </header>
      <main className="mx-auto max-w-6xl px-5 sm:px-10 py-10">
        <div className="mb-8">
          <div className="text-[10px] tracking-[0.25em] uppercase text-emerald-500 mb-3">
            Proof of work
          </div>
          <h1 className="text-3xl sm:text-4xl tracking-tight text-zinc-100">Follow the work.</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-500">
            One timeline across GitHub and Nostr. Bring the accounts; explore the public activity.
          </p>
        </div>
        <form onSubmit={submit} className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-5">
          <div className="grid md:grid-cols-2 gap-4">
            <label className="space-y-2">
              <span className="text-xs text-zinc-400">Nostr npub</span>
              <input
                className={inputClass}
                placeholder="npub1…"
                value={npub}
                onChange={(e) => setNpub(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="space-y-2">
              <span className="text-xs text-zinc-400">GitHub account</span>
              <input
                className={inputClass}
                placeholder="dergigi"
                value={gh}
                onChange={(e) => setGh(e.target.value)}
                spellCheck={false}
              />
            </label>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-end gap-4 mt-4">
            <label className="space-y-2 flex-1">
              <span className="text-xs text-zinc-400">
                Additional GitHub repositories{' '}
                <span className="text-zinc-600">· optional, comma-separated</span>
              </span>
              <input
                className={inputClass}
                placeholder="owner/repo, https://github.com/owner/repo"
                value={repos}
                onChange={(e) => setRepos(e.target.value)}
                spellCheck={false}
              />
            </label>
            <button className="rounded-md bg-emerald-400 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-300 transition-colors">
              Explore activity →
            </button>
          </div>
          <p className="mt-4 text-[11px] leading-5 text-zinc-600">
            Accounts are combined only in this URL. Each source is cached independently; no person
            profile is saved.
          </p>
        </form>
        {errors.map((error) => (
          <p role="alert" key={error} className="mt-3 text-xs text-amber-300">
            {error}
          </p>
        ))}
        {!sources.length ? (
          <div className="border border-dashed border-zinc-800 rounded-xl mt-8 px-6 py-16 text-center">
            <span className="text-emerald-500 text-2xl">⌁</span>
            <h2 className="mt-4 text-zinc-300">Start with an account.</h2>
            <p className="text-sm text-zinc-600 mt-2">
              Add a GitHub handle or npub above to see recent work.
            </p>
            <a href="/pow?gh=dergigi" className="inline-block mt-6 text-xs text-emerald-400">
              Try dergigi on GitHub →
            </a>
          </div>
        ) : (
          <>
            <div className="flex justify-between items-center mt-9 mb-4">
              <h2 className="text-xs uppercase tracking-widest text-zinc-500">
                Sources <span className="text-zinc-700">/ {sources.length}</span>
              </h2>
              <button
                className="text-xs text-zinc-400 hover:text-emerald-300"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(location.href)
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    })
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? 'Copied ✓' : 'Copy view link ↗'}
              </button>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {sources.map((source) => (
                <SourceCard key={source.key} source={source} onResult={onResult} />
              ))}
            </div>
            <div className="flex gap-8 sm:gap-14 py-8 my-2 border-b border-zinc-900">
              {[
                [events.length, 'activities'],
                [activeDays, 'active days'],
                [repoCount, 'repositories'],
              ].map(([number, label]) => (
                <div key={label}>
                  <div className="text-2xl text-zinc-200">{number}</div>
                  <div className="text-[10px] uppercase tracking-widest text-zinc-600 mt-1">
                    {label}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 py-4">
              <h2 className="text-sm text-zinc-300 mr-auto">
                Activity <span className="text-zinc-600">/{visible.length}</span>
              </h2>
              {['all', 'github', 'nostr', 'repo'].map((value) => (
                <button
                  key={value}
                  onClick={() => {
                    setFilter(value);
                    setKind('all');
                  }}
                  className={`rounded px-2 py-1 text-xs border ${filter === value ? 'border-zinc-600 text-zinc-100 bg-zinc-800' : 'border-zinc-900 text-zinc-500'}`}
                >
                  {value === 'repo' ? 'repositories' : value}
                </button>
              ))}
              <select
                aria-label="Activity type"
                className="bg-zinc-950 text-xs border border-zinc-800 rounded p-1.5 text-zinc-400"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="all">All types</option>
                {types.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <input
                aria-label="Search activity"
                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs w-36 outline-none focus:border-zinc-500"
                placeholder="Search activity"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {!visible.length && (
              <p className="py-12 text-sm text-zinc-500 text-center">
                {loaded < sources.length
                  ? 'Fetching source activity…'
                  : 'No activity matches this view. Check source coverage above.'}
              </p>
            )}
            {[...groups].map(([date, entries]) => (
              <section key={date}>
                <div className="sticky top-0 bg-zinc-950/95 backdrop-blur border-y border-zinc-900 py-2 text-xs text-zinc-500 z-10">
                  {date} <span className="text-zinc-700 ml-2">{entries.length}</span>
                </div>
                {entries.map(({ event, source }) => (
                  <article
                    key={event.id}
                    className="group grid grid-cols-[60px_1fr] sm:grid-cols-[60px_100px_1fr] gap-3 py-4 border-b border-zinc-900/60 hover:bg-zinc-900/30"
                  >
                    <time className="text-xs text-zinc-600 pt-0.5">
                      {event.timestamp.slice(11, 16)}
                    </time>
                    <div className={`hidden sm:block text-[11px] pt-0.5 ${sourceColor(source)}`}>
                      {event.type}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-2 text-[10px] text-zinc-600 mb-1.5">
                        <span className={sourceColor(source)}>
                          {source.kind} · {short(event.actor)}
                        </span>
                        {event.repo && <span>{event.repo}</span>}
                        {source.kind === 'repo' && (
                          <span className="text-amber-500/70">all contributors</span>
                        )}
                        <span className="sm:hidden">{event.type}</span>
                      </div>
                      <a
                        href={event.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block text-sm text-zinc-300 hover:text-zinc-100 whitespace-pre-wrap break-words leading-6 line-clamp-5"
                      >
                        {event.title || '(empty note)'}
                      </a>
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </>
        )}
        <footer className="mt-12 border-t border-zinc-900 pt-5 text-[10px] leading-5 text-zinc-600 flex flex-wrap justify-between gap-3">
          <span>heartbeat / pow · public evidence, original sources</span>
          <span>90-day snapshots · cached for 24 hours · timestamps in UTC</span>
        </footer>
      </main>
    </div>
  );
}
