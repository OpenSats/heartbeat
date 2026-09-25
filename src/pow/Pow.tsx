import { useEffect, useMemo, useRef, useState } from 'react';
import { Timeline } from '../components/Timeline';
import type { TimelineEvent } from '../components/EventRow';
import { EVENT_TYPE_META } from '../eventTypes';
import { useSources } from './useSources';
import { powParams, powUrl } from './url';
import { useNip05Labels } from './useNip05Labels';
import { useAccountDiscovery, type DiscoveredAccount } from './useAccountDiscovery';
import {
  activityRange,
  sourcePlatform,
  isRepository,
  matchesSource,
  FIRST_HISTORY_YEAR,
  selectedYear,
  historyMonths,
  type Source,
  type SourceResult,
} from './model';

const typeGroups: Record<string, string> = {
  commit: 'commits',
  'pull request': 'PRs',
  patch: 'PRs',
  'PR update': 'PRs',
  issue: 'issues',
  'code comment': 'comments',
  comment: 'comments',
  review: 'reviews',
  repository: 'repo updates',
  'refs update': 'repo updates',
  post: 'posts',
  reply: 'replies',
};
const typeFilter = (type: string) =>
  type.startsWith('status: ') ? 'status changes' : (typeGroups[type] ?? type);

const currentYear = new Date().getUTCFullYear();
const years = Array.from(
  { length: currentYear - FIRST_HISTORY_YEAR + 1 },
  (_, i) => currentYear - i,
);
const initial = powParams(window.location.pathname, window.location.search);
const hasSources = (params: URLSearchParams) =>
  ['p', 'gh', 'ngit', 'repo'].some((key) => params.has(key));
const chipClass = (active = false) =>
  `px-2 py-1 sm:py-0.5 text-xs rounded border transition ${active ? 'border-zinc-500 bg-zinc-800 text-zinc-100' : 'border-zinc-800 bg-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'}`;
const inputClass = `${chipClass()} min-w-0 flex-1 max-w-md placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 focus:text-zinc-100`;
const short = (s: string) => (s.startsWith('npub') ? `${s.slice(0, 12)}…${s.slice(-6)}` : s);
const sourceColor = (source: Source) =>
  source.kind === 'nostr'
    ? 'text-violet-300'
    : isRepository(source) || source.kind === 'ngit'
      ? 'text-amber-300'
      : 'text-emerald-300';

function SourceStatus({
  year,
  source,
  displayLabel,
  onResult,
}: {
  year: number | null;
  source: Source;
  displayLabel: string;
  onResult: (key: string, result: SourceResult) => void;
}) {
  const [result, setResult] = useState<SourceResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const months = historyMonths(year);
    const chunks = new Map<string, SourceResult>();
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        controller.signal.addEventListener('abort', done, { once: true });
      });
    const publish = (running: boolean, message: string | null = null) => {
      if (controller.signal.aborted) return;
      const values = [...chunks.values()];
      const snapshots = values.flatMap((r) => (r.snapshot ? [r.snapshot] : []));
      const windows = snapshots.flatMap((snapshot) => snapshot.windows ?? []);
      const activities = new Map(
        snapshots.flatMap((snapshot) => snapshot.events.map((event) => [event.id, event] as const)),
      );
      const combined: SourceResult = {
        source,
        snapshot: snapshots.length
          ? {
              events: [...activities.values()],
              windows,
              profileUrl: snapshots[0].profileUrl.replace('https://njump.me/', 'https://njump.to/'),
              coverage: `${snapshots.length}/${months.length} months fetched. ${source.kind === 'nostr' ? 'Signed text notes from public relays. Relays can omit history, so empty days remain uncertain.' : sourcePlatform(source) === 'ngit' ? 'Signed patches, PRs, issues, code comments, status messages and repository updates. Ref updates are not individual commits. Relays may omit history or replace older state.' : 'Public commits, issues, PRs, comments, reviews and status changes. Cross-repository discovery and GitHub indexing can omit activity.'}${isRepository(source) ? ' Repository context includes all contributors.' : ''}${source.kind === 'grasp' ? ' Comments and status messages without repository tags may be missing.' : ''}`,
            }
          : null,
        fetchedAt:
          values
            .map((r) => r.fetchedAt)
            .filter((t): t is string => !!t)
            .sort()
            .at(-1) ?? null,
        refreshing: running,
        stale: values.some((r) => r.stale),
        error: message ?? values.find((r) => r.error)?.error ?? null,
        monthsLoaded: snapshots.length,
        monthsTotal: months.length,
      };
      setResult(combined);
      onResult(source.key, combined);
    };
    const fetchMonth = async (month: string) => {
      const query = new URLSearchParams({
        kind: source.kind,
        value: ['nostr', 'ngit'].includes(source.kind) ? source.label : source.value,
        month,
      });
      const response = await fetch(`/api/pow/source?${query}`, {
        signal: controller.signal,
        referrerPolicy: 'no-referrer',
      });
      const data = (await response.json()) as SourceResult;
      if (!response.ok) throw new Error(data.error ?? 'Unable to load source.');
      chunks.set(month, data);
      publish(chunks.size < months.length || [...chunks.values()].some((r) => r.refreshing));
    };
    const load = async () => {
      // Enqueue every month up front. Backfills then continue without this browser.
      const results = await Promise.allSettled(months.map(fetchMonth));
      if (controller.signal.aborted) return;
      const failed = results.find((r) => r.status === 'rejected');
      if (failed?.status === 'rejected') setError(String(failed.reason?.message ?? failed.reason));
      while (!controller.signal.aborted) {
        const pending = months.filter((month) => chunks.get(month)?.refreshing);
        if (!pending.length) break;
        await pause(10000);
        if (controller.signal.aborted) return;
        const polled = await Promise.allSettled(pending.map(fetchMonth));
        if (polled.some((r) => r.status === 'rejected')) {
          if (!controller.signal.aborted)
            setError('Unable to check progress. Background jobs will continue.');
          return;
        }
      }
      publish(false);
    };
    void load();
    return () => controller.abort();
  }, [source, onResult, year]);
  const status =
    error || (result?.error && !result.refreshing)
      ? 'unavailable'
      : !result
        ? 'fetching'
        : result.refreshing
          ? `backfilling ${result.monthsLoaded ?? 0}/${result.monthsTotal ?? 13} months`
          : result.stale
            ? 'stale'
            : 'cached';
  return (
    <details className="text-xs text-zinc-600">
      <summary className="cursor-pointer hover:text-zinc-300 py-0.5">
        <span className="text-zinc-500">{source.kind === 'grasp' ? 'ngit' : source.kind}:</span>{' '}
        <span className={sourceColor(source)} title={source.label}>
          {short(displayLabel)}
        </span>{' '}
        <span className={status === 'unavailable' ? 'text-amber-400' : ''}>{status}</span>
        {result?.snapshot && <span> · {result.snapshot.events.length} events</span>}
        {isRepository(source) && <span> · all contributors</span>}
      </summary>
      <div className="pl-4 py-1 space-y-1 max-w-3xl">
        {result?.snapshot && (
          <>
            <a href={result.snapshot.profileUrl} target="_blank" rel="noreferrer">
              open source ↗
            </a>
            <p>{result.snapshot.coverage}</p>
            {result.snapshot.windows?.map((window) => (
              <p key={window.from}>
                {window.from.slice(0, 7)}: {window.exhaustive ? 'pages fetched' : 'incomplete'}
                {window.basis === 'relay' ? ' · relay coverage only' : ''}
              </p>
            ))}
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

const heatmapSourceColors = {
  github: { color: 'emerald', label: 'GitHub' },
  nostr: { color: 'violet', label: 'Nostr' },
  ngit: { color: 'amber', label: 'ngit' },
} as const;
type HeatmapPlatform = keyof typeof heatmapSourceColors;

function blendedHeatColor(counts: Partial<Record<HeatmapPlatform, number>>, level: number) {
  const shade = [900, 950, 800, 600, 400][level];
  let color = 'var(--color-zinc-900)';
  let total = 0;
  for (const platform of Object.keys(heatmapSourceColors) as HeatmapPlatform[]) {
    const count = counts[platform] ?? 0;
    if (!count) continue;
    const next = `var(--color-${heatmapSourceColors[platform].color}-${shade})`;
    color = total
      ? `color-mix(in srgb, ${color} ${(total / (total + count)) * 100}%, ${next})`
      : next;
    total += count;
  }
  return color;
}

function Heatmap({
  year,
  platform,
  filteredView,
  dates,
  sourceDates = [],
  platforms = [],
  selected,
  onSelect,
  loading,
  coverage,
}: {
  year: number | null;
  platform: 'github' | 'nostr' | 'ngit' | 'combined';
  filteredView: boolean;
  dates: string[];
  sourceDates?: { date: string; platform: HeatmapPlatform }[];
  platforms?: readonly HeatmapPlatform[];
  selected: string;
  onSelect: (day: string) => void;
  loading: boolean;
  coverage: (day: string) => boolean;
}) {
  const heatColors =
    platform === 'combined'
      ? ['bg-zinc-900', 'bg-zinc-800', 'bg-zinc-600', 'bg-zinc-400', 'bg-zinc-200']
      : platform === 'github'
        ? ['bg-zinc-900', 'bg-emerald-950', 'bg-emerald-800', 'bg-emerald-600', 'bg-emerald-400']
        : platform === 'ngit'
          ? ['bg-zinc-900', 'bg-amber-950', 'bg-amber-800', 'bg-amber-600', 'bg-amber-400']
          : ['bg-zinc-900', 'bg-violet-950', 'bg-violet-800', 'bg-violet-600', 'bg-violet-400'];
  const counts = new Map<string, number>();
  for (const date of dates) counts.set(date, (counts.get(date) ?? 0) + 1);
  const sourceCounts = new Map<string, Partial<Record<HeatmapPlatform, number>>>();
  for (const { date, platform } of sourceDates) {
    const counts = sourceCounts.get(date) ?? {};
    counts[platform] = (counts[platform] ?? 0) + 1;
    sourceCounts.set(date, counts);
  }
  const range = activityRange(year);
  const today = range.to;
  const end = Date.parse(`${range.to}T00:00:00Z`);
  const start = Date.parse(`${range.from}T00:00:00Z`);
  const days = Math.round((end - start) / 86400000) + 1;
  const oldest = new Date(start).toISOString().slice(0, 10);
  const total = dates.filter((date) => date >= oldest && date <= today).length;
  const eventLabels = {
    github: 'GitHub events',
    nostr: 'Nostr posts and replies',
    ngit: 'ngit events',
  };
  const caption =
    platform === 'combined'
      ? new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(
          platforms.map((source) => {
            const count = sourceDates.filter(
              ({ date, platform }) => platform === source && date >= oldest && date <= today,
            ).length;
            return `${count.toLocaleString()} ${filteredView ? 'matching ' : ''}${eventLabels[source]}`;
          }),
        ) || '0 events'
      : `${total.toLocaleString()} ${filteredView ? 'matching ' : ''}${eventLabels[platform]}`;
  const offset = new Date(start).getUTCDay();
  const cells = Array.from({ length: Math.ceil((days + offset) / 7) * 7 }, (_, i) => {
    const time = start + (i - offset) * 86400000;
    return time < start || time > end ? null : new Date(time).toISOString().slice(0, 10);
  });
  return (
    <div className="px-3 py-3 border-b border-zinc-900 text-xs text-zinc-500">
      <div className="mb-2 flex items-center gap-3">
        <span
          className={
            platform === 'combined'
              ? 'text-zinc-300'
              : platform === 'github'
                ? 'text-emerald-400'
                : platform === 'ngit'
                  ? 'text-amber-400'
                  : 'text-violet-400'
          }
        >
          {caption} {year === null ? 'in the last year' : `in ${year}`}
        </span>
        {loading && <span className="text-zinc-600">backfilling...</span>}
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
              const complete = coverage(day);
              const breakdown =
                platform === 'combined'
                  ? Object.entries(sourceCounts.get(day) ?? {})
                      .map(
                        ([source, count]) =>
                          `${heatmapSourceColors[source as HeatmapPlatform].label}: ${count}`,
                      )
                      .join(', ')
                  : '';
              const label = `${day}: ${count} ${filteredView ? 'matching ' : ''}fetched event${count === 1 ? '' : 's'}.${breakdown ? ` ${breakdown}.` : ''} ${complete ? 'GitHub search pages fetched for this day.' : 'Coverage incomplete or uncertain.'}`;
              return (
                <button
                  key={day}
                  title={label}
                  aria-label={label}
                  aria-pressed={selected === day}
                  style={{
                    backgroundColor:
                      platform === 'combined'
                        ? blendedHeatColor(sourceCounts.get(day) ?? {}, level)
                        : undefined,
                    backgroundImage: !complete
                      ? 'repeating-linear-gradient(135deg, transparent 0 3px, #a1a1aa66 3px 4px)'
                      : undefined,
                  }}
                  onClick={() => onSelect(selected === day ? '' : day)}
                  className={`h-3.5 w-3.5 rounded-[2px] ${heatColors[level]} ${selected === day ? 'outline outline-1 outline-zinc-100' : 'hover:outline hover:outline-1 hover:outline-zinc-500'} focus-visible:outline focus-visible:outline-1 focus-visible:outline-white`}
                />
              );
            })}
          </div>
          <div className="flex items-center justify-end gap-1 mt-2 text-[10px] text-zinc-600">
            {platform === 'combined' && (
              <span className="mr-auto flex items-center gap-3">
                {(Object.keys(heatmapSourceColors) as HeatmapPlatform[]).map((source) => (
                  <span key={source} className="flex items-center gap-1">
                    <span
                      className="h-2.5 w-2.5 rounded-[2px]"
                      style={{
                        backgroundColor: `var(--color-${heatmapSourceColors[source].color}-400)`,
                      }}
                    />
                    {heatmapSourceColors[source].label}
                  </span>
                ))}
                <span title="Each source contributes to the color in proportion to its event count.">
                  mixed days blend
                </span>
              </span>
            )}
            <span className="mr-1">less</span>
            {heatColors.map((color) => (
              <span key={color} className={`h-2.5 w-2.5 rounded-[2px] ${color}`} />
            ))}
            <span className="ml-1">more</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Pow() {
  const [gh, setGh] = useState(initial.getAll('gh').join(', '));
  const [npub, setNpub] = useState(initial.get('p') ?? '');
  const [repos, setRepos] = useState(initial.getAll('repo').join(', '));
  const [params, setParams] = useState(initial);
  const [periodResults, setPeriodResults] = useState<Record<string, Record<string, SourceResult>>>(
    {},
  );
  const year = selectedYear(params.get('year'));
  const [yearCount, setYearCount] = useState(5);
  const visibleYears = years.slice(
    0,
    Math.max(yearCount, year === null ? 0 : currentYear - year + 1),
  );
  const periodKey = year === null ? 'recent' : String(year);
  const results = useMemo(() => periodResults[periodKey] ?? {}, [periodResults, periodKey]);
  const range = useMemo(() => activityRange(year), [year]);
  const [filter, setFilter] = useState('all');
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('');
  const [day, setDay] = useState('');
  const [copied, setCopied] = useState(false);
  const [combinedHeatmap, setCombinedHeatmap] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const { sources, errors, pending: resolving } = useSources(params);
  const addDiscoveredAccounts = useMemo(
    () => (accounts: DiscoveredAccount[]) => {
      const next = new URLSearchParams(params);
      let remaining = 8 - sources.length;
      let changed = false;
      for (const account of accounts) {
        const cost = account.parameter === 'p' ? 2 : 1;
        if (remaining < cost || next.getAll(account.parameter).includes(account.value)) continue;
        next.append(account.parameter, account.value);
        remaining -= cost;
        changed = true;
      }
      if (!changed) return;
      history.replaceState(null, '', powUrl(next, location.pathname));
      setParams(next);
      setNpub(next.get('p') ?? '');
      setGh(next.getAll('gh').join(', '));
    },
    [params, sources],
  );
  useAccountDiscovery(sources, addDiscoveredAccounts);
  const displayName = useNip05Labels(sources.map((source) => source.label.split('/')[0]));
  const onResult = useMemo(
    () => (key: string, result: SourceResult) =>
      setPeriodResults((prev) => ({ ...prev, [periodKey]: { ...prev[periodKey], [key]: result } })),
    [periodKey],
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
      const next = powParams(location.pathname, location.search);
      setParams(next);
      setGh(next.getAll('gh').join(', '));
      setNpub(next.get('p') ?? '');
      setRepos(next.getAll('repo').join(', '));
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
      if (!matchesSource(source, filter)) continue;
      for (const event of results[source.key]?.snapshot?.events ?? [])
        if (
          event.timestamp.slice(0, 10) >= range.from &&
          event.timestamp.slice(0, 10) <= range.to &&
          !all.has(event.id)
        )
          all.set(event.id, { event, source });
    }
    return [...all.values()].sort((a, b) => b.event.timestamp.localeCompare(a.event.timestamp));
  }, [sources, results, filter, range]);
  const types = [...new Set(events.map(({ event }) => typeFilter(event.type)))].sort();
  const filtered = events.filter(
    ({ event }) =>
      (kind === 'all' || typeFilter(event.type) === kind) &&
      (!repo || event.repo === repo) &&
      `${event.title} ${event.repo ?? ''} ${event.actor} ${displayName(event.actor)}`
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
        : (EVENT_TYPE_META[type as keyof typeof EVENT_TYPE_META] ?? {
            label: type,
            sigil:
              type === 'patch'
                ? '+'
                : type === 'refs update'
                  ? '↑'
                  : type === 'code comment'
                    ? '↳'
                    : '·',
            colorClass: sourcePlatform(source) === 'github' ? 'text-emerald-400' : 'text-amber-400',
          });
    return {
      ...event,
      title:
        typeFilter(event.type) === 'status changes' && event.title !== event.type
          ? `${event.type} · ${event.title}`
          : event.title,
      actorLabel: displayName(event.actor),
      url: event.url.replace('https://njump.me/', 'https://njump.to/'),
      type,
      meta,
      repo: event.repo ?? sourcePlatform(source),
      shortId:
        sourcePlatform(source) === 'ngit'
          ? event.id.slice(0, 8)
          : type === 'commit'
            ? event.url.split('/').at(-1)!.slice(0, 7)
            : type === 'post' || type === 'reply'
              ? type
              : `#${event.url.split('/').at(-1)}`,
      context: isRepository(source) ? 'Repository activity from all contributors' : undefined,
    };
  });
  const loading = sources.some((s) => !results[s.key] || results[s.key].refreshing);
  const coverage = (date: string, platform: 'github' | 'nostr' | 'ngit') => {
    const relevant = sources.filter(
      (s) => sourcePlatform(s) === platform && matchesSource(s, filter),
    );
    const from = Date.parse(`${date}T00:00:00Z`);
    const to = from + 86400000 - 1;
    return (
      relevant.length > 0 &&
      relevant.every(
        (s) =>
          sourcePlatform(s) === 'github' &&
          results[s.key]?.snapshot?.windows?.some(
            (w) =>
              w.exhaustive &&
              !w.discoveryLimited &&
              Date.parse(w.from) <= from &&
              Date.parse(w.to) >= to,
          ),
      )
    );
  };
  const heatmapPlatforms = (['github', 'nostr', 'ngit'] as const).filter(
    (platform) =>
      sources.some(
        (source) => sourcePlatform(source) === platform && matchesSource(source, filter),
      ) &&
      (kind === 'all' ||
        events.some(
          ({ event, source }) =>
            sourcePlatform(source) === platform && typeFilter(event.type) === kind,
        )),
  );
  const heatmapSources = sources.filter(
    (source) => matchesSource(source, filter) && heatmapPlatforms.includes(sourcePlatform(source)),
  );
  const activeDays = new Set(filtered.map(({ event }) => event.timestamp.slice(0, 10))).size;
  const repoCount = new Set(filtered.map(({ event }) => event.repo).filter(Boolean)).size;
  function selectYear(value: number | null) {
    const next = new URLSearchParams(params);
    if (value === null) next.delete('year');
    else next.set('year', String(value));
    history.pushState(null, '', powUrl(next, location.pathname));
    setParams(next);
    setDay('');
    setKind('all');
    setRepo('');
    setQuery('');
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams();
    if (year !== null) next.set('year', String(year));
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
    history.pushState(null, '', powUrl(next, location.pathname));
    setParams(next);
    setFilter('all');
    setKind('all');
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
          <h1 className="flex items-center text-zinc-100 text-base font-medium">
            <a href="/" className="flex items-center gap-1.5" title="heartbeat">
              <img
                src={`${import.meta.env.BASE_URL}opensats-mark.svg`}
                alt=""
                className="h-7 w-7 shrink-0 filter-[brightness(0)_invert(1)]"
              />
              <span>heartbeat</span>
            </a>
            <a href="/pow" title="PoW landing page">
              /pow
            </a>
          </h1>
          <div className="flex items-center gap-3">
            <button
              className="p-1 text-zinc-500 hover:text-zinc-300"
              aria-label={copied ? 'Link copied' : 'Copy link'}
              title={copied ? 'Link copied' : 'Copy link'}
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
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {copied ? (
                  <path d="m5 12 4 4L19 6" />
                ) : (
                  <>
                    <rect x="8" y="8" width="12" height="12" rx="2" />
                    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                  </>
                )}
              </svg>
            </button>
            <a
              href="https://opensats.org"
              target="_blank"
              rel="noreferrer noopener"
              className="text-zinc-600 hover:text-zinc-300 text-xs transition-colors"
            >
              by OpenSats
            </a>
          </div>
        </div>
        {!hasSources(params) && (
          <form onSubmit={submit} className="space-y-2">
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-600 text-xs shrink-0 w-14">nostr:</span>
              <input
                className={inputClass}
                placeholder="npub1…, domain, or name@domain"
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
                  placeholder="owner/repo, nostr://npub/repo, ngit repository URL"
                  value={repos}
                  onChange={(e) => setRepos(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <button className={chipClass(true)}>load</button>
            </div>
          </form>
        )}
        {resolving.map((address) => (
          <p key={address} role="status" className="text-xs text-zinc-500">
            resolving {address}...
          </p>
        ))}
        {errors.map((error) => (
          <p role="alert" key={error} className="text-xs text-amber-300">
            {error}
          </p>
        ))}
        {sources.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-zinc-600 text-xs shrink-0 w-14">source:</span>
              {['all', 'github', 'nostr', 'ngit', 'repo'].map((value) => (
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
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Activity year"
            >
              <span className="text-zinc-600 text-xs shrink-0 w-14">year:</span>
              <button
                aria-pressed={year === null}
                className={chipClass(year === null)}
                onClick={() => selectYear(null)}
              >
                last 365 days
              </button>
              {visibleYears.map((value) => (
                <button
                  key={value}
                  aria-pressed={year === value}
                  className={chipClass(year === value)}
                  onClick={() => selectYear(value)}
                >
                  {value}
                </button>
              ))}
              {visibleYears.length < years.length && (
                <button
                  className={chipClass()}
                  onClick={() => setYearCount(Math.min(years.length, visibleYears.length + 5))}
                >
                  older years
                </button>
              )}
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
            {repo && (
              <div className="flex flex-wrap gap-1.5">
                {repo && (
                  <button className={chipClass(true)} onClick={() => setRepo('')}>
                    repo: {repo} ×
                  </button>
                )}
              </div>
            )}
            <div>
              {sources.map((source) => (
                <SourceStatus
                  key={`${periodKey}:${source.key}`}
                  year={year}
                  source={source}
                  displayLabel={displayName(source.label)}
                  onResult={onResult}
                />
              ))}
            </div>
          </>
        )}
      </div>
      {!!sources.length && (
        <div className="w-full">
          <div
            className="flex items-center gap-1.5 px-3 py-2 border-b border-zinc-900"
            role="group"
            aria-label="Heatmap layout"
          >
            <span className="text-zinc-600 text-xs">heatmap:</span>
            {(['separate', 'combined'] as const).map((layout) => (
              <button
                key={layout}
                className={chipClass(combinedHeatmap === (layout === 'combined'))}
                aria-pressed={combinedHeatmap === (layout === 'combined')}
                onClick={() => setCombinedHeatmap(layout === 'combined')}
              >
                {layout}
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 w-full">
            {combinedHeatmap ? (
              <Heatmap
                year={year}
                platform="combined"
                platforms={heatmapPlatforms}
                filteredView={kind !== 'all' || !!query || !!repo}
                dates={filtered.map(({ event }) => event.timestamp.slice(0, 10))}
                sourceDates={filtered.map(({ event, source }) => ({
                  date: event.timestamp.slice(0, 10),
                  platform: sourcePlatform(source),
                }))}
                selected={day}
                onSelect={setDay}
                loading={heatmapSources.some(
                  (source) => !results[source.key] || results[source.key].refreshing,
                )}
                coverage={(date) =>
                  heatmapPlatforms.length > 0 &&
                  heatmapPlatforms.every((platform) => coverage(date, platform))
                }
              />
            ) : (
              heatmapPlatforms.map((platform) => {
                const platformSources = sources.filter(
                  (source) => sourcePlatform(source) === platform && matchesSource(source, filter),
                );
                const activity = filtered.filter(
                  ({ source }) => sourcePlatform(source) === platform,
                );
                return (
                  <Heatmap
                    key={platform}
                    year={year}
                    platform={platform}
                    filteredView={kind !== 'all' || !!query || !!repo}
                    dates={activity.map(({ event }) => event.timestamp.slice(0, 10))}
                    selected={filter === platform || filter === 'repo' ? day : ''}
                    onSelect={(date) => {
                      setDay(date);
                      if (date && filter !== 'repo') setFilter(platform);
                    }}
                    loading={platformSources.some(
                      (source) => !results[source.key] || results[source.key].refreshing,
                    )}
                    coverage={(date) => coverage(date, platform)}
                  />
                );
              })
            )}
          </div>
          <p className="px-3 py-2 text-[10px] text-zinc-600 border-b border-zinc-900">
            {heatmapPlatforms.some((platform) => platform !== 'github')
              ? 'Striped cells reflect incomplete or uncertain relay coverage. An empty day does not confirm inactivity.'
              : 'Striped cells have incomplete history or uncertain discovery. An empty day does not confirm inactivity.'}
          </p>
        </div>
      )}
      {!sources.length && resolving.length ? (
        <div className="text-zinc-500 px-2 py-8">Resolving Nostr address...</div>
      ) : !sources.length ? (
        <div className="text-zinc-500 px-2 py-8 text-sm">
          Enter a GitHub handle, npub, or NIP-05 address to load activity.{' '}
          <a href="/pow/dergigi" className="text-zinc-400">
            Try dergigi
          </a>
          .
        </div>
      ) : loading && !visible.length ? (
        <div className="text-zinc-500 px-2 py-8">loading...</div>
      ) : (
        <Timeline
          events={timeline}
          onSelectRepo={(value) => {
            if (!['nostr', 'ngit'].includes(value)) setRepo(value);
          }}
        />
      )}
      <footer className="px-3 py-4 text-xs text-zinc-600 border-t border-zinc-900 space-y-1">
        <div>
          {visible.length} events · {activeDays} active days · {repoCount} repo(s)
        </div>
        <div>
          {year === null ? 'window 365d' : `year ${year}`} · recent cache 24h · history cached
          indefinitely · timestamps UTC · {sources.length} source(s)
        </div>
      </footer>
    </div>
  );
}
