import type { Event } from '../types';
import { EVENT_TYPE_META } from '../eventTypes';

type Props = { event: Event };

export function EventRow({ event }: Props) {
  const meta = EVENT_TYPE_META[event.type];
  const time = event.timestamp.slice(11, 16);
  return (
    <div className="flex gap-3 py-0.5 px-2 text-sm leading-6 hover:bg-zinc-900/60">
      <span className="text-zinc-600 tabular-nums shrink-0">{time}</span>
      <span className={`${meta.colorClass} shrink-0 w-4 text-center`} title={meta.label}>
        {meta.sigil}
      </span>
      <span className={`${meta.colorClass} shrink-0 tabular-nums`}>
        {event.shortId.padEnd(8, ' ')}
      </span>
      <span className="text-zinc-500 shrink-0 truncate max-w-[14rem]" title={event.repo}>
        {event.repo}
      </span>
      <span className="text-emerald-300/80 shrink-0 truncate max-w-[10rem]" title={event.actor}>
        {event.actor}
      </span>
      <a
        href={event.url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-zinc-200 truncate min-w-0 flex-1"
        title={event.title}
      >
        {event.title}
      </a>
    </div>
  );
}
