import type { Event, EventType } from '../../src/types';

// --- Provider identity ------------------------------------------------------
//
// This provider speaks the GitLab REST API v4. It is currently hardcoded to
// gitlab.com. Self-hosted GitLab support (with a configurable base URL and
// per-instance host label) is deferred to a later PR, similar to how
// self-hosted Forgejo/Gitea was deferred until after the Codeberg-only PR.

export const GITLAB_BASE_URL = 'https://gitlab.com/api/v4';
export const GITLAB_HOST = 'gitlab';

function repoKeyFor(host: string, ownerName: string): string {
  return `${host}:${ownerName}`;
}

function actorKeyFor(host: string, actor: string): string {
  return `${host}:${actor}`;
}

// --- Configurable knobs (env vars override defaults) ------------------------

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  }
  return Math.floor(n);
}

const COMMITS_PAGE_SIZE = intFromEnv('HEARTBEAT_COMMITS_PAGE_SIZE', 50);
const MRS_PAGE_SIZE = intFromEnv('HEARTBEAT_PRS_PAGE_SIZE', 50);
const ISSUES_PAGE_SIZE = intFromEnv('HEARTBEAT_ISSUES_PAGE_SIZE', 50);
const RELEASES_PAGE_SIZE = intFromEnv('HEARTBEAT_RELEASES_PAGE_SIZE', 20);

const COMMITS_MAX_PER_REPO = intFromEnv('HEARTBEAT_COMMITS_MAX_PER_REPO', 5000);
const MRS_MAX_PER_REPO = intFromEnv('HEARTBEAT_PRS_MAX_PER_REPO', 1000);
const ISSUES_MAX_PER_REPO = intFromEnv('HEARTBEAT_ISSUES_MAX_PER_REPO', 1000);
const RELEASES_MAX_PER_REPO = intFromEnv('HEARTBEAT_RELEASES_MAX_PER_REPO', 200);

// --- REST response shapes ---------------------------------------------------
//
// Only fields we actually read are typed. Anything else from the API is
// ignored.

type GitLabUser = {
  username?: string | null;
  name?: string | null;
} | null | undefined;

type GitLabCommit = {
  id: string;
  short_id: string;
  title: string;
  message?: string;
  created_at: string;
  committed_date?: string;
  authored_date?: string;
  author_name?: string | null;
  author_email?: string | null;
  web_url?: string;
};

type GitLabMR = {
  iid: number;
  title: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  author: GitLabUser;
  merged_by?: GitLabUser;
};

type GitLabIssue = {
  iid: number;
  title: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  state: 'opened' | 'closed';
  author: GitLabUser;
};

type GitLabRelease = {
  tag_name: string;
  name: string | null;
  description?: string | null;
  created_at: string;
  released_at: string | null;
  author?: GitLabUser;
  _links?: { self?: string };
};

type GitLabProject = {
  id: number;
  path_with_namespace: string;
  default_branch: string | null;
  web_url: string;
};

// --- HTTP client ------------------------------------------------------------

export type GitLabClient = {
  baseUrl: string;
  host: string;
  get: <T>(path: string) => Promise<{ status: number; body: T | null }>;
};

export function getGitLabToken(): string | undefined {
  const t = process.env.GITLAB_TOKEN;
  return t && t !== '' ? t : undefined;
}

export function makeGitLabClient(options: {
  baseUrl: string;
  host: string;
  token?: string;
}): GitLabClient {
  const { baseUrl, host, token } = options;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'heartbeat365/gitlab-provider',
  };
  if (token) {
    // GitLab uses PRIVATE-TOKEN, not Authorization: token <t>.
    headers['PRIVATE-TOKEN'] = token;
  }

  return {
    baseUrl,
    host,
    async get<T>(path: string) {
      const url = `${baseUrl}${path}`;
      const res = await fetch(url, { headers });
      if (res.status === 404) {
        return { status: 404, body: null };
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as T;
      return { status: res.status, body };
    },
  };
}

// GitLab requires the namespaced project path to be URL-encoded when used as
// an ID. For "gitlab-org/cli" this becomes "gitlab-org%2Fcli"; for nested
// groups "a/b/c" becomes "a%2Fb%2Fc".
function encodeProjectId(ownerName: string): string {
  return encodeURIComponent(ownerName);
}

// --- Pagination -------------------------------------------------------------

async function paginate<
  T extends { updated_at?: string; created_at?: string; released_at?: string | null },
>(
  client: GitLabClient,
  pathBase: string,
  pageSize: number,
  maxNodes: number,
  cutoffMs: number,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  const sep = pathBase.includes('?') ? '&' : '?';

  while (all.length < maxNodes) {
    const perPage = Math.min(pageSize, maxNodes - all.length);
    const path = `${pathBase}${sep}page=${page}&per_page=${perPage}`;
    const { body } = await client.get<T[]>(path);
    if (!body || body.length === 0) break;

    all.push(...body);

    const last = body[body.length - 1];
    const lastTs = last?.updated_at ?? last?.released_at ?? last?.created_at;
    if (lastTs && Date.parse(lastTs) < cutoffMs) break;

    if (body.length < perPage) break;
    page += 1;
  }

  return all;
}

async function fetchCommits(
  client: GitLabClient,
  projectId: string,
  defaultBranch: string,
  sinceISO: string,
): Promise<GitLabCommit[]> {
  const all: GitLabCommit[] = [];
  let page = 1;

  while (all.length < COMMITS_MAX_PER_REPO) {
    const perPage = Math.min(COMMITS_PAGE_SIZE, COMMITS_MAX_PER_REPO - all.length);
    const path =
      `/projects/${projectId}/repository/commits` +
      `?ref_name=${encodeURIComponent(defaultBranch)}` +
      `&since=${encodeURIComponent(sinceISO)}` +
      `&page=${page}&per_page=${perPage}`;

    const { body } = await client.get<GitLabCommit[]>(path);
    if (!body || body.length === 0) break;

    all.push(...body);

    if (body.length < perPage) break;
    page += 1;
  }

  return all;
}

// --- Event shaping ----------------------------------------------------------

type EventInput = {
  host: string;
  repo: string;
  type: EventType;
  nativeId: string;
  timestamp: string;
  actor: string;
  title: string;
  url: string;
  shortId: string;
};

function makeEvent(e: EventInput): Event {
  const repoKey = repoKeyFor(e.host, e.repo);
  const actorKey = actorKeyFor(e.host, e.actor);

  return {
    id: `${repoKey}:${e.type}:${e.nativeId}`,
    host: e.host,
    repoKey,
    repo: e.repo,
    type: e.type,
    timestamp: e.timestamp,
    actorKey,
    actor: e.actor,
    title: e.title,
    url: e.url,
    shortId: e.shortId,
  };
}

function actorUsername(u: GitLabUser, fallback?: string | null): string {
  return u?.username ?? u?.name ?? fallback ?? 'unknown';
}

function commitTimestamp(c: GitLabCommit): string | null {
  return c.committed_date ?? c.authored_date ?? c.created_at ?? null;
}

function commitToEvents(host: string, repo: string, c: GitLabCommit, webBase: string): Event[] {
  const timestamp = commitTimestamp(c);
  if (!timestamp) return [];

  const actor = actorUsername(null, c.author_name);
  const url = c.web_url ?? `${webBase}/-/commit/${c.id}`;
  const headline = (c.title ?? c.message?.split('\n', 1)[0] ?? '').trim();

  return [
    makeEvent({
      host,
      repo,
      type: 'commit',
      nativeId: c.id,
      timestamp,
      actor,
      title: headline,
      url,
      shortId: c.short_id,
    }),
  ];
}

function mrToEvents(host: string, repo: string, m: GitLabMR): Event[] {
  const common = {
    host,
    repo,
    nativeId: String(m.iid),
    title: m.title,
    url: m.web_url,
    shortId: `!${m.iid}`,
  };
  const events: Event[] = [
    makeEvent({
      ...common,
      type: 'pr_opened',
      timestamp: m.created_at,
      actor: actorUsername(m.author),
    }),
  ];
  if (m.state === 'merged' && m.merged_at) {
    events.push(
      makeEvent({
        ...common,
        type: 'pr_merged',
        timestamp: m.merged_at,
        actor: actorUsername(m.merged_by ?? m.author),
      }),
    );
  } else if (m.state === 'closed' && m.closed_at) {
    events.push(
      makeEvent({
        ...common,
        type: 'pr_closed',
        timestamp: m.closed_at,
        actor: actorUsername(m.author),
      }),
    );
  }
  return events;
}

function issueToEvents(host: string, repo: string, i: GitLabIssue): Event[] {
  const common = {
    host,
    repo,
    nativeId: String(i.iid),
    title: i.title,
    url: i.web_url,
    shortId: `#${i.iid}`,
    actor: actorUsername(i.author),
  };
  const events: Event[] = [
    makeEvent({ ...common, type: 'issue_opened', timestamp: i.created_at }),
  ];
  if (i.closed_at) {
    events.push(makeEvent({ ...common, type: 'issue_closed', timestamp: i.closed_at }));
  }
  return events;
}

function releaseToEvents(
  host: string,
  repo: string,
  r: GitLabRelease,
  webBase: string,
): Event[] {
  const timestamp = r.released_at ?? r.created_at;
  if (!timestamp) return [];

  return [
    makeEvent({
      host,
      repo,
      type: 'release',
      nativeId: r.tag_name,
      timestamp,
      actor: actorUsername(r.author),
      title: r.name ?? r.tag_name,
      url: `${webBase}/-/releases/${encodeURIComponent(r.tag_name)}`,
      shortId: r.tag_name,
    }),
  ];
}

// --- Public entry point -----------------------------------------------------

export type GitLabFetchResult = {
  events: Event[];
  ok: boolean;
  reason?: string;
};

export async function fetchGitLabRepo(
  client: GitLabClient,
  ownerName: string,
  cutoffMs: number,
): Promise<GitLabFetchResult> {
  const sinceISO = new Date(cutoffMs).toISOString();
  const host = client.host;
  const projectId = encodeProjectId(ownerName);

  // Step 1: resolve project metadata. Gives us the default branch and the
  // web_url used to build commit/release URLs (since some endpoints don't
  // return them).
  let project: GitLabProject;
  try {
    const { status, body } = await client.get<GitLabProject>(`/projects/${projectId}`);
    if (status === 404 || !body) {
      return { events: [], ok: false, reason: 'not found or inaccessible' };
    }
    project = body;
  } catch (err) {
    return { events: [], ok: false, reason: `project lookup failed: ${(err as Error).message}` };
  }

  if (!project.default_branch) {
    // Empty repo (no commits ever pushed); skip cleanly.
    return { events: [], ok: true };
  }

  // Step 2: fetch commits on the default branch since cutoff.
  let commits: GitLabCommit[];
  try {
    commits = await fetchCommits(client, projectId, project.default_branch, sinceISO);
  } catch (err) {
    return { events: [], ok: false, reason: `commits fetch failed: ${(err as Error).message}` };
  }

  // Step 3: fetch MRs, issues, releases in parallel.
  const [mrs, issues, releases] = await Promise.all([
    paginate<GitLabMR>(
      client,
      `/projects/${projectId}/merge_requests?state=all&order_by=updated_at&sort=desc`,
      MRS_PAGE_SIZE,
      MRS_MAX_PER_REPO,
      cutoffMs,
    ),
    paginate<GitLabIssue>(
      client,
      `/projects/${projectId}/issues?state=all&order_by=updated_at&sort=desc`,
      ISSUES_PAGE_SIZE,
      ISSUES_MAX_PER_REPO,
      cutoffMs,
    ),
    paginate<GitLabRelease>(
      client,
      `/projects/${projectId}/releases?order_by=released_at&sort=desc`,
      RELEASES_PAGE_SIZE,
      RELEASES_MAX_PER_REPO,
      cutoffMs,
    ),
  ]);

  const events = [
    ...commits.flatMap((c) => commitToEvents(host, ownerName, c, project.web_url)),
    ...mrs.flatMap((m) => mrToEvents(host, ownerName, m)),
    ...issues.flatMap((i) => issueToEvents(host, ownerName, i)),
    ...releases.flatMap((r) => releaseToEvents(host, ownerName, r, project.web_url)),
  ];

  return { events, ok: true };
}
