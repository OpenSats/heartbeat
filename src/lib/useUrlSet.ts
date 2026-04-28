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

/**
 * URL-backed multi-select. `null` means "no filter" (param absent).
 * An empty Set means "filter is active but nothing selected".
 */
export function useUrlSet(key: string): [Set<string> | null, (next: Set<string> | null) => void, (value: string) => void] {
  const [state, setState] = useState<Set<string> | null>(() => readParam(key));

  useEffect(() => {
    const onPop = () => setState(readParam(key));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [key]);

  const set = useCallback(
    (next: Set<string> | null) => {
      writeParam(key, next);
      setState(next);
    },
    [key],
  );

  const toggle = useCallback(
    (value: string) => {
      setState((prev) => {
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

  return [state, set, toggle];
}
