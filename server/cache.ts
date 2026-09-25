import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { RetryLater } from './rate-limit.js';
import { collect, monthBounds } from './collect.js';
import {
  sourceCacheKey,
  hasPending,
  type Snapshot,
  type Source,
  type SourceResult,
} from '../src/pow/model.js';

export function database() {
  if (!process.env.DATABASE_URL) throw new Error('Database is not configured.');
  return neon(process.env.DATABASE_URL);
}
type Row = {
  snapshot: Snapshot | null;
  fetched_at: string | null;
  retry_at: string | null;
  lease_until: string | null;
  queued_until: string | null;
  error: string | null;
};
export async function readCache(
  source: Source,
  month: string,
): Promise<SourceResult & { retry: boolean }> {
  const sql = database();
  const key = sourceCacheKey(source, month);
  const rows =
    await sql`SELECT snapshot, fetched_at, retry_at, lease_until, queued_until, error FROM pow_sources WHERE source_key = ${key}`;
  const row = rows[0] as Row | undefined;
  let snapshot = row?.snapshot ?? null;
  let fetchedAt = row?.fetched_at;
  // Display existing history immediately while the expanded collector fills v4.
  if (!snapshot && (source.kind === 'github' || source.kind === 'repo')) {
    const legacyKey = `${source.key}:v3:${month}`;
    const [legacy] =
      await sql`SELECT snapshot, fetched_at FROM pow_sources WHERE source_key = ${legacyKey}`;
    if (legacy?.snapshot) {
      const old = legacy.snapshot as Snapshot;
      snapshot = { ...old, windows: old.windows?.map((w) => ({ ...w, exhaustive: false })) };
      fetchedAt = legacy.fetched_at;
    }
  }
  const now = Date.now();
  const closedMonthNeedsRefresh =
    month !== new Date().toISOString().slice(0, 7) &&
    !!row?.snapshot &&
    (row.snapshot.windows?.[0]?.to ?? '') < monthBounds(month).to;
  const ttl =
    closedMonthNeedsRefresh || hasPending(row?.snapshot)
      ? 0
      : row?.snapshot?.windows?.some((w) => !w.exhaustive)
        ? 3600000
        : month === new Date().toISOString().slice(0, 7)
          ? 86400000
          : Infinity;
  return {
    source,
    snapshot,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    refreshing:
      (!!row?.lease_until && Date.parse(row.lease_until) > now) ||
      (!!row?.queued_until && Date.parse(row.queued_until) > now),
    stale: !row?.fetched_at || Date.parse(row.fetched_at) < now - ttl,
    retry: !row?.retry_at || Date.parse(row.retry_at) <= now,
    error: row?.error ?? null,
    retryAt: row?.retry_at ? new Date(row.retry_at).toISOString() : null,
  };
}
export async function claimRefresh(source: Source, month: string) {
  const sql = database();
  const key = sourceCacheKey(source, month);
  const closedMonth = month !== new Date().toISOString().slice(0, 7);
  const end = monthBounds(month).to;
  const token = randomUUID();
  const lease = await sql`
    INSERT INTO pow_sources (source_key, lease_token, lease_until) VALUES (${key}, ${token}, now() + interval '90 seconds')
    ON CONFLICT (source_key) DO UPDATE SET lease_token = ${token}, lease_until = now() + interval '90 seconds'
    WHERE (pow_sources.lease_until IS NULL OR pow_sources.lease_until < now())
      AND (pow_sources.retry_at IS NULL OR pow_sources.retry_at < now())
      AND (pow_sources.fetched_at IS NULL OR (${closedMonth} AND pow_sources.snapshot #>> '{windows,0,to}' < ${end}) OR jsonb_array_length(COALESCE(pow_sources.snapshot->'pending', '[]'::jsonb)) > 0 OR jsonb_array_length(COALESCE(pow_sources.snapshot->'pendingGithub', '[]'::jsonb)) > 0 OR jsonb_array_length(COALESCE(pow_sources.snapshot->'pendingRelays', '[]'::jsonb)) > 0 OR (pow_sources.snapshot #>> '{windows,0,exhaustive}' = 'false' AND pow_sources.fetched_at < now() - interval '1 hour') OR (NOT ${closedMonth} AND pow_sources.fetched_at < now() - interval '24 hours'))
    RETURNING source_key`;
  return lease.length ? token : null;
}
export async function refresh(source: Source, token: string, month: string) {
  const sql = database();
  const key = sourceCacheKey(source, month);
  try {
    const previous = await readCache(source, month);
    const snapshot = await collect(source, month, previous.snapshot);
    // Bound a single response below Vercel's payload limit without implying full coverage.
    snapshot.events = snapshot.events.map((event) => ({
      ...event,
      title: event.title.slice(0, 1000),
    }));
    snapshot.events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 3_000_000) {
      while (snapshot.events.length && Buffer.byteLength(JSON.stringify(snapshot)) > 3_000_000)
        snapshot.events.splice(-100);
      snapshot.windows = snapshot.windows?.map((window) => ({ ...window, exhaustive: false }));
      snapshot.pending = [];
      snapshot.pendingRelays = [];
      snapshot.pendingGithub = [];
      snapshot.githubThreads = [];
      snapshot.searchIncomplete = true;
      snapshot.coverage +=
        ' This unusually busy month exceeded the response size limit; coverage is incomplete.';
    }
    await sql`UPDATE pow_sources SET snapshot = ${JSON.stringify(snapshot)}::jsonb, fetched_at = now(), error = NULL, failure_count = 0,
      retry_at = NULL, lease_until = NULL, lease_token = NULL WHERE source_key = ${key} AND lease_token = ${token}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Source unavailable.';
    const delay = error instanceof RetryLater ? error.afterSeconds : 120;
    await sql`UPDATE pow_sources SET error = ${message.slice(0, 250)}, failure_count = failure_count + ${error instanceof RetryLater ? 0 : 1}, retry_at = now() + ${delay} * interval '1 second',
      lease_until = NULL, lease_token = NULL WHERE source_key = ${key} AND lease_token = ${token}`;
  }
}
