import { memo } from 'react';
import type { Event } from '../types';
import { EVENT_TYPE_META } from '../eventTypes';

type Props = {
  event: Event;
  onSelectRepo?: (repo: string) => void;
  onSelectActor?: (actor: string) => void;
};

const FILTER_BUTTON_BASE = 'transition-colors truncate text-left cursor-pointer';

function FilterButton({
  value,
  onSelect,
  className,
  children,
}: {
  value: string;
  onSelect?: (value: string) => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(value)}
      title={`filter by ${value}`}
      className={`${FILTER_BUTTON_BASE} ${className}`}
    >
      {children}
    </button>
  );
}

export const EventRow = memo(EventRowImpl);

function EventRowImpl({ event, onSelectRepo, onSelectActor }: Props) {
  const meta = EVENT_TYPE_META[event.type];
  const time = event.timestamp.slice(11, 16);
  const repoShort = event.repo.split('/').pop() ?? event.repo;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 py-0.5 px-2 text-sm leading-6 hover:bg-zinc-900/60">
      <span className="text-zinc-600 tabular-nums shrink-0">{time}</span>
      <span className={`${meta.colorClass} shrink-0 w-4 text-center`} title={meta.label}>
        {meta.sigil}
      </span>
      <span
        className={`${meta.colorClass} shrink-0 tabular-nums truncate max-w-[8rem] ${event.type === 'commit' ? 'hidden sm:inline' : ''}`}
      >
        {event.shortId}
      </span>
      <FilterButton
        value={event.repo}
        onSelect={onSelectRepo}
        className="text-zinc-500 hover:text-zinc-300 min-w-0 max-w-[40vw] sm:max-w-[14rem]"
      >
        <span className="sm:hidden">{repoShort}</span>
        <span className="hidden sm:inline">{event.repo}</span>
      </FilterButton>
      <FilterButton
        value={event.actor}
        onSelect={onSelectActor}
        className="text-emerald-300/80 hover:text-emerald-200 shrink-0 max-w-[8rem] sm:max-w-[10rem]"
      >
        {event.actor}
      </FilterButton>
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
