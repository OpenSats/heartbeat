import { database } from './cache.js';
import { RetryLater } from './rate-limit.js';

export function powGithubToken() {
  const token = process.env.POW_GITHUB_TOKEN;
  if (!token || token === process.env.GITHUB_TOKEN)
    throw new RetryLater(
      3600,
      'GitHub collection is paused until a separate PoW credential is configured.',
    );
  return token;
}

export async function reserveGithubRequest(resource: string, path: string) {
  const token = powGithubToken();
  const sql = database();
  const [control] =
    await sql`SELECT enabled, hourly_limit, core_reserve, search_reserve FROM pow_github_control WHERE id = 1`;
  if (!control?.enabled) throw new RetryLater(3600, 'GitHub collection is paused.');
  const rows = await sql`
    INSERT INTO pow_github_budget (bucket, requests)
    VALUES (date_trunc('hour', now()), 1)
    ON CONFLICT (bucket) DO UPDATE SET requests = pow_github_budget.requests + 1
      WHERE pow_github_budget.requests < ${control.hourly_limit}
    RETURNING requests`;
  if (!rows.length) {
    const [clock] =
      await sql`SELECT extract(epoch FROM (date_trunc('hour',now()) + interval '1 hour' - now())) AS seconds`;
    throw new RetryLater(
      Math.ceil(Number(clock.seconds)) + 1,
      'GitHub hourly budget reached. Backfill will resume automatically.',
    );
  }
  // Aggregate costs only. Do not store handles, repositories, or account associations.
  const category = path.startsWith('/search/')
    ? 'search'
    : path.startsWith('/users/')
      ? 'profiles'
      : path.startsWith('/gists/')
        ? 'proofs'
        : path.endsWith('/timeline?per_page=100&page=1')
          ? 'timeline'
          : path.includes('/timeline?')
            ? 'timeline'
            : path.includes('/reviews?')
              ? 'reviews'
              : path.includes('/comments?')
                ? 'comments'
                : 'other';
  await sql`INSERT INTO pow_github_usage (bucket, category, requests)
    VALUES (date_trunc('hour',now()), ${category}, 1)
    ON CONFLICT (bucket,category) DO UPDATE SET requests=pow_github_usage.requests+1`;
  return { token, reserve: resource === 'search' ? control.search_reserve : control.core_reserve };
}

export function quotaPauseUntil(response: Response, reserve: number, now = Date.now()) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  if (remaining === null || !Number.isFinite(Number(remaining)) || Number(remaining) > reserve)
    return null;
  return Math.max(now + 60_000, Number.isFinite(reset) ? reset + 1000 : 0);
}

export async function observeGithubQuota(resource: string, response: Response, reserve: number) {
  const until = quotaPauseUntil(response, reserve);
  if (until === null) return;
  const sql = database();
  await sql`INSERT INTO pow_provider_limits(resource,next_at) VALUES (${resource},${new Date(until).toISOString()})
    ON CONFLICT(resource) DO UPDATE SET next_at=GREATEST(pow_provider_limits.next_at,EXCLUDED.next_at)`;
}
