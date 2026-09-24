import WebSocket from 'ws';
import { nip19, verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import type { Activity, Snapshot, Source } from '../src/pow/model.js';

const DAYS = 90;
const since = () => new Date(Date.now() - DAYS * 86400000).toISOString();
async function github<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'GitHub account or public repository not found.'
        : `GitHub is unavailable (${response.status}); try again later.`,
    );
  return response.json() as Promise<T>;
}
type Commit = {
  sha: string;
  html_url: string;
  author: { login: string } | null;
  commit: { message: string; author: { name: string; date: string } };
  repository?: { full_name: string; private: boolean };
};
type Issue = {
  id: number;
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  user: { login: string };
  repository_url: string;
  pull_request?: unknown;
};
type Search<T> = { items: T[]; total_count: number; incomplete_results: boolean };
const commitActivity = (c: Commit, repo?: string): Activity => ({
  id: c.html_url,
  timestamp: c.commit.author.date,
  type: 'commit',
  title: c.commit.message.split('\n')[0],
  url: c.html_url,
  actor: c.author?.login ?? c.commit.author.name,
  repo: repo ?? c.repository?.full_name,
});
const issueActivity = (i: Issue, repo?: string): Activity => ({
  id: i.html_url,
  timestamp: i.created_at,
  type: i.pull_request ? 'pull request' : 'issue',
  title: i.title,
  url: i.html_url,
  actor: i.user.login,
  repo: repo ?? i.repository_url.split('/repos/')[1],
});

async function collectGithub(source: Source): Promise<Snapshot> {
  const cutoff = since();
  if (source.kind === 'github') {
    await github(`/users/${source.value}`);
    const [commits, issues] = await Promise.all([
      github<Search<Commit>>(
        `/search/commits?q=${encodeURIComponent(`author:${source.value} author-date:>=${cutoff.slice(0, 10)} is:public`)}&sort=author-date&order=desc&per_page=100`,
      ),
      github<Search<Issue>>(
        `/search/issues?q=${encodeURIComponent(`author:${source.value} created:>=${cutoff.slice(0, 10)} is:public`)}&sort=created&order=desc&per_page=100`,
      ),
    ]);
    return {
      events: [
        ...commits.items
          .filter((c) => c.repository?.private === false)
          .map((c) => commitActivity(c)),
        ...issues.items.map((i) => issueActivity(i)),
      ],
      profileUrl: `https://github.com/${source.value}`,
      coverage: `Last 90 days: up to 100 authored commits and 100 authored issues/PRs from public GitHub search. Found ${commits.total_count} commits and ${issues.total_count} issues/PRs. Reviews and merge actions are not included.${commits.incomplete_results || issues.incomplete_results ? ' GitHub returned incomplete search results.' : ''}`,
    };
  }
  const repo = await github<{ private: boolean; size: number }>(`/repos/${source.value}`);
  if (repo.private) throw new Error('Only public repositories are supported.');
  const [commits, issues] = await Promise.all([
    repo.size === 0
      ? Promise.resolve([] as Commit[])
      : github<Commit[]>(`/repos/${source.value}/commits?per_page=100&since=${cutoff}`),
    github<Issue[]>(
      `/repos/${source.value}/issues?state=all&sort=created&direction=desc&per_page=100&since=${cutoff}`,
    ),
  ]);
  return {
    events: [
      ...commits.map((c) => commitActivity(c, source.value)),
      ...issues.filter((i) => i.created_at >= cutoff).map((i) => issueActivity(i, source.value)),
    ],
    profileUrl: `https://github.com/${source.value}`,
    coverage:
      'Repository context, all contributors: last 90 days, up to 100 default-branch commits and 100 recently updated issues/PRs. This is not attributed to the supplied person.',
  };
}

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
function relayEvents(url: string, author: string): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events = new Map<string, NostrEvent>();
    const ws = new WebSocket(url, { maxPayload: 128 * 1024, handshakeTimeout: 8000 });
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.terminate();
      if (error) reject(new Error(error));
      else resolve([...events.values()]);
    };
    const timer = setTimeout(() => finish('Relay timed out'), 12000);
    ws.on('open', () =>
      ws.send(
        JSON.stringify([
          'REQ',
          'pow',
          {
            authors: [author],
            kinds: [1],
            since: Math.floor(Date.now() / 1000) - DAYS * 86400,
            limit: 200,
          },
        ]),
      ),
    );
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message[1] !== 'pow') return;
        if (message[0] === 'EOSE') {
          finish();
          return;
        }
        if (message[0] === 'CLOSED') {
          finish('Relay refused the request');
          return;
        }
        if (message[0] === 'EVENT' && events.size < 200) {
          const e = message[2] as NostrEvent;
          if (
            e.pubkey === author &&
            e.kind === 1 &&
            e.created_at * 1000 >= Date.parse(since()) &&
            e.created_at <= Date.now() / 1000 + 300 &&
            verifyEvent(e)
          )
            events.set(e.id, e);
        }
      } catch {
        /* Ignore invalid or oversized protocol events. */
      }
    });
    ws.on('error', () => finish('Relay unavailable'));
    ws.on('close', () => finish('Relay closed before completing the request'));
  });
}
export async function collect(source: Source): Promise<Snapshot> {
  if (source.kind !== 'nostr') return collectGithub(source);
  const results = await Promise.allSettled(RELAYS.map((url) => relayEvents(url, source.value)));
  const successful = results.filter((r) => r.status === 'fulfilled');
  if (!successful.length)
    throw new Error('Nostr relays are unavailable. Cached activity will be retained.');
  const events = new Map<string, NostrEvent>();
  for (const result of successful) for (const e of result.value) events.set(e.id, e);
  return {
    events: [...events.values()].map((e) => ({
      id: e.id,
      timestamp: new Date(e.created_at * 1000).toISOString(),
      type: e.tags.some((t) => t[0] === 'e') ? 'reply' : 'post',
      title: e.content.slice(0, 4000),
      url: `https://njump.me/${nip19.noteEncode(e.id)}`,
      actor: source.label,
    })),
    profileUrl: `https://njump.me/${source.label}`,
    coverage: `Last 90 days of signed text notes; up to 200 per relay. ${successful.length}/${RELAYS.length} relays responded (${RELAYS.map((r) => new URL(r).hostname).join(', ')}). Relay coverage is partial; notes with event references are labeled replies.`,
  };
}
