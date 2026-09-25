import { database } from './cache.js';
import { discoverAccounts, type AccountEvidence } from '../src/pow/discoverAccounts.js';
import { profileMetadata } from '../src/pow/accountDiscovery.js';
import { evidenceOrigin } from './preview-request.js';
import {
  activityRange,
  historyMonths,
  selectedYear,
  sourcesFromUrl,
  sourcePlatform,
  sourceCacheKey,
  type IdentityResolution,
  type Source,
  type CoverageWindow,
} from '../src/pow/model.js';

export type Platform = 'github' | 'nostr' | 'ngit';
export type Preview = {
  label: string;
  avatar?: string;
  sources: Source[];
  range: { from: string; to: string };
  year: number | null;
  days: { date: string; platform: Platform; count: number }[];
  windows: { source_key: string; windows: CoverageWindow[] | null }[];
  cachedMonths: number;
  expectedMonths: number;
  unavailable: boolean;
};
export async function loadPreview(params: URLSearchParams): Promise<Preview> {
  const year = selectedYear(params.get('year'));
  const range = activityRange(year);
  const next = new URLSearchParams(params);
  const resolutions: Record<string, IdentityResolution> = {};
  const documents = new Map<string, Promise<AccountEvidence>>();
  const addresses = new Map<string, Promise<string>>();
  // Discovery has a fixed budget; activity collection never runs on an image request.
  const signal = AbortSignal.timeout(12000);
  const json = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${evidenceOrigin()}${path}`, { signal, redirect: 'error' });
    if (!response.ok) throw new Error('Profile unavailable.');
    return response.json() as Promise<T>;
  };
  const read = (kind: string, value: string): Promise<AccountEvidence> => {
    const key = `${kind}:${value}`;
    if (!documents.has(key))
      documents.set(
        key,
        json<AccountEvidence>(`/api/pow/discover?${new URLSearchParams({ kind, value, v: '3' })}`),
      );
    return documents.get(key)!;
  };
  const resolve = (address: string): Promise<string> => {
    if (!addresses.has(address))
      addresses.set(
        address,
        json<{ npub: string }>(`/api/pow/resolve?${new URLSearchParams({ address })}`).then(
          (data) => data.npub,
        ),
      );
    return addresses.get(address)!;
  };
  const pending = sourcesFromUrl(next).pending;
  await Promise.all(
    pending.map(async (address) => {
      try {
        resolutions[address] = { npub: await resolve(address) };
      } catch {
        resolutions[address] = { error: 'Profile unavailable.' };
      }
    }),
  );
  let sources = sourcesFromUrl(next, resolutions).sources;
  const visited = new Set<string>();
  for (let round = 0; round < 3 && !signal.aborted; round++) {
    const inputs = sources
      .filter((s) => s.kind === 'github' || s.kind === 'nostr' || s.kind === 'ngit')
      .map((s) => ({
        kind: s.kind === 'github' ? 'github' : 'nostr',
        value: s.kind === 'github' ? s.value : s.label,
      }));
    const fresh = inputs.filter((input) => {
      const key = `${input.kind}:${input.value}`;
      if (visited.has(key)) return false;
      visited.add(key);
      return true;
    });
    if (!fresh.length) break;
    const found = await discoverAccounts(fresh, read, resolve);
    let changed = false;
    for (const account of found) {
      if (inputs.some((i) => i.value === account.value)) continue;
      const trial = new URLSearchParams(next);
      trial.append(account.parameter, account.value);
      const parsed = sourcesFromUrl(trial, resolutions);
      if (parsed.errors.length) continue;
      next.append(account.parameter, account.value);
      sources = parsed.sources;
      changed = true;
    }
    if (!changed) break;
  }
  let label =
    params.get('p') ||
    params.get('gh') ||
    params.get('ngit') ||
    params.get('repo') ||
    'Public activity';
  const github = sources.find((s) => s.kind === 'github');
  const nostr = sources.find((s) => s.kind === 'nostr' || s.kind === 'ngit');
  const profiles = await Promise.allSettled([
    github ? read('github', github.value) : Promise.resolve(null),
    nostr ? read('nostr', nostr.label) : Promise.resolve(null),
  ]);
  const gh = profiles[0].status === 'fulfilled' ? profiles[0].value : null;
  const np = profiles[1].status === 'fulfilled' ? profiles[1].value : null;
  const metadata = nostr ? profileMetadata(np?.profile ?? null, nostr.label) : {};
  if (nostr && typeof metadata.nip05 === 'string' && label.includes('npub1')) {
    try {
      if ((await resolve(metadata.nip05)) === nostr.label)
        label = metadata.nip05.replace(/^_@/, '');
    } catch {
      /* Keep the npub. */
    }
  }
  const picture = typeof metadata.picture === 'string' ? metadata.picture : undefined;
  const avatar =
    params.has('gh') && !params.has('p') ? (gh?.avatar ?? picture) : (picture ?? gh?.avatar);
  const months = historyMonths(year);
  const keys = sources.flatMap((s) => months.map((month) => sourceCacheKey(s, month)));
  const result: Preview = {
    label,
    avatar,
    sources,
    range,
    year,
    days: [],
    windows: [],
    cachedMonths: 0,
    expectedMonths: keys.length,
    unavailable: pending.some((p) => !!resolutions[p]?.error),
  };
  if (!keys.length) return result;
  try {
    const sql = database();
    // Aggregate in Postgres so an image never downloads entire event histories.
    const rows = await sql`
      WITH cached AS (
        SELECT wanted.source_key,
          CASE WHEN current.snapshot IS NOT NULL THEN current.snapshot
               ELSE legacy.snapshot || '{"windows": null}'::jsonb END AS snapshot
        FROM unnest(${keys}::text[]) AS wanted(source_key)
        LEFT JOIN pow_sources current ON current.source_key = wanted.source_key
        LEFT JOIN pow_sources legacy ON legacy.source_key = replace(wanted.source_key, ':v4:', ':v3:')
        WHERE current.snapshot IS NOT NULL OR legacy.snapshot IS NOT NULL
      ), unique_events AS (
        SELECT DISTINCT ON (e->>'id') source_key, e->>'timestamp' AS timestamp
        FROM cached, jsonb_array_elements(snapshot->'events') e
        WHERE left(e->>'timestamp', 10) >= ${range.from} AND left(e->>'timestamp', 10) <= ${range.to}
        ORDER BY e->>'id', array_position(${keys}::text[], source_key)
      ), counts AS (
        SELECT left(timestamp, 10) AS date,
          CASE WHEN source_key LIKE 'nostr:%' THEN 'nostr'
               WHEN source_key LIKE 'ngit:%' OR source_key LIKE 'grasp:%' THEN 'ngit'
               ELSE 'github' END AS platform, count(*)::integer AS count
        FROM unique_events GROUP BY 1, 2
      )
      SELECT (SELECT coalesce(jsonb_agg(counts), '[]'::jsonb) FROM counts) AS days,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('source_key', source_key, 'windows', snapshot->'windows')), '[]'::jsonb) FROM cached) AS windows`;
    result.days = rows[0].days as Preview['days'];
    result.windows = rows[0].windows as Preview['windows'];
    result.cachedMonths = result.windows.length;
  } catch {
    result.unavailable = true;
  }
  return result;
}
export function dayCovered(preview: Preview, date: string) {
  const from = Date.parse(`${date}T00:00:00Z`);
  return (
    preview.sources.length > 0 &&
    preview.sources.every(
      (source) =>
        sourcePlatform(source) === 'github' &&
        preview.windows.some(
          (row) =>
            row.source_key === sourceCacheKey(source, date.slice(0, 7)) &&
            row.windows?.some(
              (w) =>
                w.exhaustive &&
                !w.discoveryLimited &&
                Date.parse(w.from) <= from &&
                Date.parse(w.to) >= from + 86400000 - 1,
            ),
        ),
    )
  );
}
