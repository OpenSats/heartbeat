import { database } from '../server/cache.js';
import { powGithubToken } from '../server/github-budget.js';

const sql = database();
const command = process.argv[2] ?? 'status';
if (command === 'pause') {
  await sql`UPDATE pow_github_control SET enabled=false WHERE id=1`;
  // Older deployments only understand provider cooldowns.
  await sql`INSERT INTO pow_provider_limits(resource,next_at)
    VALUES ('core',now()+interval '30 days'),('search',now()+interval '30 days')
    ON CONFLICT(resource) DO UPDATE SET next_at=GREATEST(pow_provider_limits.next_at,EXCLUDED.next_at)`;
} else if (command === 'resume') {
  const token = powGithubToken();
  const [control] = await sql`SELECT * FROM pow_github_control WHERE id=1`;
  if (!control) throw new Error('Run the database migration first.');
  // This endpoint does not consume GitHub's primary rate limit.
  const response = await fetch('https://api.github.com/rate_limit', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Cannot verify GitHub quota (${response.status}).`);
  const { resources } = (await response.json()) as {
    resources?: { core?: { remaining: number }; search?: { remaining: number } };
  };
  if (
    !((resources?.core?.remaining ?? -1) > control.core_reserve) ||
    !((resources?.search?.remaining ?? -1) > control.search_reserve)
  )
    throw new Error(
      'Not enough GitHub quota above the configured reserve. Collection remains paused.',
    );
  await sql.transaction([
    sql`UPDATE pow_provider_limits SET next_at=now() WHERE resource IN ('core','search')`,
    sql`UPDATE pow_github_control SET enabled=true WHERE id=1`,
  ]);
} else if (command !== 'status') throw new Error('Use status, pause, or resume.');
console.log('Control', await sql`SELECT * FROM pow_github_control WHERE id=1`);
console.log(
  'This hour',
  await sql`SELECT bucket,requests FROM pow_github_budget WHERE bucket=date_trunc('hour',now())`,
);
console.log(
  'Usage by category (24h)',
  await sql`SELECT category,sum(requests) AS requests FROM pow_github_usage WHERE bucket>now()-interval '24 hours' GROUP BY category ORDER BY requests DESC`,
);
console.log(
  'Cooldowns',
  await sql`SELECT resource,next_at FROM pow_provider_limits WHERE resource IN ('core','search')`,
);
