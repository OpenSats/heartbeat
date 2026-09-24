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
console.log('PoW source cache schema ready.');
