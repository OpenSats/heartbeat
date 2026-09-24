import { useEffect, useMemo, useRef, useState } from 'react';
import { Timeline } from '../components/Timeline';
import type { TimelineEvent } from '../components/EventRow';
import { HeartPulseIcon } from '../components/HeartPulseIcon';
import { EVENT_TYPE_META } from '../eventTypes';
import { sourcesFromUrl, type Source, type SourceResult } from './model';

const initial = new URLSearchParams(window.location.search);
const hasSources = (params: URLSearchParams) => ['p', 'gh', 'repo'].some((key) => params.has(key));
const chipClass = (active = false) =>
  `px-2 py-1 sm:py-0.5 text-xs rounded border transition ${active ? 'border-zinc-500 bg-zinc-800 text-zinc-100' : 'border-zinc-800 bg-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'}`;
const inputClass = `${chipClass()} min-w-0 flex-1 max-w-md placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 focus:text-zinc-100`;
const short = (s: string) => (s.startsWith('npub') ? `${s.slice(0, 12)}…${s.slice(-6)}` : s);
const sourceColor = (source: Source) =>
  source.kind === 'nostr'
    ? 'text-violet-300'
    : source.kind === 'repo'
      ? 'text-amber-300'
      : 'text-emerald-300';

function SourceStatus({
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
        if (!controller.signal.aborted) {
          const message = (e as Error).message;
          setError(message);
          onResult(source.key, {
            source,
            snapshot: null,
            fetchedAt: null,
            refreshing: false,
            stale: true,
            error: message,
          });
        }
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
    <details className="text-xs text-zinc-600">
      <summary className="cursor-pointer hover:text-zinc-300 py-0.5">
        <span className="text-zinc-500">{source.kind}:</span>{' '}
        <span className={sourceColor(source)} title={source.label}>
          {short(source.label)}
        </span>{' '}
        <span className={status === 'unavailable' ? 'text-amber-400' : ''}>{status}</span>
        {result?.snapshot && <span> · {result.snapshot.events.length} events</span>}
        {source.kind === 'repo' && <span> · all contributors</span>}
      </summary>
      <div className="pl-4 py-1 space-y-1 max-w-3xl">
        {result?.snapshot && (
          <>
            <a href={result.snapshot.profileUrl} target="_blank" rel="noreferrer">
              open source ↗
            </a>
            <p>{result.snapshot.coverage}</p>
          </>
        )}
        {result?.fetchedAt && (
          <p>
            last fetched {new Date(result.fetchedAt).toISOString().replace('T', ' ').slice(0, 16)}{' '}
            UTC
          </p>
        )}
        {(error || result?.error) && <p className="text-amber-300">{error || result?.error}</p>}
      </div>
    </details>
  );
}

const heatColors = [
  'bg-zinc-900',
  'bg-emerald-950',
  'bg-emerald-800',
  'bg-emerald-600',
  'bg-emerald-400',
];
function Heatmap({
  dates,
  selected,
  onSelect,
  loading,
}: {
  dates: string[];
  selected: string;
  onSelect: (day: string) => void;
  loading: boolean;
}) {
  const counts = new Map<string, number>();
  for (const date of dates) counts.set(date, (counts.get(date) ?? 0) + 1);
  const today = new Date().toISOString().slice(0, 10);
  const end = Date.parse(`${today}T00:00:00Z`);
  const start = end - 89 * 86400000;
  const offset = new Date(start).getUTCDay();
  const cells = Array.from({ length: Math.ceil((90 + offset) / 7) * 7 }, (_, i) => {
    const time = start + (i - offset) * 86400000;
    return time < start || time > end ? null : new Date(time).toISOString().slice(0, 10);
  });
  return (
    <div className="px-3 py-3 border-b border-zinc-900 text-xs text-zinc-500">
      <div className="mb-2 flex items-center gap-3">
        <span>activity · last 90 days</span>
        {loading && <span className="text-zinc-600">loading sources...</span>}
        {selected && (
          <button onClick={() => onSelect('')} className="text-zinc-300">
            {selected} ×
          </button>
        )}
      </div>
      <div className="flex items-start gap-2 overflow-x-auto pb-1">
        <div className="grid grid-rows-7 gap-1 text-[10px] text-zinc-600 pt-5">
          {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((d, i) => (
            <span key={i} className="h-3.5 leading-3.5">
              {d}
            </span>
          ))}
        </div>
        <div>
          <div className="grid grid-flow-col auto-cols-[14px] gap-1 h-5 text-[10px] text-zinc-600">
            {Array.from({ length: cells.length / 7 }, (_, week) => {
              const date = cells
                .slice(week * 7, week * 7 + 7)
                .find((d) => d && (week === 0 || d.endsWith('-01')));
              return (
                <span key={week} className="overflow-visible">
                  {date
                    ? new Date(`${date}T00:00:00Z`).toLocaleString('en', {
                        month: 'short',
                        timeZone: 'UTC',
                      })
                    : ''}
                </span>
              );
            })}
          </div>
          <div className="grid grid-rows-7 grid-flow-col auto-cols-[14px] gap-1">
            {cells.map((day, i) => {
              if (!day) return <span key={i} className="h-3.5" />;
              const count = counts.get(day) ?? 0;
              const level = count === 0 ? 0 : count < 3 ? 1 : count < 6 ? 2 : count < 12 ? 3 : 4;
              const label = `${day}: ${count} fetched event${count === 1 ? '' : 's'}`;
              return (
                <button
                  key={day}
                  title={label}
                  aria-label={label}
                  aria-pressed={selected === day}
                  disabled={loading}
                  onClick={() => onSelect(selected === day ? '' : day)}
                  className={`h-3.5 w-3.5 rounded-[2px] ${loading ? 'bg-zinc-800 animate-pulse' : heatColors[level]} ${selected === day ? 'outline outline-1 outline-zinc-100' : 'hover:outline hover:outline-1 hover:outline-zinc-500'} focus-visible:outline focus-visible:outline-1 focus-visible:outline-white`}
                />
              );
            })}
          </div>
          <div className="flex items-center justify-end gap-1 mt-2 text-[10px] text-zinc-600">
            <span className="mr-1">less</span>
            {heatColors.map((color) => (
              <span key={color} className={`h-2.5 w-2.5 rounded-[2px] ${color}`} />
            ))}
            <span className="ml-1">more</span>
          </div>
        </div>
      </div>
      <p className="text-[10px] text-zinc-600 mt-2">
        Empty cells mean no fetched events. Source limits and relay coverage can leave gaps.
      </p>
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
  const [actor, setActor] = useState('');
  const [repo, setRepo] = useState('');
  const [day, setDay] = useState('');
  const [copied, setCopied] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const { sources, errors } = useMemo(() => sourcesFromUrl(params), [params]);
  const onResult = useMemo(
    () => (key: string, result: SourceResult) => setResults((prev) => ({ ...prev, [key]: result })),
    [],
  );
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const update = () =>
      document.documentElement.style.setProperty('--filter-bar-h', `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const pop = () => {
      const next = new URLSearchParams(location.search);
      setParams(next);
      setGh(next.getAll('gh').join(', '));
      setNpub(next.get('p') ?? '');
      setRepos(next.getAll('repo').join(', '));
      setActor('');
      setRepo('');
      setDay('');
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
      for (const event of results[source.key]?.snapshot?.events ?? [])
        if (!all.has(event.id)) all.set(event.id, { event, source });
    }
    return [...all.values()].sort((a, b) => b.event.timestamp.localeCompare(a.event.timestamp));
  }, [sources, results, filter]);
  const types = [...new Set(events.map(({ event }) => event.type))].sort();
  const filtered = events.filter(
    ({ event }) =>
      (kind === 'all' || event.type === kind) &&
      (!actor || event.actor === actor) &&
      (!repo || event.repo === repo) &&
      `${event.title} ${event.repo ?? ''} ${event.actor}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const visible = filtered.filter(({ event }) => !day || event.timestamp.startsWith(day));
  const timeline: TimelineEvent[] = visible.map(({ event, source }) => {
    const type =
      event.type === 'pull request'
        ? 'pr_opened'
        : event.type === 'issue'
          ? 'issue_opened'
          : event.type;
    const meta =
      type === 'post' || type === 'reply'
        ? { label: type, sigil: type === 'post' ? '+' : '↳', colorClass: 'text-violet-400' }
        : EVENT_TYPE_META[type as keyof typeof EVENT_TYPE_META];
    return {
      ...event,
      type,
      meta,
      repo: event.repo ?? 'nostr',
      shortId:
        type === 'commit'
          ? event.url.split('/').at(-1)!.slice(0, 7)
          : type === 'post' || type === 'reply'
            ? type
            : `#${event.url.split('/').at(-1)}`,
      context: source.kind === 'repo' ? 'Repository activity from all contributors' : undefined,
    };
  });
  const loading = sources.some((s) => !results[s.key]);
  const activeDays = new Set(filtered.map(({ event }) => event.timestamp.slice(0, 10))).size;
  const repoCount = new Set(filtered.map(({ event }) => event.repo).filter(Boolean)).size;
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
    setActor('');
    setRepo('');
    setDay('');
  }
  return (
    <div className="min-h-full">
      <div
        ref={barRef}
        className="sm:sticky sm:top-0 z-10 border-b border-zinc-900 bg-zinc-950/80 backdrop-blur px-3 py-2 space-y-2"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <a
              href="/"
              className="flex items-center gap-1.5"
              title="heartbeat"
              aria-label="heartbeat"
            >
              <HeartPulseIcon className="h-7 w-7 shrink-0 text-zinc-100" />
              <img
                src="https://dergigi.com/assets/images/avatar.jpg"
                alt=""
                className="h-7 w-7 shrink-0 rounded-full object-cover"
              />
            </a>
            <span className="text-xs text-zinc-500">/ pow</span>
          </div>
          <button
            className="text-xs text-zinc-500 hover:text-zinc-300"
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
            {copied ? 'copied' : 'copy link'}
          </button>
        </div>
        {!hasSources(params) && (
          <form onSubmit={submit} className="space-y-2">
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-600 text-xs shrink-0 w-14">npub:</span>
              <input
                className={inputClass}
                placeholder="npub1…"
                value={npub}
                onChange={(e) => setNpub(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-600 text-xs shrink-0 w-14">github:</span>
              <input
                className={inputClass}
                placeholder="handle"
                value={gh}
                onChange={(e) => setGh(e.target.value)}
                spellCheck={false}
              />
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              <label className="flex items-center gap-1.5 flex-1 max-w-[calc(28rem+62px)] min-w-48">
                <span className="text-zinc-600 text-xs shrink-0 w-14">repos:</span>
                <input
                  className={inputClass}
                  placeholder="owner/repo, owner/another-repo"
                  value={repos}
                  onChange={(e) => setRepos(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <button className={chipClass(true)}>load</button>
            </div>
          </form>
        )}
        {errors.map((error) => (
          <p role="alert" key={error} className="text-xs text-amber-300">
            {error}
          </p>
        ))}
        {sources.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-zinc-600 text-xs shrink-0 w-14">source:</span>
              {['all', 'github', 'nostr', 'repo'].map((value) => (
                <button
                  key={value}
                  className={chipClass(filter === value)}
                  onClick={() => {
                    setFilter(value);
                    setKind('all');
                  }}
                >
                  {value === 'repo' ? 'repos' : value}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-zinc-600 text-xs shrink-0 w-14">types:</span>
              {['all', ...types].map((value) => (
                <button
                  key={value}
                  className={chipClass(kind === value)}
                  onClick={() => setKind(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-600 text-xs shrink-0 w-14">filter:</span>
              <input
                className={`${inputClass} max-w-40`}
                placeholder="search activity"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {(actor || repo) && (
              <div className="flex flex-wrap gap-1.5">
                {actor && (
                  <button className={chipClass(true)} onClick={() => setActor('')}>
                    dev: {short(actor)} ×
                  </button>
                )}
                {repo && (
                  <button className={chipClass(true)} onClick={() => setRepo('')}>
                    repo: {repo} ×
                  </button>
                )}
              </div>
            )}
            <div>
              {sources.map((source) => (
                <SourceStatus key={source.key} source={source} onResult={onResult} />
              ))}
            </div>
          </>
        )}
      </div>
      {!!sources.length && (
        <Heatmap
          dates={filtered.map(({ event }) => event.timestamp.slice(0, 10))}
          selected={day}
          onSelect={setDay}
          loading={loading}
        />
      )}
      {!sources.length ? (
        <div className="text-zinc-500 px-2 py-8 text-sm">
          Enter a GitHub handle or npub to load activity.{' '}
          <a href="/pow?gh=dergigi" className="text-zinc-400">
            Try dergigi
          </a>
          .
        </div>
      ) : loading && !visible.length ? (
        <div className="text-zinc-500 px-2 py-8">loading...</div>
      ) : (
        <Timeline
          events={timeline}
          onSelectActor={setActor}
          onSelectRepo={(value) => {
            if (value !== 'nostr') setRepo(value);
          }}
        />
      )}
      <footer className="px-3 py-4 text-xs text-zinc-600 border-t border-zinc-900 space-y-1">
        <div>
          {visible.length} events · {activeDays} active days · {repoCount} repo(s)
        </div>
        <div>window 90d · cache 24h · timestamps UTC · {sources.length} source(s)</div>
      </footer>
    </div>
  );
}
