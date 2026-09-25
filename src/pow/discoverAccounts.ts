import type { Event } from 'nostr-tools';
import {
  githubClaims,
  matchingGithubProof,
  profileNpubs,
  profileMetadata,
  websiteDomain,
} from './accountDiscovery.js';
import { nip05Address } from './nip05.js';
import { parseSource } from './model.js';

export type AccountInput = { kind: string; value: string };
export type AccountEvidence = {
  login?: string;
  avatar?: string;
  bio?: string | null;
  blog?: string | null;
  social?: string[];
  event?: Event | null;
  profile?: Event | null;
  owner?: string;
  content?: string | null;
};
export type DiscoveredAccount = {
  parameter: 'p' | 'gh';
  value: string;
  from: string;
  evidenceUrl: string;
  verified: boolean;
};
export async function discoverAccounts(
  inputs: AccountInput[],
  read: (kind: string, value: string) => Promise<AccountEvidence>,
  resolve: (address: string) => Promise<string>,
) {
  const entries = await Promise.all(
    inputs.map(async ({ kind, value }): Promise<[string, DiscoveredAccount[]]> => {
      const key = `${kind}:${value}`;
      try {
        const data = await read(kind, value);
        if (kind === 'github') {
          const npubs = profileNpubs(
            [data.bio, data.blog, ...(data.social ?? [])]
              .filter((v) => typeof v === 'string')
              .join('\n'),
          );
          const domain = websiteDomain(data.blog);
          if (domain && !npubs.length) {
            try {
              npubs.push(await resolve(domain));
            } catch {
              /* Optional website discovery. */
            }
          }
          return [
            key,
            npubs.map((npub) => ({
              parameter: 'p',
              value: npub,
              from: value,
              evidenceUrl: `https://github.com/${value}`,
              verified: false,
            })),
          ];
        }
        const suggestions: DiscoveredAccount[] = [];
        for (const claim of githubClaims(data.event ?? null, value)) {
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
        const profile = profileMetadata(data.profile ?? data.event ?? null, value);
        try {
          // A domain suggests a candidate handle, but only a reciprocal link qualifies it.
          const identity = typeof profile.nip05 === 'string' ? nip05Address(profile.nip05) : null;
          const direct =
            typeof profile.website === 'string' && /^https:\/\/github\.com\//i.test(profile.website)
              ? parseSource('github', profile.website).value
              : null;
          const candidate =
            direct ??
            (identity?.name === '_'
              ? parseSource('github', identity.domain.split('.')[0]).value
              : null);
          if (
            candidate &&
            !suggestions.some((s) => s.value === candidate) &&
            !inputs.some((i) => i.kind === 'github' && i.value === candidate)
          ) {
            const github = await read('github', candidate);
            const domain = websiteDomain(github.blog);
            const publishedNpubs = profileNpubs(
              [github.bio, github.blog, ...(github.social ?? [])].join('\n'),
            );
            const matches =
              (direct && publishedNpubs.includes(value)) ||
              (domain &&
                (direct || (identity?.name === '_' && domain === identity.domain)) &&
                (await resolve(domain)) === value);
            if (matches)
              suggestions.push({
                parameter: 'gh',
                value: candidate,
                from: value,
                evidenceUrl: `https://github.com/${candidate}`,
                verified: true,
              });
          }
        } catch {
          /* Missing or mismatched profile links do not identify another account. */
        }
        return [key, suggestions];
      } catch {
        return [key, []];
      }
    }),
  );
  const existing = new Set(inputs.map(({ value }) => value));
  return [
    ...new Map(
      entries
        .flatMap(([, accounts]) => accounts)
        .filter((account) => !existing.has(account.value))
        .map((account) => [`${account.parameter}:${account.value}`, account]),
    ).values(),
  ];
}
