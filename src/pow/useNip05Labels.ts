import { useEffect, useState } from 'react';

export function useNip05Labels(npubs: string[]) {
  const [labels, setLabels] = useState<Record<string, string | null>>({});
  const key = JSON.stringify([...new Set(npubs)].filter((npub) => npub.startsWith('npub1')).sort());
  useEffect(() => {
    const controller = new AbortController();
    const keys: string[] = JSON.parse(key);
    void Promise.all(
      keys.map(async (npub): Promise<[string, string | null]> => {
        try {
          const response = await fetch(`/api/pow/resolve?${new URLSearchParams({ npub })}`, {
            signal: controller.signal,
            referrerPolicy: 'no-referrer',
          });
          if (!response.ok) return [npub, null];
          const result = await response.json();
          return [
            npub,
            result.npub === npub && typeof result.identifier === 'string'
              ? result.identifier
              : null,
          ];
        } catch {
          return [npub, null];
        }
      }),
    ).then((entries) => {
      if (!controller.signal.aborted)
        setLabels((previous) => ({ ...previous, ...Object.fromEntries(entries) }));
    });
    return () => controller.abort();
  }, [key]);
  return (value: string) => {
    const [npub, ...rest] = value.split('/');
    return labels[npub] ? [labels[npub], ...rest].join('/') : value;
  };
}
