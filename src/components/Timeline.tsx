import { useMemo, useState } from 'react';
import type { Event } from '../types';
import { EventRow } from './EventRow';

export const INITIAL_VISIBLE_EVENTS = 500;
const VISIBLE_EVENT_STEP = 500;

type Props = {
  events: Event[];
  onSelectRepo?: (repo: string) => void;
  onSelectActor?: (actor: string) => void;
};

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
  const [expanded, setExpanded] = useState<{ events: Event[]; visibleCount: number } | null>(null);
  const visibleCount = expanded?.events === events ? expanded.visibleCount : INITIAL_VISIBLE_EVENTS;

  const visibleEvents = useMemo(() => events.slice(0, visibleCount), [events, visibleCount]);
  const groups = useMemo(() => groupByDay(visibleEvents), [visibleEvents]);
  const hiddenCount = events.length - visibleEvents.length;

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
      {hiddenCount > 0 && (
        <div className="px-2 py-4 text-xs text-zinc-600">
          <button
            type="button"
            onClick={() =>
              setExpanded({
                events,
                visibleCount: Math.min(visibleCount + VISIBLE_EVENT_STEP, events.length),
              })
            }
            className="border border-zinc-800 px-2 py-1 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition"
          >
            show {Math.min(VISIBLE_EVENT_STEP, hiddenCount).toLocaleString()} more
          </button>
          <span className="ml-2">
            {visibleEvents.length.toLocaleString()} of {events.length.toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}
