import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { collect, monthBounds } from './collect.js';
import type { Snapshot, Source, SourceResult } from '../src/pow/model.js';

export function database() {
  if (!process.env.DATABASE_URL) throw new Error('Database is not configured.');
  return neon(process.env.DATABASE_URL);
}
type Row = {
  snapshot: Snapshot | null;
  fetched_at: string | null;
  retry_at: string | null;
  lease_until: string | null;
  error: string | null;
};
export async function readCache(
  source: Source,
  month: string,
): Promise<SourceResult & { retry: boolean }> {
  const sql = database();
  const key = `${source.key}:v3:${month}`;
  const rows =
    await sql`SELECT snapshot, fetched_at, retry_at, lease_until, error FROM pow_sources WHERE source_key = ${key}`;
  const row = rows[0] as Row | undefined;
  const now = Date.now();
  const closedMonthNeedsRefresh =
    month !== new Date().toISOString().slice(0, 7) &&
    !!row?.snapshot &&
    (row.snapshot.windows?.[0]?.to ?? '') < monthBounds(month).to;
  const ttl =
    closedMonthNeedsRefresh || row?.snapshot?.pending?.length
      ? 0
      : row?.snapshot?.windows?.some((w) => !w.exhaustive)
        ? 3600000
        : month === new Date().toISOString().slice(0, 7)
          ? 86400000
          : 90 * 86400000;
  return {
    source,
    snapshot: row?.snapshot ?? null,
    fetchedAt: row?.fetched_at ? new Date(row.fetched_at).toISOString() : null,
    refreshing: !!row?.lease_until && Date.parse(row.lease_until) > now,
    stale: !row?.fetched_at || Date.parse(row.fetched_at) < now - ttl,
    retry: !row?.retry_at || Date.parse(row.retry_at) <= now,
    error: row?.error ?? null,
    retryAt: row?.retry_at ? new Date(row.retry_at).toISOString() : null,
  };
}
export async function claimRefresh(source: Source, month: string) {
  const sql = database();
  const key = `${source.key}:v3:${month}`;
  const closedMonth = month !== new Date().toISOString().slice(0, 7);
  const end = monthBounds(month).to;
  const days = month === new Date().toISOString().slice(0, 7) ? 1 : 90;
  // A single global hourly budget bounds public cache-miss abuse. No visitor or URL records.
  const budget = await sql`
    INSERT INTO pow_budget (bucket, attempts) VALUES (date_trunc('hour', now()), 1)
    ON CONFLICT (bucket) DO UPDATE SET attempts = pow_budget.attempts + 1 WHERE pow_budget.attempts < 120
    RETURNING attempts`;
  if (!budget.length) return null;
  const token = randomUUID();
  const lease = await sql`
    INSERT INTO pow_sources (source_key, lease_token, lease_until) VALUES (${key}, ${token}, now() + interval '90 seconds')
    ON CONFLICT (source_key) DO UPDATE SET lease_token = ${token}, lease_until = now() + interval '90 seconds'
    WHERE (pow_sources.lease_until IS NULL OR pow_sources.lease_until < now())
      AND (pow_sources.retry_at IS NULL OR pow_sources.retry_at < now())
      AND (pow_sources.fetched_at IS NULL OR (${closedMonth} AND pow_sources.snapshot #>> '{windows,0,to}' < ${end}) OR jsonb_array_length(COALESCE(pow_sources.snapshot->'pending', '[]'::jsonb)) > 0 OR pow_sources.fetched_at < now() - CASE WHEN pow_sources.snapshot #>> '{windows,0,exhaustive}' = 'false' THEN interval '1 hour' ELSE ${days} * interval '1 day' END)
    RETURNING source_key`;
  return lease.length ? token : null;
}
export async function refresh(source: Source, token: string, month: string) {
  const sql = database();
  const key = `${source.key}:v3:${month}`;
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
      snapshot.searchIncomplete = true;
      snapshot.coverage +=
        ' This unusually busy month exceeded the response size limit; coverage is incomplete.';
    }
    await sql`UPDATE pow_sources SET snapshot = ${JSON.stringify(snapshot)}::jsonb, fetched_at = now(), error = NULL,
      retry_at = NULL, lease_until = NULL, lease_token = NULL WHERE source_key = ${key} AND lease_token = ${token}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Source unavailable.';
    await sql`UPDATE pow_sources SET error = ${message.slice(0, 250)}, retry_at = now() + interval '2 minutes',
      lease_until = NULL, lease_token = NULL WHERE source_key = ${key} AND lease_token = ${token}`;
  }
}
