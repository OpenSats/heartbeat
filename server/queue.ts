import { randomUUID } from 'node:crypto';
import { QueueClient } from '@vercel/queue';
import { claimRefresh, database, readCache, refresh } from './cache.js';
import { RetryLater } from './rate-limit.js';
import { sourceCacheKey, hasPending, sourcePlatform, type Source } from '../src/pow/model.js';

export const queue = new QueueClient({ region: 'iad1' });
type Job = { source: Source; month: string; token: string };

export async function enqueue(source: Source, month: string) {
  const sql = database();
  const key = sourceCacheKey(source, month);
  const token = randomUUID();
  // A short publishing lease recovers interrupted sends; workers extend it to the message TTL.
  const rows = await sql`
    INSERT INTO pow_sources (source_key, job_token, queued_until)
    VALUES (${key}, ${token}, now() + interval '2 minutes')
    ON CONFLICT (source_key) DO UPDATE SET job_token = ${token}, queued_until = now() + interval '2 minutes', failure_count = 0
    WHERE pow_sources.queued_until IS NULL OR pow_sources.queued_until < now()
    RETURNING source_key`;
  if (!rows.length) return;
  try {
    await queue.send(
      sourcePlatform(source) === 'github' ? 'pow-github' : 'pow-nostr',
      { source, month, token },
      {
        idempotencyKey: token,
        retentionSeconds: 604800,
      },
    );
    await sql`UPDATE pow_sources SET queued_until = now() + interval '7 days'
      WHERE source_key = ${key} AND job_token = ${token} AND queued_until IS NOT NULL`;
  } catch (error) {
    await sql`UPDATE pow_sources SET queued_until = NULL WHERE source_key = ${key} AND job_token = ${token}`;
    throw error;
  }
}

export const consume = queue.handleNodeCallback<Job>(
  async ({ source, month, token }, metadata) => {
    const sql = database();
    const key = sourceCacheKey(source, month);
    const [job] =
      await sql`SELECT job_token, failure_count FROM pow_sources WHERE source_key = ${key}`;
    if (job?.job_token !== token) return;
    await sql`UPDATE pow_sources SET queued_until = ${metadata.expiresAt.toISOString()}
    WHERE source_key = ${key} AND job_token = ${token}`;
    let cached = await readCache(source, month);
    try {
      if (cached.stale && job.failure_count < 5) {
        if (!cached.retry)
          throw new RetryLater(
            Math.max(3, Math.ceil((Date.parse(cached.retryAt!) - Date.now()) / 1000)),
          );
        const lease = await claimRefresh(source, month);
        if (!lease) throw new RetryLater(30);
        await refresh(source, lease, month);
        cached = await readCache(source, month);
        if (cached.error || hasPending(cached.snapshot)) {
          throw new RetryLater(
            cached.retryAt
              ? Math.max(3, Math.ceil((Date.parse(cached.retryAt) - Date.now()) / 1000))
              : 3,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof RetryLater)) throw error;
      // Publish the next checkpoint before acknowledging this delivery.
      await queue.send(
        sourcePlatform(source) === 'github' ? 'pow-github' : 'pow-nostr',
        { source, month, token },
        {
          idempotencyKey: `${metadata.messageId}:next`,
          delaySeconds: error.afterSeconds,
          retentionSeconds: Math.max(
            60,
            Math.ceil((metadata.expiresAt.getTime() - Date.now()) / 1000),
          ),
        },
      );
      return;
    }
    await sql`UPDATE pow_sources SET queued_until = NULL,
    retry_at = CASE WHEN failure_count >= 5 THEN now() + interval '1 hour' ELSE retry_at END
    WHERE source_key = ${key} AND job_token = ${token}`;
  },
  {
    visibilityTimeoutSeconds: 90,
  },
);
