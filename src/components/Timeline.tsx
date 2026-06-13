import { useEffect, useMemo, useRef, useState } from 'react';
import type { Event } from '../types';
import { EventRow } from './EventRow';

type Props = {
  events: Event[];
  onSelectRepo?: (repo: string) => void;
  onSelectActor?: (actor: string) => void;
};

// Render incrementally; more rows load as the bottom sentinel nears view.
const INITIAL_VISIBLE = 200;
const PAGE = 200;
const PREFETCH_MARGIN = '1200px 0px';

function groupByDay(events: Event[]): Array<[string, Event[]]> {
  const groups = new Map<string, Event[]>();
  for (const e of events) {
    const day = e.timestamp.slice(0, 10);
    let arr = groups.get(day);
    if (!arr) {
      arr = [];
      groups.set(day, arr);
    }
    arr.push(e);
  }
  return [...groups.entries()];
}

export function Timeline({ events, onSelectRepo, onSelectActor }: Props) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);

  // Reset paging during render when the filtered set changes.
  const [prevEvents, setPrevEvents] = useState(events);
  if (events !== prevEvents) {
    setPrevEvents(events);
    setVisibleCount(INITIAL_VISIBLE);
  }

  const visibleEvents = useMemo(
    () => (visibleCount >= events.length ? events : events.slice(0, visibleCount)),
    [events, visibleCount],
  );
  const groups = useMemo(() => groupByDay(visibleEvents), [visibleEvents]);

  const hasMore = visibleCount < events.length;
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Reconnect per page so intersection is re-evaluated until the sentinel clears.
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((c) => c + PAGE);
        }
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, visibleCount]);

  if (events.length === 0) {
    return <div className="text-zinc-500 px-2 py-8">No events match the current filters.</div>;
  }

  return (
    <div className="pb-12">
      {groups.map(([day, dayEvents]) => (
        <section key={day}>
          <div className="sticky top-0 sm:top-(--filter-bar-h) bg-zinc-950/95 backdrop-blur px-2 py-1 text-zinc-500 text-xs border-b border-zinc-900">
            {`---- ${day} ----`}
            <span className="ml-2 text-zinc-700">{dayEvents.length}</span>
          </div>
          <div>
            {dayEvents.map((e) => (
              <EventRow
                key={e.id}
                event={e}
                onSelectRepo={onSelectRepo}
                onSelectActor={onSelectActor}
              />
            ))}
          </div>
        </section>
      ))}
      {hasMore && <div ref={sentinelRef} className="h-px" aria-hidden="true" />}
    </div>
  );
}
