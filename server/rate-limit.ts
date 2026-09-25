import { neon } from '@neondatabase/serverless';

export class RetryLater extends Error {
  constructor(
    public afterSeconds: number,
    message = 'Waiting for GitHub. Backfill will resume automatically.',
  ) {
    super(message);
  }
}

// Shared by preview and production, just like the source cache.
export async function githubSlot(resource: string, waited = false): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);
  const spacing = resource === 'search' ? 2200 : 200;
  const rows = await sql`
    INSERT INTO pow_provider_limits (resource, next_at) VALUES (${resource}, now() + ${spacing} * interval '1 millisecond')
    ON CONFLICT (resource) DO UPDATE SET next_at = now() + ${spacing} * interval '1 millisecond'
    WHERE pow_provider_limits.next_at <= now() RETURNING resource`;
  if (!rows.length) {
    const [row] = await sql`SELECT next_at FROM pow_provider_limits WHERE resource = ${resource}`;
    const seconds = Math.max(1, Math.ceil((Date.parse(row.next_at) - Date.now()) / 1000));
    if (!waited && seconds <= 3) {
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return githubSlot(resource, true);
    }
    throw new RetryLater(Math.max(3, seconds));
  }
}

// Reserve a near-future core slot so interactive discovery cannot be starved by backfills.
// Long provider cooldowns remain untouched and are returned to the browser for retry.
export async function githubDiscoverySlot(): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = await sql`
    INSERT INTO pow_provider_limits (resource, next_at) VALUES ('core', now() + interval '200 milliseconds')
    ON CONFLICT (resource) DO UPDATE SET next_at = GREATEST(pow_provider_limits.next_at, now()) + interval '200 milliseconds'
    WHERE pow_provider_limits.next_at <= now() + interval '3 seconds'
    RETURNING next_at - interval '200 milliseconds' AS ready_at`;
  if (!rows.length) {
    const [row] = await sql`SELECT next_at FROM pow_provider_limits WHERE resource = 'core'`;
    throw new RetryLater(Math.max(3, Math.ceil((Date.parse(row.next_at) - Date.now()) / 1000)));
  }
  const delay = Date.parse(rows[0].ready_at) - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

export async function githubCooldown(resource: string, response: Response) {
  const retry = Number(response.headers.get('retry-after'));
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  const until = Math.max(
    Date.now() + (retry || 60) * 1000,
    response.headers.get('x-ratelimit-remaining') === '0' ? reset + 1000 : 0,
  );
  const sql = neon(process.env.DATABASE_URL!);
  await sql`INSERT INTO pow_provider_limits (resource, next_at) VALUES (${resource}, ${new Date(until).toISOString()})
    ON CONFLICT (resource) DO UPDATE SET next_at = GREATEST(pow_provider_limits.next_at, EXCLUDED.next_at)`;
  return new RetryLater(Math.ceil((until - Date.now()) / 1000));
}
