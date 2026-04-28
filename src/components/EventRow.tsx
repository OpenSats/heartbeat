import type { Event } from '../types';
import { EVENT_TYPE_META } from '../eventTypes';

type Props = {
  event: Event;
  onSelectRepo?: (repo: string) => void;
  onSelectActor?: (actor: string) => void;
};

export function EventRow({ event, onSelectRepo, onSelectActor }: Props) {
  const meta = EVENT_TYPE_META[event.type];
  const time = event.timestamp.slice(11, 16);
  const repoShort = event.repo.split('/').pop() ?? event.repo;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 py-0.5 px-2 text-sm leading-6 hover:bg-zinc-900/60">
      <span className="text-zinc-600 tabular-nums shrink-0">{time}</span>
      <span className={`${meta.colorClass} shrink-0 w-4 text-center`} title={meta.label}>
        {meta.sigil}
      </span>
      <span className={`${meta.colorClass} shrink-0 tabular-nums truncate max-w-[8rem]`}>
        {event.shortId}
      </span>
      <button
        type="button"
        onClick={() => onSelectRepo?.(event.repo)}
        className="text-zinc-500 hover:text-zinc-300 transition-colors min-w-0 truncate max-w-[40vw] sm:max-w-[14rem] text-left cursor-pointer"
        title={`filter by ${event.repo}`}
      >
        <span className="sm:hidden">{repoShort}</span>
        <span className="hidden sm:inline">{event.repo}</span>
      </button>
      <button
        type="button"
        onClick={() => onSelectActor?.(event.actor)}
        className="hidden sm:inline text-emerald-300/80 hover:text-emerald-200 transition-colors shrink-0 truncate max-w-[10rem] text-left cursor-pointer"
        title={`filter by ${event.actor}`}
      >
        {event.actor}
      </button>
      <a
        href={event.url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-zinc-200 truncate min-w-0 basis-full pl-6 sm:basis-0 sm:flex-1 sm:pl-0"
        title={event.title}
      >
        {event.title}
      </a>
    </div>
  );
}
