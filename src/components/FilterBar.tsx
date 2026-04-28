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
        'px-2 py-0.5 text-xs rounded border transition',
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

  return (
    <div className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur px-3 py-2 space-y-2">
      <div className="flex items-baseline gap-3">
        <h1 className="text-zinc-100 text-base">heartbeat</h1>
        <span className="text-zinc-600 text-xs">
          {shown} / {total} events
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-zinc-600 text-xs mr-1">repos:</span>
        {repos.map((r) => (
          <Chip key={r} active={isRepoActive(r)} onClick={() => onToggleRepo(r)}>
            {r}
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
