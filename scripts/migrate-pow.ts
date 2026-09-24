import { database } from '../server/cache.js';

const sql = database();
await sql`CREATE TABLE IF NOT EXISTS pow_sources (
  source_key text PRIMARY KEY,
  snapshot jsonb,
  fetched_at timestamptz,
  retry_at timestamptz,
  lease_until timestamptz,
  lease_token text,
  error text
)`;
await sql`CREATE TABLE IF NOT EXISTS pow_budget (bucket timestamptz PRIMARY KEY, attempts integer NOT NULL)`;
await sql`DELETE FROM pow_budget WHERE bucket < now() - interval '2 days'`;
await sql`ALTER TABLE pow_sources ADD COLUMN IF NOT EXISTS queued_until timestamptz`;
await sql`ALTER TABLE pow_sources ADD COLUMN IF NOT EXISTS job_token text`;
await sql`ALTER TABLE pow_sources ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0`;
await sql`CREATE TABLE IF NOT EXISTS pow_provider_limits (resource text PRIMARY KEY, next_at timestamptz NOT NULL)`;
console.log('PoW source cache schema ready.');
