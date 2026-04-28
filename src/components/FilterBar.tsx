import { useMemo, useState } from 'react';
import { EVENT_TYPES, type EventType } from '../types';
import { EVENT_TYPE_META } from '../eventTypes';

const CHIP_BASE = 'px-2 py-1 sm:py-0.5 text-xs rounded border transition';
const CHIP_IDLE = 'border-zinc-800 bg-transparent text-zinc-500';
const CHIP_HOVER = 'hover:text-zinc-300 hover:border-zinc-700';
const CHIP_ACTIVE = 'border-zinc-500 bg-zinc-800 text-zinc-100';
const CHIP_FOCUS_ACTIVE = 'focus:border-zinc-500 focus:bg-zinc-800 focus:text-zinc-100';

type Props = {
  repos: string[];
  funds: Record<string, string[]>;

  selectedFunds: Set<string> | null;
  onToggleFund: (fund: string) => void;
  onClearFunds: () => void;

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
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : `${CHIP_IDLE} ${CHIP_HOVER}`}`}
    >
      {children}
    </button>
  );
}

function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-zinc-500 hover:text-zinc-300 ml-1"
    >
      clear
    </button>
  );
}

function ChipRow({
  label,
  onClear,
  className,
  children,
}: {
  label: string;
  onClear?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}>
      <span className="text-zinc-600 text-xs mr-1">{label}</span>
      {children}
      {onClear && <ClearButton onClick={onClear} />}
    </div>
  );
}

export function FilterBar({
  repos,
  funds,
  selectedFunds,
  onToggleFund,
  onClearFunds,
  selectedRepos,
  onToggleRepo,
  onClearRepos,
  selectedTypes,
  onToggleType,
  onClearTypes,
  total,
  shown,
}: Props) {
  const [repoQuery, setRepoQuery] = useState('');
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const fundNames = useMemo(() => Object.keys(funds).sort(), [funds]);
  const isFundActive = (f: string) => selectedFunds != null && selectedFunds.has(f);
  const isRepoActive = (r: string) => selectedRepos != null && selectedRepos.has(r);
  const isTypeActive = (t: string) => selectedTypes != null && selectedTypes.has(t);

  const filteredRepos = useMemo(() => {
    let list = repos;
    if (selectedFunds && selectedFunds.size > 0) {
      const allowed = new Set<string>();
      for (const f of selectedFunds) for (const r of funds[f] ?? []) allowed.add(r);
      list = list.filter((r) => allowed.has(r));
    }
    const q = repoQuery.trim().toLowerCase();
    if (q) list = list.filter((r) => r.toLowerCase().includes(q));
    return list;
  }, [repos, funds, selectedFunds, repoQuery]);

  const fundFilterActive = selectedFunds != null && selectedFunds.size > 0;
  const repoCountLabel =
    selectedRepos != null && selectedRepos.size > 0
      ? `${selectedRepos.size} of ${repos.length} active`
      : repoQuery || fundFilterActive
        ? `${filteredRepos.length} of ${repos.length} matching`
        : `${repos.length}`;

  const renderRepoChips = (list: string[], label: (r: string) => string) => {
    if (list.length === 0) {
      return <span className="text-xs text-zinc-600">no matching repos</span>;
    }
    return list.map((r) => (
      <Chip key={r} active={isRepoActive(r)} onClick={() => onToggleRepo(r)} title={r}>
        {label(r)}
      </Chip>
    ));
  };

  const repoClearIfActive = selectedRepos != null ? onClearRepos : undefined;

  const filterRowContent = (
    <>
      <span className="text-zinc-600 text-xs mr-1 shrink-0">filter:</span>
      <input
        type="text"
        value={repoQuery}
        onChange={(e) => setRepoQuery(e.target.value)}
        placeholder="repo name"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className={[
          CHIP_BASE,
          'min-w-0 flex-1 max-w-40 placeholder:text-zinc-600 focus:outline-none',
          repoQuery ? CHIP_ACTIVE : `${CHIP_IDLE} ${CHIP_HOVER} ${CHIP_FOCUS_ACTIVE}`,
        ].join(' ')}
      />
      {repoQuery && <ClearButton onClick={() => setRepoQuery('')} />}
    </>
  );

  const markUrl = `${import.meta.env.BASE_URL}opensats-mark.svg`;

  return (
    <div className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <a
            href="https://opensats.org"
            target="_blank"
            rel="noreferrer noopener"
            className="shrink-0 transition-opacity hover:opacity-80"
            title="An OpenSats project"
            aria-label="OpenSats"
          >
            <img
              src={markUrl}
              alt=""
              className="h-7 w-7 [filter:brightness(0)_invert(1)]"
            />
          </a>
          <h1 className="text-zinc-100 text-base font-medium">heartbeat</h1>
        </div>
        <span className="text-zinc-600 text-xs">
          {shown} / {total} events
        </span>
      </div>

      {fundNames.length > 0 && (
        <ChipRow label="fund:" onClear={selectedFunds != null ? onClearFunds : undefined}>
          {fundNames.map((f) => (
            <Chip key={f} active={isFundActive(f)} onClick={() => onToggleFund(f)}>
              {f}
            </Chip>
          ))}
        </ChipRow>
      )}

      <details
        className="group sm:hidden"
        open={mobileExpanded}
        onToggle={(e) => setMobileExpanded(e.currentTarget.open)}
      >
        <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none flex items-center gap-1.5 text-xs text-zinc-500">
          <span className="text-zinc-600 inline-block transition-transform group-[&[open]]:rotate-90">
            {'\u25B8'}
          </span>
          <span>repos &middot; {repoCountLabel}</span>
        </summary>
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          {renderRepoChips(filteredRepos, (r) => r.split('/').pop() ?? r)}
          {repoClearIfActive && <ClearButton onClick={repoClearIfActive} />}
        </div>
        <div className="flex items-center gap-1.5 pt-2">{filterRowContent}</div>
      </details>

      <ChipRow label="repos:" onClear={repoClearIfActive} className="hidden sm:flex">
        {renderRepoChips(filteredRepos, (r) => r)}
      </ChipRow>

      <div className="hidden sm:flex items-center gap-1.5">{filterRowContent}</div>

      <ChipRow label="types:" onClear={selectedTypes != null ? onClearTypes : undefined}>
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
      </ChipRow>
    </div>
  );
}
