import { neon } from '@neondatabase/serverless';
import { githubSlot, githubCooldown } from './rate-limit.js';
import type { Activity, SearchTask, Snapshot, Source, GithubThreadTask } from '../src/pow/model.js';

type User = { login: string } | null;
type Commit = {
  html_url: string;
  author: User;
  commit: { message: string; author: { name: string; date: string } };
  repository: { full_name: string; private: boolean };
};
type Issue = {
  title: string;
  html_url: string;
  number: number;
  created_at: string;
  user: User;
  repository_url: string;
  pull_request?: unknown;
};
type Search<T> = { items: T[]; total_count: number; incomplete_results: boolean };
type ThreadEntry = {
  id?: number;
  event?: string;
  actor?: User;
  user?: User;
  created_at?: string;
  submitted_at?: string | null;
  html_url?: string;
  body?: string | null;
  state?: string;
};
type ThreadPage = { events: Activity[]; more: boolean; unavailable?: boolean };
export type GithubRequest = <T>(path: string) => Promise<T>;
class Gone extends Error {}

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
  if (response.status === 404 || response.status === 410)
    throw new Gone('GitHub public source is unavailable.');
  if (!response.ok) throw new Error(`GitHub is unavailable (${response.status}).`);
  return response.json() as Promise<T>;
}

const statuses: Record<string, string> = {
  closed: 'closed',
  reopened: 'open',
  merged: 'merged',
  convert_to_draft: 'draft',
  ready_for_review: 'ready',
};
export function threadActivities(task: GithubThreadTask, entries: ThreadEntry[]): Activity[] {
  const base = `https://github.com/${task.repo}`;
  const issueUrl = `${base}/issues/${task.number}`;
  const pullUrl = `${base}/pull/${task.number}`;
  return entries.flatMap((entry) => {
    let type: string;
    let category: string;
    let url: string;
    let timestamp: string | null | undefined;
    let actor: string | undefined;
    let detail: string;
    if (task.endpoint === 'reviews') {
      if (!entry.submitted_at || entry.state?.toLowerCase() === 'pending') return [];
      type = 'review';
      category = 'review';
      timestamp = entry.submitted_at;
      actor = entry.user?.login;
      url = `${pullUrl}#pullrequestreview-${entry.id}`;
      detail = `review: ${(entry.state ?? 'submitted').toLowerCase().replaceAll('_', ' ')}`;
    } else if (task.endpoint === 'review-comments') {
      type = 'code comment';
      category = 'review-comment';
      timestamp = entry.created_at;
      actor = entry.user?.login;
      url = `${pullUrl}#discussion_r${entry.id}`;
      detail = entry.body?.split('\n').find(Boolean) || 'Code comment';
    } else if (entry.event === 'commented') {
      type = 'comment';
      category = 'issue-comment';
      timestamp = entry.created_at;
      actor = entry.user?.login ?? entry.actor?.login;
      url = `${issueUrl}#issuecomment-${entry.id}`;
      detail = entry.body?.split('\n').find(Boolean) || 'Comment';
    } else if (entry.event && statuses[entry.event]) {
      type = `status: ${statuses[entry.event]}`;
      category = 'status';
      timestamp = entry.created_at;
      actor = entry.actor?.login;
      url = `${issueUrl}#event-${entry.id}`;
      detail = type;
    } else return [];
    // Missing actors must never be replaced by the issue/PR author.
    if (!entry.id || !actor || !timestamp || !Number.isFinite(Date.parse(timestamp))) return [];
    return [
      {
        id: `github:${category}:${entry.id}`,
        timestamp,
        type,
        actor,
        repo: task.repo,
        url: entry.html_url?.startsWith(`${base}/`) ? entry.html_url : url,
        title: (category === 'status' ? task.title : `${task.title} · ${detail}`).slice(0, 1000),
      },
    ];
  });
}

async function threadPage(
  task: GithubThreadTask,
  request: GithubRequest,
  publicRepos: Set<string>,
): Promise<ThreadPage> {
  // Cache public pages by thread, endpoint and page, never by a combination of people.
  const key = `github-thread:v1:${task.repo.toLowerCase()}:${task.number}:${task.endpoint}:${task.page}`;
  const sql = request === github ? neon(process.env.DATABASE_URL!) : null;
  if (sql) {
    const [row] =
      await sql`SELECT snapshot FROM pow_sources WHERE source_key = ${key} AND fetched_at > now() - interval '24 hours'`;
    if (row?.snapshot) return row.snapshot as ThreadPage;
  }
  const path =
    task.endpoint === 'timeline'
      ? `/repos/${task.repo}/issues/${task.number}/timeline`
      : `/repos/${task.repo}/pulls/${task.number}/${task.endpoint === 'reviews' ? 'reviews' : 'comments'}`;
  let page: ThreadPage;
  try {
    if (!publicRepos.has(task.repo)) {
      const repository = await request<{ private: boolean }>(`/repos/${task.repo}`);
      if (repository.private !== false)
        throw new Gone('Only public repository activity is supported.');
      publicRepos.add(task.repo);
    }
    const entries = await request<ThreadEntry[]>(`${path}?per_page=100&page=${task.page}`);
    page = { events: threadActivities(task, entries), more: entries.length === 100 };
  } catch (error) {
    if (!(error instanceof Gone)) throw error;
    page = { events: [], more: false, unavailable: true };
  }
  if (sql)
    await sql`INSERT INTO pow_sources (source_key, snapshot, fetched_at)
    VALUES (${key}, ${JSON.stringify(page)}::jsonb, now())
    ON CONFLICT (source_key) DO UPDATE SET snapshot = EXCLUDED.snapshot, fetched_at = now()`;
  return page;
}

// A merge also emits an implicit close, sometimes on the next timeline page.
export function dedupeGithubActions(events: Activity[]): Activity[] {
  const key = (event: Activity) =>
    `${event.url.split('#')[0].replace('/pull/', '/issues/')}:${Date.parse(event.timestamp)}:${event.actor.toLowerCase()}`;
  const merges = new Set(events.filter((e) => e.type === 'status: merged').map(key));
  return events.filter((event) => event.type !== 'status: closed' || !merges.has(key(event)));
}

export async function collectGithub(
  source: Source,
  bounds: { from: string; to: string },
  previous?: Snapshot | null,
  request: GithubRequest = github,
): Promise<Snapshot> {
  const resuming =
    previous?.githubVersion === 4 && !!(previous.pending?.length || previous.pendingGithub?.length);
  if (resuming && previous.windows?.[0]) bounds = previous.windows[0];
  if (!resuming) {
    if (source.kind === 'repo') {
      const repo = await request<{ private: boolean }>(`/repos/${source.value}`);
      if (repo.private) throw new Error('Only public repositories are supported.');
    } else await request(`/users/${source.value}`);
  }
  const discoveryTo = new Date().toISOString();
  const pending: SearchTask[] = resuming
    ? [...(previous.pending ?? [])]
    : [
        { endpoint: 'commits', from: bounds.from, to: bounds.to, page: 1 },
        { endpoint: 'issues', mode: 'created', from: bounds.from, to: bounds.to, page: 1 },
        // Updated dates describe the thread's latest change. An upper bound at month-end
        // would miss old actions on threads that received newer activity.
        {
          endpoint: 'issues',
          mode: source.kind === 'repo' ? 'updated' : 'involved',
          from: bounds.from,
          to: discoveryTo,
          page: 1,
        },
        ...(source.kind === 'repo'
          ? []
          : [
              {
                endpoint: 'issues' as const,
                mode: 'reviewed' as const,
                from: bounds.from,
                to: discoveryTo,
                page: 1,
              },
            ]),
      ];
  const details = resuming ? [...(previous.pendingGithub ?? [])] : [];
  const threads = new Set(resuming ? previous.githubThreads : []);
  const events = new Map<string, Activity>((previous?.events ?? []).map((e) => [e.id, e]));
  let incomplete = resuming ? (previous.searchIncomplete ?? false) : false;
  const deadline = Date.now() + 25000;
  const publicRepos = new Set<string>();
  const add = (event: Activity) => {
    const time = Date.parse(event.timestamp);
    if (time < Date.parse(bounds.from) || time > Date.parse(bounds.to)) return;
    if (source.kind === 'github' && event.actor.toLowerCase() !== source.value.toLowerCase())
      return;
    events.set(event.id, event);
  };
  for (
    let requests = 0;
    (pending.length || details.length) && requests < 5 && Date.now() < deadline;
    requests++
  ) {
    try {
      // Drain each discovered page before searching further, bounding checkpoint size.
      if (details.length) {
        const task = details[0];
        const page = await threadPage(task, request, publicRepos);
        for (const event of page.events) add(event);
        incomplete ||= !!page.unavailable;
        if (page.more) details[0] = { ...task, page: task.page + 1 };
        else details.shift();
        continue;
      }
      const task = pending[0];
      const discovery = !!task.mode && task.mode !== 'created';
      const field = task.endpoint === 'commits' ? 'author-date' : discovery ? 'updated' : 'created';
      const scope =
        source.kind === 'repo'
          ? `repo:${source.value}`
          : task.mode === 'involved'
            ? `involves:${source.value}`
            : task.mode === 'reviewed'
              ? `type:pr reviewed-by:${source.value}`
              : `author:${source.value}`;
      const query = `${scope} is:public ${field}:${task.from}..${task.to}`;
      const page = await request<Search<Commit | Issue>>(
        `/search/${task.endpoint}?q=${encodeURIComponent(query)}&sort=${field === 'author-date' ? 'author-date' : field}&order=desc&per_page=100&page=${task.page}`,
      );
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
          add({
            id: c.html_url,
            timestamp: c.commit.author.date,
            type: 'commit',
            title: c.commit.message.split('\n')[0],
            url: c.html_url,
            actor: c.author?.login ?? c.commit.author.name,
            repo: c.repository.full_name,
          });
          continue;
        }
        const i = item as Issue;
        if (!discovery && i.user)
          add({
            id: i.html_url,
            timestamp: i.created_at,
            type: i.pull_request ? 'pull request' : 'issue',
            title: i.title,
            url: i.html_url,
            actor: i.user.login,
            repo: i.repository_url.split('/repos/')[1],
          });
        const repo = /^https:\/\/api\.github\.com\/repos\/([a-z0-9-]+\/[a-z0-9_.-]+)$/i.exec(
          i.repository_url,
        )?.[1];
        if (!repo || !Number.isSafeInteger(i.number) || i.number <= 0) {
          incomplete = true;
          continue;
        }
        const key = `${repo.toLowerCase()}#${i.number}`;
        if (threads.has(key)) continue;
        threads.add(key);
        const endpoints: GithubThreadTask['endpoint'][] = i.pull_request
          ? ['timeline', 'reviews', 'review-comments']
          : ['timeline'];
        for (const endpoint of endpoints)
          details.push({ repo, number: i.number, title: i.title.slice(0, 500), endpoint, page: 1 });
      }
      const total = task.total ?? page.total_count;
      const seen = (task.seen ?? 0) + page.items.length;
      if (seen < Math.min(total, 1000) && task.page < 10 && page.items.length)
        pending.unshift({ ...task, page: task.page + 1, total, seen });
      else if (seen < total) incomplete = true;
    } catch (error) {
      // Persist successful pages before retrying a throttle or transient failure.
      if (requests > 0) break;
      throw error;
    }
  }
  const exhaustive = !pending.length && !details.length && !incomplete;
  return {
    githubVersion: 4,
    events: dedupeGithubActions([...events.values()]),
    pending,
    pendingGithub: details,
    githubThreads: [...threads],
    searchIncomplete: incomplete,
    profileUrl: `https://github.com/${source.value}`,
    coverage: `${bounds.from.slice(0, 7)}: ${pending.length || details.length ? 'Backfill in progress' : exhaustive ? 'Discovered pages fetched' : 'Some GitHub results were unavailable or incomplete'}. Commits, issues, PRs, comments, reviews and status changes, attributed to the action author.${source.kind === 'github' ? ' Cross-repository discovery can miss threads; empty days cannot confirm inactivity.' : ' Repository context includes all contributors.'}`,
    windows: [
      { ...bounds, exhaustive, basis: 'github-search', discoveryLimited: source.kind === 'github' },
    ],
  };
}
