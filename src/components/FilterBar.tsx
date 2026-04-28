import { useMemo, useState } from 'react';
import { EVENT_TYPES, type EventType } from '../types';
import { EVENT_TYPE_META } from '../eventTypes';
import type { FilterControl } from '../lib/useUrlSet';

const CHIP_BASE = 'px-2 py-1 sm:py-0.5 text-xs rounded border transition';
const CHIP_IDLE = 'border-zinc-800 bg-transparent text-zinc-500';
const CHIP_HOVER = 'hover:text-zinc-300 hover:border-zinc-700';
const CHIP_ACTIVE = 'border-zinc-500 bg-zinc-800 text-zinc-100';
const CHIP_FOCUS_ACTIVE = 'focus:border-zinc-500 focus:bg-zinc-800 focus:text-zinc-100';

type Props = {
  repos: string[];
  funds: Record<string, string[]>;

  fundFilter: FilterControl;
  repoFilter: FilterControl;
  typeFilter: FilterControl;

  total: number;
  shown: number;
};

const isActive = (s: Set<string> | null) => s != null && s.size > 0;
const clearIfActive = (f: FilterControl) => (f.selected != null ? f.clear : undefined);

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
  fundFilter,
  repoFilter,
  typeFilter,
  total,
  shown,
}: Props) {
  const [repoQuery, setRepoQuery] = useState('');
  const [reposExpanded, setReposExpanded] = useState(false);

  const fundNames = useMemo(() => Object.keys(funds).sort(), [funds]);
  const has = (s: Set<string> | null, v: string) => s != null && s.has(v);

  const filteredRepos = useMemo(() => {
    let list = repos;
    const sel = fundFilter.selected;
    if (sel && sel.size > 0) {
      const allowed = new Set<string>();
      for (const f of sel) for (const r of funds[f] ?? []) allowed.add(r);
      list = list.filter((r) => allowed.has(r));
    }
    const q = repoQuery.trim().toLowerCase();
    if (q) list = list.filter((r) => r.toLowerCase().includes(q));
    return list;
  }, [repos, funds, fundFilter.selected, repoQuery]);

  const repoCountLabel =
    repoFilter.selected != null && repoFilter.selected.size > 0
      ? `${repoFilter.selected.size} of ${repos.length} active`
      : repoQuery || isActive(fundFilter.selected)
        ? `${filteredRepos.length} of ${repos.length} matching`
        : `${repos.length}`;

  const renderRepoChips = (list: string[]) => {
    if (list.length === 0) {
      return <span className="text-xs text-zinc-600">no matching repos</span>;
    }
    return list.map((r) => {
      const short = r.split('/').pop() ?? r;
      return (
        <Chip
          key={r}
          active={has(repoFilter.selected, r)}
          onClick={() => repoFilter.toggle(r)}
          title={r}
        >
          <span className="sm:hidden">{short}</span>
          <span className="hidden sm:inline">{r}</span>
        </Chip>
      );
    });
  };

  const repoClearIfActive = clearIfActive(repoFilter);

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
            <img src={markUrl} alt="" className="h-7 w-7 [filter:brightness(0)_invert(1)]" />
          </a>
          <h1 className="text-zinc-100 text-base font-medium">heartbeat</h1>
        </div>
        <span className="text-zinc-600 text-xs">
          {shown} / {total} events
        </span>
      </div>

      {fundNames.length > 0 && (
        <ChipRow label="fund:" onClear={clearIfActive(fundFilter)}>
          {fundNames.map((f) => (
            <Chip key={f} active={has(fundFilter.selected, f)} onClick={() => fundFilter.toggle(f)}>
              {f}
            </Chip>
          ))}
        </ChipRow>
      )}

      <div className="flex items-center gap-1.5">{filterRowContent}</div>

      <details
        className="group"
        open={reposExpanded || repoQuery.length > 0}
        onToggle={(e) => setReposExpanded(e.currentTarget.open)}
      >
        <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none flex items-center gap-1.5 text-xs text-zinc-500">
          <span className="text-zinc-600 inline-block transition-transform group-[&[open]]:rotate-90">
            {'\u25B8'}
          </span>
          <span>repos &middot; {repoCountLabel}</span>
          {repoClearIfActive && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                repoClearIfActive();
              }}
              className="text-xs text-zinc-500 hover:text-zinc-300 ml-1"
            >
              clear
            </button>
          )}
        </summary>
        <div className="flex flex-wrap items-center gap-1.5 pt-2 sm:max-h-[40vh] sm:overflow-y-auto">
          {renderRepoChips(filteredRepos)}
        </div>
      </details>

      <ChipRow label="types:" onClear={clearIfActive(typeFilter)}>
        {EVENT_TYPES.map((t: EventType) => {
          const meta = EVENT_TYPE_META[t];
          return (
            <Chip
              key={t}
              active={has(typeFilter.selected, t)}
              onClick={() => typeFilter.toggle(t)}
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
