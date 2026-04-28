import { useMemo } from 'react';
import type { Event } from '../types';
import { EventRow } from './EventRow';

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
  const groups = useMemo(() => groupByDay(events), [events]);

  if (events.length === 0) {
    return <div className="text-zinc-500 px-2 py-8">No events match the current filters.</div>;
  }

  return (
    <div className="pb-12">
      {groups.map(([day, dayEvents]) => (
        <section key={day}>
          <div className="sticky top-0 bg-zinc-950/95 backdrop-blur px-2 py-1 text-zinc-500 text-xs border-b border-zinc-900">
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
    </div>
  );
}
