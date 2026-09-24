import WebSocket from 'ws';
import { nip19, verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import type { Activity, Snapshot, Source } from '../src/pow/model.js';

export function monthBounds(month: string) {
  const from = new Date(`${month}-01T00:00:00Z`);
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return {
    from: from.toISOString(),
    to: new Date(Math.min(next.getTime() - 1, Date.now())).toISOString(),
  };
}
async function github<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(12000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'GitHub account or public repository not found.'
        : response.status === 403 || response.status === 429
          ? 'GitHub rate limit reached. Backfill will retry shortly.'
          : `GitHub is unavailable (${response.status}).`,
    );
  return response.json() as Promise<T>;
}
type Commit = {
  html_url: string;
  author: { login: string } | null;
  commit: { message: string; author: { name: string; date: string } };
  repository: { full_name: string; private: boolean };
};
type Issue = {
  title: string;
  html_url: string;
  created_at: string;
  user: { login: string };
  repository_url: string;
  pull_request?: unknown;
};
type Search<T> = { items: T[]; total_count: number; incomplete_results: boolean };

// Split crowded intervals to get past GitHub's 1,000-result search limit.
// A bounded request budget leaves exceptionally busy months explicitly incomplete.
async function searchAll<T>(
  endpoint: string,
  query: string,
  dateField: string,
  from: string,
  to: string,
  budget: { remaining: number; deadline: number },
): Promise<{ items: T[]; exhaustive: boolean }> {
  if (budget.remaining <= 0 || Date.now() > budget.deadline)
    return { items: [], exhaustive: false };
  const q = `${query} ${dateField}:${from}..${to}`;
  const page = async (number: number) => {
    budget.remaining--;
    return github<Search<T>>(
      `/search/${endpoint}?q=${encodeURIComponent(q)}&sort=${endpoint === 'commits' ? 'author-date' : 'created'}&order=desc&per_page=100&page=${number}`,
    );
  };
  const first = await page(1);
  if (first.total_count > 1000 && Date.parse(to) - Date.parse(from) > 1000) {
    const middle = Math.floor((Date.parse(from) + Date.parse(to)) / 2000) * 1000;
    const left = await searchAll<T>(
      endpoint,
      query,
      dateField,
      from,
      new Date(middle).toISOString(),
      budget,
    );
    const right = await searchAll<T>(
      endpoint,
      query,
      dateField,
      new Date(middle + 1000).toISOString(),
      to,
      budget,
    );
    return {
      items: [...left.items, ...right.items],
      exhaustive: left.exhaustive && right.exhaustive,
    };
  }
  const items = [...first.items];
  let exhaustive = !first.incomplete_results && first.total_count <= 1000;
  const pages = Math.min(10, Math.ceil(first.total_count / 100));
  for (let number = 2; number <= pages; number++) {
    if (budget.remaining <= 0 || Date.now() > budget.deadline) {
      exhaustive = false;
      break;
    }
    const result = await page(number);
    items.push(...result.items);
    exhaustive &&= !result.incomplete_results;
  }
  return { items, exhaustive: exhaustive && items.length >= first.total_count };
}
async function collectGithub(source: Source, month: string): Promise<Snapshot> {
  const bounds = monthBounds(month);
  if (source.kind === 'repo') {
    const repo = await github<{ private: boolean }>(`/repos/${source.value}`);
    if (repo.private) throw new Error('Only public repositories are supported.');
  } else await github(`/users/${source.value}`);
  const query = `${source.kind === 'repo' ? 'repo' : 'author'}:${source.value} is:public`;
  const budget = { remaining: 24, deadline: Date.now() + 35000 };
  const commits = await searchAll<Commit>(
    'commits',
    query,
    'author-date',
    bounds.from,
    bounds.to,
    budget,
  );
  const issues = await searchAll<Issue>('issues', query, 'created', bounds.from, bounds.to, budget);
  const exhaustive = commits.exhaustive && issues.exhaustive;
  const events: Activity[] = [
    ...commits.items
      .filter((c) => c.repository.private === false)
      .map((c) => ({
        id: c.html_url,
        timestamp: c.commit.author.date,
        type: 'commit',
        title: c.commit.message.split('\n')[0],
        url: c.html_url,
        actor: c.author?.login ?? c.commit.author.name,
        repo: c.repository.full_name,
      })),
    ...issues.items.map((i) => ({
      id: i.html_url,
      timestamp: i.created_at,
      type: i.pull_request ? 'pull request' : 'issue',
      title: i.title,
      url: i.html_url,
      actor: i.user.login,
      repo: i.repository_url.split('/repos/')[1],
    })),
  ];
  return {
    events: [...new Map(events.map((e) => [e.id, e])).values()],
    profileUrl: `https://github.com/${source.value}`,
    coverage: `${month}: ${exhaustive ? 'All returned search pages fetched' : 'Search incomplete; gaps are unknown'}. Public authored commits, issues and PRs only; reviews and merge actions are excluded. GitHub search indexing can omit activity.${source.kind === 'repo' ? ' Repository context includes all contributors.' : ''}`,
    windows: [{ ...bounds, exhaustive, basis: 'github-search' }],
  };
}
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
function relayEvents(
  url: string,
  author: string,
  month: string,
): Promise<{ events: NostrEvent[]; exhaustive: boolean }> {
  return new Promise((resolve, reject) => {
    const bounds = monthBounds(month);
    const since = Math.floor(Date.parse(bounds.from) / 1000);
    let until = Math.floor(Date.parse(bounds.to) / 1000);
    const events = new Map<string, NostrEvent>();
    let batch: NostrEvent[] = [];
    let pages = 0;
    let subscription = '';
    const ws = new WebSocket(url, { maxPayload: 128 * 1024, handshakeTimeout: 8000 });
    let finished = false;
    const finish = (exhaustive: boolean, error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.terminate();
      if (error && !events.size) reject(new Error(error));
      else resolve({ events: [...events.values()], exhaustive });
    };
    const timer = setTimeout(() => finish(false, 'Relay timed out'), 35000);
    const request = () => {
      batch = [];
      subscription = `pow-${++pages}`;
      ws.send(
        JSON.stringify([
          'REQ',
          subscription,
          { authors: [author], kinds: [1], since, until, limit: 200 },
        ]),
      );
    };
    ws.on('open', request);
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message[1] !== subscription) return;
        if (message[0] === 'CLOSED') {
          finish(false, 'Relay refused request');
          return;
        }
        if (message[0] === 'EOSE') {
          ws.send(JSON.stringify(['CLOSE', subscription]));
          // Continue even below the requested limit: relays may impose lower caps.
          if (!batch.length) {
            finish(true);
            return;
          }
          const oldest = Math.min(...batch.map((e) => e.created_at));
          if (pages >= 30 || (oldest >= until && batch.length >= 200)) {
            finish(false);
            return;
          }
          until = oldest === until ? oldest - 1 : oldest;
          if (until < since) {
            finish(true);
            return;
          }
          request();
          return;
        }
        if (message[0] === 'EVENT' && batch.length < 200) {
          const e = message[2] as NostrEvent;
          if (
            e.pubkey === author &&
            e.kind === 1 &&
            e.created_at >= since &&
            e.created_at <= until &&
            verifyEvent(e)
          ) {
            batch.push(e);
            events.set(e.id, e);
          }
        }
      } catch {
        /* Ignore invalid protocol events. */
      }
    });
    ws.on('error', () => finish(false, 'Relay unavailable'));
    ws.on('close', () => finish(false, 'Relay closed before completing request'));
  });
}
export async function collect(source: Source, month: string): Promise<Snapshot> {
  if (source.kind !== 'nostr') return collectGithub(source, month);
  const results = await Promise.allSettled(
    RELAYS.map((url) => relayEvents(url, source.value, month)),
  );
  const successful = results.filter((r) => r.status === 'fulfilled');
  if (!successful.length) throw new Error('Nostr relays unavailable; cached history is retained.');
  const events = new Map<string, NostrEvent>();
  for (const result of successful) for (const e of result.value.events) events.set(e.id, e);
  return {
    events: [...events.values()].map((e) => ({
      id: e.id,
      timestamp: new Date(e.created_at * 1000).toISOString(),
      type: e.tags.some((t) => t[0] === 'e') ? 'reply' : 'post',
      title: e.content.slice(0, 4000),
      url: `https://njump.to/${nip19.noteEncode(e.id)}`,
      actor: source.label,
    })),
    profileUrl: `https://njump.to/${source.label}`,
    coverage: `${month}: paginated text notes from ${successful.length}/${RELAYS.length} relays. Relays can omit history; empty days cannot confirm inactivity. Notes with event references are labeled replies.`,
    windows: [
      {
        ...monthBounds(month),
        exhaustive: results.every((r) => r.status === 'fulfilled' && r.value.exhaustive),
        basis: 'relay',
      },
    ],
  };
}
