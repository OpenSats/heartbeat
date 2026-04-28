import { EVENT_TYPES, type EventType } from '../types';
import { EVENT_TYPE_META } from '../eventTypes';

type Props = {
  repos: string[];
  selectedRepos: Set<string> | null;
  onToggleRepo: (repo: string) => void;
  onClearRepos: () => void;

  selectedTypes: Set<string> | null;
  onToggleType: (type: string) => void;
  onClearTypes: () => void;

  total: number;
  shown: number;
};

function Chip({
  active,
  onClick,
  children,
  title,
  colorClass,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  colorClass?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={[
        'px-2 py-1 sm:py-0.5 text-xs rounded border transition',
        active
          ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
          : 'border-zinc-800 bg-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-700',
        colorClass ?? '',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export function FilterBar({
  repos,
  selectedRepos,
  onToggleRepo,
  onClearRepos,
  selectedTypes,
  onToggleType,
  onClearTypes,
  total,
  shown,
}: Props) {
  const isRepoActive = (r: string) => selectedRepos != null && selectedRepos.has(r);
  const isTypeActive = (t: string) => selectedTypes != null && selectedTypes.has(t);
  const repoCountLabel =
    selectedRepos != null && selectedRepos.size > 0
      ? `${selectedRepos.size} of ${repos.length} active`
      : `${repos.length}`;

  const renderRepoChips = (label: (r: string) => string) => (
    <>
      {repos.map((r) => (
        <Chip key={r} active={isRepoActive(r)} onClick={() => onToggleRepo(r)} title={r}>
          {label(r)}
        </Chip>
      ))}
      {selectedRepos != null && (
        <button
          type="button"
          onClick={onClearRepos}
          className="text-xs text-zinc-500 hover:text-zinc-300 ml-1"
        >
          clear
        </button>
      )}
    </>
  );

  return (
    <div className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur px-3 py-2 space-y-2">
      <div className="flex items-baseline gap-3">
        <h1 className="text-zinc-100 text-base">heartbeat</h1>
        <span className="text-zinc-600 text-xs">
          {shown} / {total} events
        </span>
      </div>

      <details className="group sm:hidden">
        <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none flex items-center gap-1.5 text-xs text-zinc-500">
          <span className="text-zinc-600 inline-block transition-transform group-[&[open]]:rotate-90">
            {'\u25B8'}
          </span>
          <span>repos &middot; {repoCountLabel}</span>
        </summary>
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          {renderRepoChips((r) => r.split('/').pop() ?? r)}
        </div>
      </details>

      <div className="hidden sm:flex flex-wrap items-center gap-1.5">
        <span className="text-zinc-600 text-xs mr-1">repos:</span>
        {renderRepoChips((r) => r)}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-zinc-600 text-xs mr-1">types:</span>
        {EVENT_TYPES.map((t: EventType) => {
          const meta = EVENT_TYPE_META[t];
          return (
            <Chip
              key={t}
              active={isTypeActive(t)}
              onClick={() => onToggleType(t)}
              title={meta.label}
            >
              <span className={`${meta.colorClass} mr-1`}>{meta.sigil}</span>
              {meta.label}
            </Chip>
          );
        })}
        {selectedTypes != null && (
          <button
            type="button"
            onClick={onClearTypes}
            className="text-xs text-zinc-500 hover:text-zinc-300 ml-1"
          >
            clear
          </button>
        )}
      </div>
    </div>
  );
}
