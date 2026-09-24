import WebSocket from 'ws';
import { collectNgit } from './ngit.js';
import { githubSlot, githubCooldown, RetryLater } from './rate-limit.js';
import { nip19, verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import type { Activity, SearchTask, Snapshot, Source } from '../src/pow/model.js';

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
  const resource = path.startsWith('/search/') ? 'search' : 'core';
  await githubSlot(resource);
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(12000),
    redirect: 'error',
  });
  if (response.status === 403 || response.status === 429)
    throw await githubCooldown(resource, response);
  if (response.headers.get('x-ratelimit-remaining') === '0')
    await githubCooldown(resource, response);
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

async function collectGithub(
  source: Source,
  month: string,
  previous?: Snapshot | null,
): Promise<Snapshot> {
  const bounds = previous?.pending?.length ? previous.windows![0] : monthBounds(month);
  const resuming = !!previous?.pending?.length;
  if (!resuming) {
    if (source.kind === 'repo') {
      const repo = await github<{ private: boolean }>(`/repos/${source.value}`);
      if (repo.private) throw new Error('Only public repositories are supported.');
    } else await github(`/users/${source.value}`);
  }
  const pending: SearchTask[] = resuming
    ? [...previous!.pending!]
    : [
        { endpoint: 'commits', from: bounds.from, to: bounds.to, page: 1 },
        { endpoint: 'issues', from: bounds.from, to: bounds.to, page: 1 },
      ];
  const events = new Map<string, Activity>(
    (resuming ? previous!.events : []).map((event) => [event.id, event]),
  );
  let incomplete = resuming ? (previous!.searchIncomplete ?? false) : false;
  const deadline = Date.now() + 25000;
  for (let requests = 0; pending.length && requests < 5 && Date.now() < deadline; requests++) {
    const task = pending[0];
    const field = task.endpoint === 'commits' ? 'author-date' : 'created';
    const query = `${source.kind === 'repo' ? 'repo' : 'author'}:${source.value} is:public ${field}:${task.from}..${task.to}`;
    let page: Search<Commit | Issue>;
    try {
      page = await github<Search<Commit | Issue>>(
        `/search/${task.endpoint}?q=${encodeURIComponent(query)}&sort=${field}&order=desc&per_page=100&page=${task.page}`,
      );
    } catch (error) {
      // Save pages already fetched before waiting for the next provider slot.
      if (error instanceof RetryLater && requests > 0) break;
      throw error;
    }
    pending.shift();
    if (
      task.page === 1 &&
      page.total_count > 1000 &&
      Date.parse(task.to) - Date.parse(task.from) > 1000
    ) {
      const midpoint = Math.floor((Date.parse(task.from) + Date.parse(task.to)) / 2000) * 1000;
      pending.unshift(
        { ...task, to: new Date(midpoint).toISOString() },
        { ...task, from: new Date(midpoint + 1000).toISOString() },
      );
      continue;
    }
    incomplete ||= page.incomplete_results || page.total_count > 1000;
    for (const item of page.items) {
      if (task.endpoint === 'commits') {
        const c = item as Commit;
        if (c.repository.private) continue;
        events.set(c.html_url, {
          id: c.html_url,
          timestamp: c.commit.author.date,
          type: 'commit',
          title: c.commit.message.split('\n')[0],
          url: c.html_url,
          actor: c.author?.login ?? c.commit.author.name,
          repo: c.repository.full_name,
        });
      } else {
        const i = item as Issue;
        events.set(i.html_url, {
          id: i.html_url,
          timestamp: i.created_at,
          type: i.pull_request ? 'pull request' : 'issue',
          title: i.title,
          url: i.html_url,
          actor: i.user.login,
          repo: i.repository_url.split('/repos/')[1],
        });
      }
    }
    const total = task.total ?? page.total_count;
    const seen = (task.seen ?? 0) + page.items.length;
    if (seen < Math.min(total, 1000) && task.page < 10 && page.items.length)
      pending.unshift({ ...task, page: task.page + 1, total, seen });
    else if (seen < total) incomplete = true;
  }
  const exhaustive = !pending.length && !incomplete;
  return {
    events: [...events.values()],
    pending,
    searchIncomplete: incomplete,
    profileUrl: `https://github.com/${source.value}`,
    coverage: `${month}: ${pending.length ? 'Backfill in progress' : exhaustive ? 'All returned search pages fetched' : 'GitHub returned incomplete results'}. Public authored commits, issues and PRs only; reviews and merge actions are excluded. GitHub indexing can omit activity.${source.kind === 'repo' ? ' Repository context includes all contributors.' : ''}`,
    windows: [{ from: bounds.from, to: bounds.to, exhaustive, basis: 'github-search' }],
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
export async function collect(
  source: Source,
  month: string,
  previous?: Snapshot | null,
): Promise<Snapshot> {
  if (source.kind === 'ngit' || source.kind === 'grasp')
    return collectNgit(source, month, previous, monthBounds(month));
  if (source.kind !== 'nostr') return collectGithub(source, month, previous);
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
