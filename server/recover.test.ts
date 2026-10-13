import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database } from './cache.js';
import { recoveryCandidates } from './recover.js';

test(
  'recovery selects abandoned and partial months, respecting leases and retry stops',
  { skip: !process.env.DATABASE_URL },
  async () => {
    // Run the actual selection against a read-only CTE, never production rows.
    const capture = ((strings: TemplateStringsArray) => strings.join('')) as unknown as ReturnType<
      typeof database
    >;
    const query = recoveryCandidates(capture) as unknown as string;
    const now = Date.now();
    const past = new Date(now - 3600000).toISOString();
    const future = new Date(now + 3600000).toISOString();
    const complete = { windows: [{ to: '2025-01-31T23:59:59.999Z' }] };
    const row = (name: string, changes = {}) => ({
      source_key: `github:${name}:v4:2025-01`,
      job_token: null,
      snapshot: complete,
      fetched_at: past,
      queued_until: null,
      lease_until: null,
      retry_at: null,
      failure_count: 0,
      ...changes,
    });
    const fixtures = [
      row('complete'),
      row('never-fetched', { snapshot: null, fetched_at: null }),
      row('partial-month', { snapshot: { windows: [{ to: '2025-01-25T00:00:00.000Z' }] } }),
      row('pending', { snapshot: { ...complete, pending: [{}] } }),
      row('expired', { queued_until: past }),
      row('leased', { snapshot: null, lease_until: future }),
      row('queued', { snapshot: null, queued_until: future }),
      row('cooldown', { snapshot: null, retry_at: future }),
      row('stopped', { snapshot: null, queued_until: past, failure_count: 5 }),
      { ...row('profile', { snapshot: null }), source_key: 'github:someone:profile:v1' },
    ];
    const rows = await database().query(
      `WITH pow_sources AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(source_key text, job_token uuid, snapshot jsonb, fetched_at timestamptz, queued_until timestamptz, lease_until timestamptz, retry_at timestamptz, failure_count integer)) ${query}`,
      [JSON.stringify(fixtures)],
    );
    assert.deepEqual(
      rows.map((r) => r.source_key).sort(),
      ['expired', 'never-fetched', 'partial-month', 'pending']
        .map((n) => `github:${n}:v4:2025-01`)
        .sort(),
    );
  },
);
