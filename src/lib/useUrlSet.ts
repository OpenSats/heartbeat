import { useCallback, useEffect, useState } from 'react';

function readParam(key: string): Set<string> | null {
  const raw = new URLSearchParams(window.location.search).get(key);
  if (raw == null) return null;
  return new Set(raw.split(',').filter(Boolean));
}

function writeParam(key: string, value: Set<string> | null): void {
  const url = new URL(window.location.href);
  if (value == null) {
    url.searchParams.delete(key);
  } else {
    url.searchParams.set(key, [...value].join(','));
  }
  window.history.replaceState({}, '', url);
}

/** A URL-backed multi-select control. */
export type FilterControl = {
  /** Selected values, or null when the URL param is absent (no filter). */
  selected: Set<string> | null;
  /** Replace the entire selection (pass null to drop the URL param). */
  set: (next: Set<string> | null) => void;
  /** Toggle a value's presence in the set. */
  toggle: (value: string) => void;
  /** Drop the URL param entirely. */
  clear: () => void;
};

/**
 * URL-backed multi-select. `selected` is null when the URL param is
 * absent (no filter); an empty Set means "filter is active but nothing
 * is selected".
 */
export function useUrlSet(key: string): FilterControl {
  const [selected, setSelected] = useState<Set<string> | null>(() => readParam(key));

  useEffect(() => {
    const onPop = () => setSelected(readParam(key));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [key]);

  const set = useCallback(
    (next: Set<string> | null) => {
      writeParam(key, next);
      setSelected(next);
    },
    [key],
  );

  const toggle = useCallback(
    (value: string) => {
      setSelected((prev) => {
        const next = new Set(prev ?? []);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        const finalValue = prev == null && next.size === 0 ? null : next;
        writeParam(key, finalValue);
        return finalValue;
      });
    },
    [key],
  );

  const clear = useCallback(() => {
    writeParam(key, null);
    setSelected(null);
  }, [key]);

  return { selected, set, toggle, clear };
}
