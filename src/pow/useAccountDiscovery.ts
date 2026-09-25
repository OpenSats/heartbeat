import { useEffect } from 'react';
import { githubClaims, matchingGithubProof, profileNpubs } from './accountDiscovery';
import type { Source } from './model';

export type DiscoveredAccount = {
  parameter: 'p' | 'gh';
  value: string;
  from: string;
  evidenceUrl: string;
  verified: boolean;
};
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
      const response = await fetch(`/api/pow/discover?${new URLSearchParams({ kind, value })}`, {
        signal: controller.signal,
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error('Discovery unavailable.');
      return response.json();
    };
    void Promise.all(
      inputs.map(async ({ kind, value }): Promise<[string, DiscoveredAccount[]]> => {
        const key = `${kind}:${value}`;
        try {
          const data = await read(kind, value);
          if (kind === 'github')
            return [
              key,
              profileNpubs(
                [data.bio, data.blog, ...(data.social ?? [])]
                  .filter((v) => typeof v === 'string')
                  .join('\n'),
              ).map((npub) => ({
                parameter: 'p',
                value: npub,
                from: value,
                evidenceUrl: `https://github.com/${value}`,
                verified: false,
              })),
            ];
          const suggestions: DiscoveredAccount[] = [];
          for (const claim of githubClaims(data.event, value)) {
            try {
              const proof = await read('gist', claim.gist);
              if (matchingGithubProof(proof, claim.handle, value))
                suggestions.push({
                  parameter: 'gh',
                  value: claim.handle,
                  from: value,
                  evidenceUrl: `https://gist.github.com/${claim.handle}/${claim.gist}`,
                  verified: true,
                });
            } catch {
              /* Unavailable proofs are not verified. */
            }
          }
          return [key, suggestions];
        } catch {
          return [key, []];
        }
      }),
    ).then((entries) => {
      if (!controller.signal.aborted) {
        const existing = new Set(inputs.map(({ value }) => value));
        const accounts = [
          ...new Map(
            entries
              .flatMap(([, accounts]) => accounts)
              .filter((account) => !existing.has(account.value))
              .map((account) => [`${account.parameter}:${account.value}`, account]),
          ).values(),
        ];
        if (accounts.length) onDiscovered(accounts);
      }
    });
    return () => controller.abort();
  }, [inputKey, onDiscovered]);
}
