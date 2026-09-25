import { useEffect, useState } from 'react';
import { discoverAccounts, type DiscoveredAccount } from './discoverAccounts';
import { parseSource, type Source } from './model';
export type { DiscoveredAccount } from './discoverAccounts';

export function useAccountDiscovery(
  sources: Source[],
  onDiscovered: (accounts: DiscoveredAccount[]) => void,
) {
  const [evidence, setEvidence] = useState<DiscoveredAccount[]>([]);
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
    const pause = (seconds: number) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new Error('Discovery cancelled.'));
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener('abort', abort);
          resolve();
        }, seconds * 1000);
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      });
    const read = async (kind: string, value: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(
          `/api/pow/discover?${new URLSearchParams({ kind, value, v: '3' })}`,
          { signal: controller.signal, referrerPolicy: 'no-referrer' },
        );
        if (response.ok) return response.json();
        if (![429, 503].includes(response.status) || attempt === 2) break;
        const delay = Number(response.headers.get('Retry-After')) || 30;
        await pause(Math.max(1, delay));
      }
      throw new Error('Discovery unavailable.');
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
    void discoverAccounts(inputs, read, resolve, { includeExisting: true }).then((accounts) => {
      if (controller.signal.aborted) return;
      setEvidence(accounts);
      const additions = accounts.filter(
        (account) => !inputs.some((input) => input.value === account.value),
      );
      if (additions.length) onDiscovered(additions);
    });
    return () => controller.abort();
  }, [inputKey, onDiscovered]);
  return evidence;
}
