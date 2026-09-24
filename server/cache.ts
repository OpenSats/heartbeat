import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { collect } from './collect.js';
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
export async function readCache(source: Source): Promise<SourceResult & { retry: boolean }> {
  const sql = database();
  const rows =
    await sql`SELECT snapshot, fetched_at, retry_at, lease_until, error FROM pow_sources WHERE source_key = ${source.key}`;
  const row = rows[0] as Row | undefined;
  const now = Date.now();
  return {
    source,
    snapshot: row?.snapshot ?? null,
    fetchedAt: row?.fetched_at ? new Date(row.fetched_at).toISOString() : null,
    refreshing: !!row?.lease_until && Date.parse(row.lease_until) > now,
    stale: !row?.fetched_at || Date.parse(row.fetched_at) < now - 86400000,
    retry: !row?.retry_at || Date.parse(row.retry_at) <= now,
    error: row?.error ?? null,
  };
}
export async function claimRefresh(source: Source) {
  const sql = database();
  // A single global hourly budget bounds public cache-miss abuse. No visitor or URL records.
  const budget = await sql`
    INSERT INTO pow_budget (bucket, attempts) VALUES (date_trunc('hour', now()), 1)
    ON CONFLICT (bucket) DO UPDATE SET attempts = pow_budget.attempts + 1 WHERE pow_budget.attempts < 120
    RETURNING attempts`;
  if (!budget.length) return null;
  const token = randomUUID();
  const lease = await sql`
    INSERT INTO pow_sources (source_key, lease_token, lease_until) VALUES (${source.key}, ${token}, now() + interval '90 seconds')
    ON CONFLICT (source_key) DO UPDATE SET lease_token = ${token}, lease_until = now() + interval '90 seconds'
    WHERE (pow_sources.lease_until IS NULL OR pow_sources.lease_until < now())
      AND (pow_sources.retry_at IS NULL OR pow_sources.retry_at < now())
      AND (pow_sources.fetched_at IS NULL OR pow_sources.fetched_at < now() - interval '24 hours')
    RETURNING source_key`;
  return lease.length ? token : null;
}
export async function refresh(source: Source, token: string) {
  const sql = database();
  try {
    const snapshot = await collect(source);
    snapshot.events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    await sql`UPDATE pow_sources SET snapshot = ${JSON.stringify(snapshot)}::jsonb, fetched_at = now(), error = NULL,
      retry_at = NULL, lease_until = NULL, lease_token = NULL WHERE source_key = ${source.key} AND lease_token = ${token}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Source unavailable.';
    await sql`UPDATE pow_sources SET error = ${message.slice(0, 250)}, retry_at = now() + interval '15 minutes',
      lease_until = NULL, lease_token = NULL WHERE source_key = ${source.key} AND lease_token = ${token}`;
  }
}
