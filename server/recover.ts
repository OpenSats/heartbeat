import { nip19 } from 'nostr-tools';
import { parseSource, sourceCacheKey } from '../src/pow/model.js';
import { database, readCache } from './cache.js';
import { enqueue } from './queue.js';

// Reconstruct one source, never an association between accounts. Ignore old cache versions.
export function cachedJob(key: string) {
  const match = /^(github|repo|nostr|ngit|grasp):(.+):v\d+:(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(key);
  if (!match) return null;
  const [, kind, value, month] = match;
  try {
    let input = value;
    if (kind === 'nostr' || kind === 'ngit') input = nip19.npubEncode(value);
    if (kind === 'grasp') {
      const separator = value.indexOf(':');
      input = `nostr://${nip19.npubEncode(value.slice(0, separator))}/${encodeURIComponent(value.slice(separator + 1))}`;
    }
    const source = parseSource(kind, input);
    return sourceCacheKey(source, month) === key ? { source, month } : null;
  } catch {
    return null;
  }
}

export async function recoverExpiredJobs() {
  const sql = database();
  const deadline = Date.now() + 45_000;
  // Include interrupted initial sends, but preserve the existing five-failure stop.
  // A non-null expired reservation also catches work abandoned by a timed-out worker.
  const rows = await sql`
    SELECT source_key, job_token FROM pow_sources
    WHERE job_token IS NOT NULL
      AND (queued_until < now() OR (queued_until IS NULL AND failure_count < 5 AND (
        fetched_at IS NULL
        OR jsonb_array_length(COALESCE(snapshot->'pending', '[]'::jsonb)) > 0
        OR jsonb_array_length(COALESCE(snapshot->'pendingGithub', '[]'::jsonb)) > 0
        OR jsonb_array_length(COALESCE(snapshot->'pendingRelays', '[]'::jsonb)) > 0
      )))
      AND (lease_until IS NULL OR lease_until < now())
      AND (retry_at IS NULL OR retry_at <= now())
      AND source_key ~ '^((github|repo|nostr):.+:v4|(ngit|grasp):.+:v3):[0-9]{4}-[0-9]{2}$'
    ORDER BY right(source_key, 7) DESC, queued_until ASC NULLS FIRST, source_key
    LIMIT 100`;
  let requeued = 0;
  let cleared = 0;
  let failed = 0;
  let checked = 0;
  for (let offset = 0; offset < rows.length && Date.now() < deadline; offset += 4) {
    await Promise.all(
      rows.slice(offset, offset + 4).map(async (row) => {
        const job = cachedJob(row.source_key);
        if (!job) return;
        checked++;
        try {
          const cached = await readCache(job.source, job.month);
          if (cached.refreshing || !cached.retry) return;
          if (cached.stale) {
            if (await enqueue(job.source, job.month)) requeued++;
          } else {
            // A worker may have finished its fetch before its queue acknowledgement failed.
            const clearedRows = await sql`UPDATE pow_sources SET queued_until = NULL
              WHERE source_key = ${row.source_key} AND job_token = ${row.job_token}
                AND queued_until < now()
              RETURNING source_key`;
            cleared += clearedRows.length;
          }
        } catch {
          failed++;
        }
      }),
    );
  }
  return { checked, requeued, cleared, failed };
}
