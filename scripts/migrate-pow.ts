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
await sql`CREATE TABLE IF NOT EXISTS pow_github_control (
  id integer PRIMARY KEY CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  hourly_limit integer NOT NULL DEFAULT 1000 CHECK (hourly_limit > 0),
  core_reserve integer NOT NULL DEFAULT 1000 CHECK (core_reserve >= 0),
  search_reserve integer NOT NULL DEFAULT 5 CHECK (search_reserve >= 0)
)`;
await sql`INSERT INTO pow_github_control(id) VALUES (1) ON CONFLICT DO NOTHING`;
await sql`CREATE TABLE IF NOT EXISTS pow_github_budget (
  bucket timestamptz PRIMARY KEY, requests integer NOT NULL
)`;
await sql`CREATE TABLE IF NOT EXISTS pow_github_usage (
  bucket timestamptz NOT NULL, category text NOT NULL, requests integer NOT NULL,
  PRIMARY KEY(bucket,category)
)`;
console.log('PoW source cache schema ready.');
