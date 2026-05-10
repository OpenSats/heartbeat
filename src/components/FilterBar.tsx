import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { EVENT_TYPES, type EventType } from '../types';
import { EVENT_TYPE_META } from '../eventTypes';
import type { FilterControl } from '../lib/useUrlSet';
import { useUrlString } from '../lib/useUrlString';
import { RepoLabel } from './RepoLabel';
import type { RepoIndex } from '../App';

const CHIP_BASE = 'px-2 py-1 sm:py-0.5 text-xs rounded border transition';
const CHIP_IDLE = 'border-zinc-800 bg-transparent text-zinc-500';
const CHIP_HOVER = 'hover:text-zinc-300 hover:border-zinc-700';
const CHIP_ACTIVE = 'border-zinc-500 bg-zinc-800 text-zinc-100';
const CHIP_DISABLED = 'border-zinc-900 bg-transparent text-zinc-700 cursor-not-allowed';
const CHIP_FOCUS_ACTIVE = 'focus:border-zinc-500 focus:bg-zinc-800 focus:text-zinc-100';
const ROW_LABEL = 'text-zinc-600 text-xs shrink-0 w-14';

const chipClass = (active: boolean) =>
  active ? `${CHIP_BASE} ${CHIP_ACTIVE}` : `${CHIP_BASE} ${CHIP_IDLE} ${CHIP_HOVER}`;

const windowChipClass = (active: boolean, disabled: boolean) => {
  if (disabled) return `${CHIP_BASE} ${CHIP_DISABLED}`;
  return chipClass(active);
};

type Props = {
  repos: string[];
  funds: Record<string, string[]>;
  repoIndex: RepoIndex | null;

  fundFilter: FilterControl;
  repoFilter: FilterControl;
  typeFilter: FilterControl;
  actorFilter: FilterControl;

  windowOptions: readonly number[];
  windowDays: number;
  setWindowDays: (n: number) => void;
  builtWindowDays: number;

  authorQuery: string;
  setAuthorQuery: (s: string) => void;
};

// One filter-bar chip describing how a repo is rendered and selected.
//   display:        plain "owner/name", what the user reads
//   selectionValue: what gets stored in the URL set (repoKey when known,
//                   plain repo as fallback)
//   host:           non-null only when this chip is part of a collision pair
//                   and a [host] badge should render
type RepoChipValue = {
  display: string;
  selectionValue: string;
  host: string | null;
};

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
    <button type="button" onClick={onClick} title={title} className={chipClass(active)}>
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
      <span className={ROW_LABEL}>{label}</span>
      {children}
      {onClear && <ClearButton onClick={onClear} />}
    </div>
  );
}

export function FilterBar({
  repos,
  funds,
  repoIndex,
  fundFilter,
  repoFilter,
  typeFilter,
  actorFilter,
  windowOptions,
  windowDays,
  setWindowDays,
  builtWindowDays,
  authorQuery,
  setAuthorQuery,
}: Props) {
  const selectedActors = actorFilter.selected;
  const [repoQuery, setRepoQuery] = useUrlString('q');
  const [reposExpanded, setReposExpanded] = useState(false);
  // The deferred query lets the input update at urgent priority while
  // the (heavier) filtered chip list and downstream effects re-render
  // at low priority. Keeps typing snappy on big repo lists.
  const deferredQuery = useDeferredValue(repoQuery);

  const fundNames = useMemo(() => Object.keys(funds).sort(), [funds]);
  const has = (s: Set<string> | null, v: string) => s != null && s.has(v);

  // First pass: filter the plain-repo list by fund and query.
  // Dedupe input to defend against future cases where data.repos may contain
  // the same display name twice (e.g. once per host before any backend
  // collision resolution lands).
  const filteredRepos = useMemo(() => {
    let list = [...new Set(repos)];
    const sel = fundFilter.selected;
    if (sel && sel.size > 0) {
      const allowed = new Set<string>();
      for (const f of sel) for (const r of funds[f] ?? []) allowed.add(r);
      list = list.filter((r) => allowed.has(r));
    }
    const q = deferredQuery.trim().toLowerCase();
    if (q) list = list.filter((r) => r.toLowerCase().includes(q));
    return list;
  }, [repos, funds, fundFilter.selected, deferredQuery]);

  // Second pass: expand plain-repo entries into chips per the three-case rule:
  //   1. exactly one known repoKey -> use that repoKey, no badge
  //   2. multiple repoKeys (collision) -> one chip per host, with badge
  //   3. zero events for this repo -> fall back to plain repo
  const filteredRepoChips = useMemo<RepoChipValue[]>(() => {
    return filteredRepos.flatMap((r) => {
      const keys = repoIndex?.byRepo.get(r);

      if (!keys || keys.size === 0) {
        return [{ display: r, selectionValue: r, host: null }];
      }
      if (keys.size === 1) {
        const onlyKey = [...keys][0];
        return [{ display: r, selectionValue: onlyKey, host: null }];
      }
      return [...keys].sort().map((rk) => ({
        display: r,
        selectionValue: rk,
        host: repoIndex!.hostOf.get(rk) ?? null,
      }));
    });
  }, [filteredRepos, repoIndex]);

  const showRepoChips = reposExpanded || repoQuery.length > 0;

  // Typing in the filter auto-selects matching repos; clearing the
  // input drops the param so the timeline returns to all repos. We
  // ignore the empty->empty case so URL-bound selections survive
  // first render. Debounced so URL writes (which serialize the full
  // repo set into history.replaceState) coalesce while typing.
  const { set: setRepoSelection } = repoFilter;
  const prevQueryRef = useRef(deferredQuery);
  useEffect(() => {
    const handle = setTimeout(() => {
      const prev = prevQueryRef.current;
      prevQueryRef.current = deferredQuery;
      if (deferredQuery.length === 0) {
        if (prev.length > 0) setRepoSelection(null);
        return;
      }
      setRepoSelection(new Set(filteredRepoChips.map((c) => c.selectionValue)));
    }, 150);
    return () => clearTimeout(handle);
  }, [deferredQuery, filteredRepoChips, setRepoSelection]);

  // A chip is considered active if either its selectionValue (post-Step-4
  // default, usually a repoKey) OR its plain display name (legacy URL form)
  // is in the current selection. This keeps old bookmarked URLs visually
  // correct after Step 4 lands.
  const chipIsActive = (c: RepoChipValue) =>
    has(repoFilter.selected, c.selectionValue) || has(repoFilter.selected, c.display);

  // Toggling a chip whose active state comes from a legacy plain-repo URL
  // entry must remove that legacy entry, not toggle the new repoKey form
  // alongside it. Otherwise clicking an "active" chip would leave the old
  // entry behind and visually appear unchanged. The repoKey path goes
  // through the standard toggle.
  const toggleRepoChip = (c: RepoChipValue) => {
    const selected = repoFilter.selected;
    if (selected?.has(c.display) && !selected.has(c.selectionValue)) {
      const next = new Set(selected);
      next.delete(c.display);
      repoFilter.set(next.size > 0 ? next : null);
      return;
    }
    repoFilter.toggle(c.selectionValue);
  };

  const renderRepoChips = (list: RepoChipValue[]) => {
    if (list.length === 0) {
      return <span className="text-xs text-zinc-600">no matching repos</span>;
    }
    return list.map((c) => (
      <Chip
        key={c.selectionValue}
        active={chipIsActive(c)}
        onClick={() => toggleRepoChip(c)}
        title={c.host ? `${c.display} (${c.host})` : c.display}
      >
        <RepoLabel repo={c.display} host={c.host} />
      </Chip>
    ));
  };

  const repoClearIfActive = clearIfActive(repoFilter);
  const selectedRepoCount = repoFilter.selected?.size ?? 0;
  const repoToggleLabel =
    selectedRepoCount > 0
      ? `${selectedRepoCount} selected`
      : `show all ${filteredRepoChips.length}`;

  const filterRowContent = (
    <>
      <span className={ROW_LABEL}>filter:</span>
      <input
        type="text"
        value={repoQuery}
        onChange={(e) => setRepoQuery(e.target.value)}
        placeholder="repo name"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className={`${chipClass(Boolean(repoQuery))} min-w-0 flex-1 max-w-40 placeholder:text-zinc-600 focus:outline-none ${repoQuery ? '' : CHIP_FOCUS_ACTIVE}`}
      />
      {repoQuery && <ClearButton onClick={() => setRepoQuery('')} />}
    </>
  );

  const authorRowContent = (
    <>
      <span className={ROW_LABEL}>author:</span>
      <input
        type="text"
        value={authorQuery}
        onChange={(e) => setAuthorQuery(e.target.value)}
        placeholder="exact GitHub username"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className={`${chipClass(Boolean(authorQuery))} min-w-0 flex-1 max-w-60 placeholder:text-zinc-600 focus:outline-none ${authorQuery ? '' : CHIP_FOCUS_ACTIVE}`}
      />
      {authorQuery && <ClearButton onClick={() => setAuthorQuery('')} />}
    </>
  );

  const markUrl = `${import.meta.env.BASE_URL}opensats-mark.svg`;

  const clearAll = () => {
    fundFilter.clear();
    repoFilter.clear();
    typeFilter.clear();
    actorFilter.clear();
    setRepoQuery('');
    setAuthorQuery('');
    setReposExpanded(false);
  };

  return (
    <div className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={clearAll}
          className="flex items-center gap-1 cursor-pointer transition-opacity hover:opacity-80"
          title="reset all filters"
          aria-label="reset all filters"
        >
          <img
            src={markUrl}
            alt=""
            className="h-7 w-7 shrink-0 filter-[brightness(0)_invert(1)]"
          />
          <h1 className="text-zinc-100 text-base font-medium">heartbeat365</h1>
        </button>
        <a
          href="https://opensats.org"
          target="_blank"
          rel="noreferrer noopener"
          className="text-zinc-600 hover:text-zinc-300 text-xs transition-colors"
        >
          by OpenSats
        </a>
      </div>

      <ChipRow label="window:">
        {windowOptions.map((n) => {
          const disabled = n > builtWindowDays;
          const active = n === windowDays;
          return (
            <button
              key={n}
              type="button"
              disabled={disabled}
              onClick={() => setWindowDays(n)}
              title={
                disabled
                  ? `Only ${builtWindowDays} days of data are built. Set HEARTBEAT_WINDOW_DAYS=${n} (or higher) and rebuild to enable.`
                  : `Show last ${n} days`
              }
              className={windowChipClass(active, disabled)}
            >
              {n}d
            </button>
          );
        })}
      </ChipRow>

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
      <div className="flex items-center gap-1.5">{authorRowContent}</div>

      <div className="space-y-2">
        <ChipRow label="repos:" onClear={repoClearIfActive}>
          {!repoQuery && (
            <Chip
              active={false}
              onClick={() => setReposExpanded((v) => !v)}
              title={`${repos.length} repos`}
            >
              {reposExpanded ? 'hide' : repoToggleLabel}
            </Chip>
          )}
        </ChipRow>
        {showRepoChips && (
          <div className="flex flex-wrap items-center gap-1.5 sm:max-h-[40vh] sm:overflow-y-auto">
            {renderRepoChips(filteredRepoChips)}
          </div>
        )}
      </div>

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

      {selectedActors && selectedActors.size > 0 && (
        <ChipRow label="dev:" onClear={clearIfActive(actorFilter)}>
          {[...selectedActors].sort().map((a) => (
            <Chip key={a} active onClick={() => actorFilter.toggle(a)} title={`remove ${a}`}>
              {a}
            </Chip>
          ))}
        </ChipRow>
      )}
    </div>
  );
}
