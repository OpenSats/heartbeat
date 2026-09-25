import { useEffect, useMemo, useState } from 'react';
import { sourcesFromUrl, parseSource, type IdentityResolution } from './model';

export function useSources(params: URLSearchParams, suppliedParams = params) {
  const [resolutions, setResolutions] = useState<Record<string, IdentityResolution>>({});
  const parsed = useMemo(() => sourcesFromUrl(params, resolutions), [params, resolutions]);
  const suppliedSourceKeys = useMemo(
    () => new Set(sourcesFromUrl(suppliedParams, resolutions).sources.map((source) => source.key)),
    [suppliedParams, resolutions],
  );
  const pendingKey = JSON.stringify(parsed.pending);
  useEffect(() => {
    const addresses: string[] = JSON.parse(pendingKey);
    if (!addresses.length) return;
    const controller = new AbortController();
    // Publish together so one finished lookup does not abort the other pending requests.
    void Promise.all(
      addresses.map(async (address): Promise<[string, IdentityResolution]> => {
        try {
          const response = await fetch(`/api/pow/resolve?${new URLSearchParams({ address })}`, {
            signal: controller.signal,
            referrerPolicy: 'no-referrer',
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? 'Unable to resolve NIP-05 address.');
          const source = parseSource('nostr', result.npub);
          return [address, { npub: source.label }];
        } catch (error) {
          return [address, { error: `${address}: ${(error as Error).message}` }];
        }
      }),
    ).then((entries) => {
      if (!controller.signal.aborted)
        setResolutions((previous) => ({ ...previous, ...Object.fromEntries(entries) }));
    });
    return () => controller.abort();
  }, [pendingKey]);
  return { ...parsed, suppliedSourceKeys };
}
