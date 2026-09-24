import { nip19, type Filter } from 'nostr-tools';
import { parseGrasp } from './ngit.js';

export type Source = {
  key: string;
  kind: 'github' | 'nostr' | 'repo' | 'ngit' | 'grasp';
  value: string;
  label: string;
};
export type Activity = {
  id: string;
  timestamp: string;
  type: string;
  title: string;
  url: string;
  actor: string;
  repo?: string;
};
export type CoverageWindow = {
  from: string;
  to: string;
  exhaustive: boolean;
  basis: 'github-search' | 'relay';
};
export type SearchTask = {
  endpoint: 'commits' | 'issues';
  from: string;
  to: string;
  page: number;
  total?: number;
  seen?: number;
};
export type RelayTask = { url: string; filters: Filter[]; until: number; failures?: number };
export type Snapshot = {
  pendingRelays?: RelayTask[];
  relayIncomplete?: boolean;
  pending?: SearchTask[];
  searchIncomplete?: boolean;
  events: Activity[];
  coverage: string;
  profileUrl: string;
  windows?: CoverageWindow[];
};
export const FIRST_HISTORY_YEAR = 2008;
export function selectedYear(value: string | null, now = new Date()): number | null {
  if (!value || !/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  return year >= FIRST_HISTORY_YEAR && year <= now.getUTCFullYear() ? year : null;
}
export function activityRange(year: number | null = null, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from =
    year === null ? new Date(today.getTime() - 364 * 86400000) : new Date(Date.UTC(year, 0, 1));
  const to =
    year === null || year === now.getUTCFullYear() ? today : new Date(Date.UTC(year, 11, 31));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
export function historyMonths(year: number | null = null, now = new Date()): string[] {
  const range = activityRange(year, now);
  const month = new Date(`${range.to.slice(0, 7)}-01T00:00:00Z`);
  const result: string[] = [];
  while (month.toISOString().slice(0, 7) >= range.from.slice(0, 7)) {
    result.push(month.toISOString().slice(0, 7));
    month.setUTCMonth(month.getUTCMonth() - 1);
  }
  return result;
}
export type SourceResult = {
  source: Source;
  snapshot: Snapshot | null;
  fetchedAt: string | null;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  retryAt?: string | null;
  monthsLoaded?: number;
  monthsTotal?: number;
};

export function parseSource(kind: string, input: string): Source {
  let value = input.trim();
  if (value.length > 500) throw new Error('Source is too long.');
  if (kind === 'github') {
    value = value
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\/$/, '')
      .replace(/^@/, '')
      .toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(value))
      throw new Error('Enter a GitHub handle or profile URL.');
    return { key: `github:${value}`, kind, value, label: value };
  }
  if (kind === 'nostr' || kind === 'ngit') {
    value = value.replace(/^nostr:/, '');
    const decoded = nip19.decode(value);
    if (decoded.type !== 'npub') throw new Error('Enter a Nostr npub.');
    return {
      key: `${kind}:${decoded.data}`,
      kind,
      value: decoded.data,
      label: nip19.npubEncode(decoded.data),
    };
  }
  if (
    kind === 'grasp' ||
    (kind === 'repo' && /^(nostr:|naddr1|https:\/\/(?!github\.com\/))/i.test(value))
  )
    return parseGrasp(value);
  if (kind === 'repo') {
    value = value
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '')
      .toLowerCase();
    if (
      !/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(value) ||
      value.split('/').some((v) => v === '.' || v === '..')
    )
      throw new Error('Use owner/repo, a GitHub URL, nostr://npub/repo, an naddr, or a GRASP URL.');
    return { key: `repo:${value}`, kind, value, label: value };
  }
  throw new Error('Unknown source type.');
}

export function sourcesFromUrl(params: URLSearchParams) {
  const sources = new Map<string, Source>();
  const errors: string[] = [];
  for (const [parameter, kind] of [
    ['p', 'nostr'],
    ['gh', 'github'],
    ['ngit', 'ngit'],
    ['repo', 'repo'],
  ]) {
    for (const input of params.getAll(parameter).filter(Boolean)) {
      try {
        const source = parseSource(kind, input);
        sources.set(source.key, source);
        if (kind === 'nostr') {
          const code = parseSource('ngit', input);
          sources.set(code.key, code);
        }
      } catch (error) {
        errors.push(`${parameter}: ${(error as Error).message}`);
      }
    }
  }
  if (sources.size > 8) errors.push('Showing the first 8 sources.');
  return { sources: [...sources.values()].slice(0, 8), errors };
}

export function hasPending(snapshot: Snapshot | null | undefined) {
  return !!(snapshot?.pending?.length || snapshot?.pendingRelays?.length);
}
export function sourcePlatform(source: Source): 'github' | 'nostr' | 'ngit' {
  return source.kind === 'nostr'
    ? 'nostr'
    : source.kind === 'ngit' || source.kind === 'grasp'
      ? 'ngit'
      : 'github';
}
export function isRepository(source: Source) {
  return source.kind === 'repo' || source.kind === 'grasp';
}
export function matchesSource(source: Source, filter: string) {
  return (
    filter === 'all' ||
    (filter === 'repo' ? isRepository(source) : sourcePlatform(source) === filter)
  );
}
