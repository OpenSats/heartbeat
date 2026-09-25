import { parseSource } from '../src/pow/model.js';
import { queryRelay } from './relay.js';
import { githubSlot, githubCooldown } from './rate-limit.js';

async function github<T>(path: string): Promise<T> {
  await githubSlot('core');
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

// Return public source documents. Matching accounts happens only in the browser.
export async function accountEvidence(kind: string, value: string) {
  if (kind === 'github') {
    const source = parseSource('github', value);
    const profile = await github<{ login: string; bio: string | null; blog: string | null }>(
      `/users/${source.value}`,
    );
    let social: { url: string }[] = [];
    try {
      social = await github(`/users/${source.value}/social_accounts`);
    } catch {
      /* Profile bio still usable. */
    }
    return {
      login: profile.login,
      bio: profile.bio,
      blog: profile.blog,
      social: social.map(({ url }) => url).slice(0, 20),
    };
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
