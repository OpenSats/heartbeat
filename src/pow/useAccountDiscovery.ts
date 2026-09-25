import { useEffect } from 'react';
import { discoverAccounts, type DiscoveredAccount } from './discoverAccounts';
import { parseSource, type Source } from './model';
export type { DiscoveredAccount } from './discoverAccounts';

export function useAccountDiscovery(
  sources: Source[],
  onDiscovered: (accounts: DiscoveredAccount[]) => void,
) {
  const inputs = [
    ...new Map(
      sources
        .filter((s) => ['github', 'nostr', 'ngit'].includes(s.kind))
        .map((s) => {
          const kind = s.kind === 'github' ? 'github' : 'nostr';
          const value = kind === 'github' ? s.value : s.label;
          return [`${kind}:${value}`, { kind, value }];
        }),
    ).values(),
  ];
  const inputKey = JSON.stringify(inputs);
  useEffect(() => {
    const controller = new AbortController();
    const inputs: { kind: string; value: string }[] = JSON.parse(inputKey);
    const read = async (kind: string, value: string) => {
      const response = await fetch(
        `/api/pow/discover?${new URLSearchParams({ kind, value, v: '3' })}`,
        {
          signal: controller.signal,
          referrerPolicy: 'no-referrer',
        },
      );
      if (!response.ok) throw new Error('Discovery unavailable.');
      return response.json();
    };
    const resolve = async (address: string) => {
      const response = await fetch(`/api/pow/resolve?${new URLSearchParams({ address })}`, {
        signal: controller.signal,
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error('Address unavailable.');
      const data = await response.json();
      return parseSource('nostr', data.npub).label;
    };
    void discoverAccounts(inputs, read, resolve).then((accounts) => {
      if (!controller.signal.aborted && accounts.length) onDiscovered(accounts);
    });
    return () => controller.abort();
  }, [inputKey, onDiscovered]);
}
