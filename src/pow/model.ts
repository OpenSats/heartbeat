import { nip19 } from 'nostr-tools';

export type Source = {
  key: string;
  kind: 'github' | 'nostr' | 'repo';
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
export type Snapshot = {
  events: Activity[];
  coverage: string;
  profileUrl: string;
  windows?: CoverageWindow[];
};
export function historyMonths(now = new Date()): string[] {
  const oldest = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 364 * 86400000,
  );
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const result: string[] = [];
  while (month.getTime() >= Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth(), 1)) {
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
  if (kind === 'nostr') {
    value = value.replace(/^nostr:/, '');
    const decoded = nip19.decode(value);
    if (decoded.type !== 'npub') throw new Error('Enter a Nostr npub.');
    return {
      key: `nostr:${decoded.data}`,
      kind,
      value: decoded.data,
      label: nip19.npubEncode(decoded.data),
    };
  }
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
      throw new Error('The MVP supports GitHub repositories: owner/repo or a github.com URL.');
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
    ['repo', 'repo'],
  ]) {
    for (const input of params.getAll(parameter).filter(Boolean)) {
      try {
        const source = parseSource(kind, input);
        sources.set(source.key, source);
      } catch (error) {
        errors.push(`${parameter}: ${(error as Error).message}`);
      }
    }
  }
  if (sources.size > 8) errors.push('Showing the first 8 sources.');
  return { sources: [...sources.values()].slice(0, 8), errors };
}
