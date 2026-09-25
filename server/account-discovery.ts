import { neon } from '@neondatabase/serverless';
import type { AccountEvidence } from '../src/pow/discoverAccounts.js';
import { parseSource } from '../src/pow/model.js';
import { queryRelay } from './relay.js';
import { githubDiscoverySlot, githubCooldown } from './rate-limit.js';

async function github<T>(path: string): Promise<T> {
  await githubDiscoverySlot();
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (response.status === 403 || response.status === 429)
    throw await githubCooldown('core', response);
  if (!response.ok) throw new Error('GitHub source unavailable.');
  if (response.headers.get('x-ratelimit-remaining') === '0') await githubCooldown('core', response);
  return response.json() as Promise<T>;
}

// Return independent public source documents; never persist account associations.
export async function accountEvidence(kind: string, value: string) {
  if (kind === 'github') {
    const source = parseSource('github', value);
    const sql = neon(process.env.DATABASE_URL!);
    const key = `${source.key}:profile:v1`;
    const [cached] =
      await sql`SELECT snapshot, fetched_at FROM pow_sources WHERE source_key = ${key}`;
    const age = cached ? Date.now() - Date.parse(cached.fetched_at) : Infinity;
    if (cached?.snapshot && age < 3600000) return cached.snapshot as AccountEvidence;
    try {
      const profile = await github<{
        login: string;
        bio: string | null;
        blog: string | null;
        avatar_url: string;
      }>(`/users/${source.value}`);
      // Social links are part of discovery. A failed fetch must not become a cached empty list.
      const social = await github<{ url: string }[]>(`/users/${source.value}/social_accounts`);
      const evidence: AccountEvidence = {
        login: profile.login,
        avatar: profile.avatar_url,
        bio: profile.bio,
        blog: profile.blog,
        social: social.map(({ url }) => url).slice(0, 20),
      };
      await sql`INSERT INTO pow_sources (source_key, snapshot, fetched_at) VALUES (${key}, ${JSON.stringify(evidence)}::jsonb, now())
        ON CONFLICT (source_key) DO UPDATE SET snapshot = EXCLUDED.snapshot, fetched_at = now()`;
      return evidence;
    } catch (error) {
      // Reuse the public source document during short outages without extending its lifetime.
      if (cached?.snapshot && age < 86400000) return cached.snapshot as AccountEvidence;
      throw error;
    }
  }
  if (kind === 'nostr') {
    const source = parseSource('nostr', value);
    const results = await Promise.allSettled(
      ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net'].map((url) =>
        queryRelay(url, [{ authors: [source.value], kinds: [0, 10011] }], {
          once: true,
          timeout: 5000,
        }),
      ),
    );
    const events = results
      .flatMap((r) => (r.status === 'fulfilled' ? r.value.events : []))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    // A newer empty NIP-39 list must supersede legacy kind-0 claims.
    return {
      profile: events.find((e) => e.kind === 0) ?? null,
      event: events.find((e) => e.kind === 10011) ?? events.find((e) => e.kind === 0) ?? null,
    };
  }
  if (kind === 'gist' && /^[a-f0-9]{1,64}$/i.test(value)) {
    const gist = await github<{
      public: boolean;
      owner?: { login: string };
      files?: Record<string, { content?: string; truncated?: boolean }>;
    }>(`/gists/${value}`);
    if (!gist.public) throw new Error('Only public proofs are supported.');
    const files = Object.values(gist.files ?? {}) as { content?: string; truncated?: boolean }[];
    return {
      owner: gist.owner?.login ?? null,
      content:
        files.length === 1 && !files[0].truncated && (files[0].content?.length ?? 0) <= 1000
          ? (files[0].content ?? '')
          : null,
    };
  }
  throw new Error('Unknown discovery source.');
}
