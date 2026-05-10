import { memo } from 'react';
import type { Event } from '../types';
import { EVENT_TYPE_META } from '../eventTypes';
import { RepoLabel } from './RepoLabel';

type Props = {
  event: Event;
  onSelectRepo?: (repoKey: string) => void;
  onSelectActor?: (actor: string) => void;
};

const FILTER_BUTTON_BASE = 'transition-colors truncate text-left cursor-pointer';

export const EventRow = memo(EventRowImpl);

function EventRowImpl({ event, onSelectRepo, onSelectActor }: Props) {
  const meta = EVENT_TYPE_META[event.type];
  const time = event.timestamp.slice(11, 16);

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 py-1 sm:py-0.5 px-2 text-sm leading-6 hover:bg-zinc-900/60">
      <span className="text-zinc-600 tabular-nums shrink-0">{time}</span>
      <span className={`${meta.colorClass} shrink-0 w-4 text-center`} title={meta.label}>
        {meta.sigil}
      </span>
      <a
        href={event.url}
        target="_blank"
        rel="noreferrer noopener"
        title={event.shortId}
        className={`${meta.colorClass} shrink-0 tabular-nums truncate max-w-[8rem] hover:underline ${event.type === 'commit' ? 'hidden sm:inline' : ''}`}
      >
        {event.shortId}
      </a>
      <button
        type="button"
        onClick={() => onSelectRepo?.(event.repoKey)}
        title={`filter by ${event.repo}`}
        className={`${FILTER_BUTTON_BASE} text-zinc-300 sm:text-zinc-500 hover:text-zinc-300 min-w-0 max-w-[40vw] sm:max-w-[14rem]`}
      >
        <RepoLabel repo={event.repo} />
      </button>
      <button
        type="button"
        onClick={() => onSelectActor?.(event.actor)}
        title={`filter by ${event.actor}`}
        className={`${FILTER_BUTTON_BASE} text-emerald-300/80 hover:text-emerald-200 min-w-0 max-w-[8rem] sm:max-w-[10rem]`}
      >
        {event.actor}
      </button>
      <a
        href={event.url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-zinc-500 sm:text-zinc-200 truncate min-w-0 basis-full pl-2 sm:basis-0 sm:flex-1 sm:pl-0"
        title={event.title}
      >
        <span className="sm:hidden text-zinc-700 mr-1" aria-hidden="true">
          └─
        </span>
        {event.title}
      </a>
    </div>
  );
}
