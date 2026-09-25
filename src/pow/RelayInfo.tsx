import { useEffect, useRef } from 'react';
import { latestRelayFetches, sourcePlatform, type Source, type SourceResult } from './model';

export function RelayInfo({
  sources,
  results,
}: {
  sources: Source[];
  results: Record<string, SourceResult>;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  const relaySources = sources.filter((source) => sourcePlatform(source) !== 'github');
  if (!relaySources.length) return null;
  const fetches = latestRelayFetches(
    relaySources.flatMap((source) => results[source.key]?.snapshot?.relayFetches ?? []),
  );
  return (
    <details ref={ref} className="relative">
      <summary
        className="list-none cursor-pointer p-1 text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden"
        aria-label="Cached relay information"
        title="Cached relay information"
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
          <circle cx="12" cy="12" r="2" />
          <path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4-8.4a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
        </svg>
      </summary>
      <div className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-7rem)] rounded border border-zinc-800 bg-zinc-950 p-3 shadow-xl text-xs">
        <h2 className="text-zinc-200">Cached relay fetches</h2>
        <ul className="mt-3 space-y-3 max-h-72 overflow-y-auto">
          {fetches.map((fetch) => {
            const status = fetch.status === 'complete' ? 'fetched' : fetch.status;
            return (
              <li key={fetch.url} title={fetch.url}>
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${fetch.status === 'complete' ? 'bg-emerald-500' : fetch.status === 'partial' ? 'bg-amber-500' : 'bg-zinc-600'}`}
                  />
                  <span className="truncate text-zinc-300">
                    {fetch.url.replace(/^wss:\/\//, '')}
                  </span>
                </div>
                <div className="ml-3.5 mt-0.5 text-zinc-500">
                  {status}
                  {fetch.status !== 'unavailable' &&
                    ` · ${fetch.eventCount.toLocaleString()} events`}
                </div>
                <time
                  className="ml-3.5 text-zinc-600"
                  dateTime={fetch.checkedAt}
                  title={fetch.checkedAt}
                >
                  {fetch.checkedAt.slice(0, 16).replace('T', ' ')} UTC
                </time>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
