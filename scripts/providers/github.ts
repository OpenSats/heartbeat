import { graphql } from '@octokit/graphql';
import type { Event, EventType } from '../../src/types';
import { retryable } from '../lib/retry';

// --- Provider identity ------------------------------------------------------

const HOST = 'github';

function githubRepoKey(repo: string): string {
  return `${HOST}:${repo}`;
}

function githubActorKey(actor: string): string {
  return `${HOST}:${actor}`;
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

const COMMITS_PAGE_SIZE = intFromEnv('HEARTBEAT_COMMITS_PAGE_SIZE', 100);
const PRS_PAGE_SIZE = intFromEnv('HEARTBEAT_PRS_PAGE_SIZE', 50);
const ISSUES_PAGE_SIZE = intFromEnv('HEARTBEAT_ISSUES_PAGE_SIZE', 50);
const RELEASES_PAGE_SIZE = intFromEnv('HEARTBEAT_RELEASES_PAGE_SIZE', 20);

const COMMITS_MAX_PER_REPO = intFromEnv('HEARTBEAT_COMMITS_MAX_PER_REPO', 5000);
const PRS_MAX_PER_REPO = intFromEnv('HEARTBEAT_PRS_MAX_PER_REPO', 1000);
const ISSUES_MAX_PER_REPO = intFromEnv('HEARTBEAT_ISSUES_MAX_PER_REPO', 1000);
const RELEASES_MAX_PER_REPO = intFromEnv('HEARTBEAT_RELEASES_MAX_PER_REPO', 200);

// --- GraphQL response shapes ------------------------------------------------

type Actor = { login: string } | null;

type CommitNode = {
  oid: string;
  abbreviatedOid: string;
  committedDate: string;
  messageHeadline: string;
  url: string;
  author: { user: Actor; name: string | null } | null;
};

type PrNode = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  merged: boolean;
  author: Actor;
  mergedBy: Actor;
};

type IssueNode = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: Actor;
};

type ReleaseNode = {
  tagName: string;
  name: string | null;
  url: string;
  publishedAt: string | null;
  createdAt: string;
  author: Actor;
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type Connection<T> = { pageInfo: PageInfo; nodes: T[] };

type CommitsHistoryResponse = {
  repository: {
    defaultBranchRef: {
      target: {
        history: Connection<CommitNode>;
      } | null;
    } | null;
  } | null;
};

// --- GraphQL queries --------------------------------------------------------

const COMMITS_QUERY = /* GraphQL */ `
  query Commits(
    $owner: String!
    $name: String!
    $first: Int!
    $after: String
    $since: GitTimestamp!
  ) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: $first, after: $after, since: $since) {
              pageInfo { hasNextPage endCursor }
              nodes {
                oid
                abbreviatedOid
                committedDate
                messageHeadline
                url
                author {
                  name
                  user { login }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const PRS_QUERY = /* GraphQL */ `
  query Prs($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          createdAt
          updatedAt
          mergedAt
          closedAt
          merged
          author { login }
          mergedBy { login }
        }
      }
    }
  }
`;

const ISSUES_QUERY = /* GraphQL */ `
  query Issues($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          createdAt
          updatedAt
          closedAt
          author { login }
        }
      }
    }
  }
`;

const RELEASES_QUERY = /* GraphQL */ `
  query Releases($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      releases(first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          tagName
          name
          url
          publishedAt
          createdAt
          author { login }
        }
      }
    }
  }
`;

// --- Event shaping ----------------------------------------------------------

type EventInput = {
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
  const repoKey = githubRepoKey(e.repo);
  const actorKey = githubActorKey(e.actor);

  return {
    id: `${repoKey}:${e.type}:${e.nativeId}`,
    host: HOST,
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

const login = (a: Actor) => a?.login ?? 'unknown';

function commitToEvents(repo: string, n: CommitNode): Event[] {
  return [
    makeEvent({
      repo,
      type: 'commit',
      nativeId: n.oid,
      timestamp: n.committedDate,
      actor: n.author?.user?.login ?? n.author?.name ?? 'unknown',
      title: n.messageHeadline,
      url: n.url,
      shortId: n.abbreviatedOid,
    }),
  ];
}

function prToEvents(repo: string, n: PrNode): Event[] {
  const common = {
    repo,
    nativeId: String(n.number),
    title: n.title,
    url: n.url,
    shortId: `#${n.number}`,
  };
  const events: Event[] = [
    makeEvent({ ...common, type: 'pr_opened', timestamp: n.createdAt, actor: login(n.author) }),
  ];
  if (n.merged && n.mergedAt) {
    events.push(
      makeEvent({
        ...common,
        type: 'pr_merged',
        timestamp: n.mergedAt,
        actor: login(n.mergedBy ?? n.author),
      }),
    );
  } else if (n.closedAt) {
    events.push(
      makeEvent({ ...common, type: 'pr_closed', timestamp: n.closedAt, actor: login(n.author) }),
    );
  }
  return events;
}

function issueToEvents(repo: string, n: IssueNode): Event[] {
  const common = {
    repo,
    nativeId: String(n.number),
    title: n.title,
    url: n.url,
    shortId: `#${n.number}`,
    actor: login(n.author),
  };
  const events: Event[] = [makeEvent({ ...common, type: 'issue_opened', timestamp: n.createdAt })];
  if (n.closedAt)
    events.push(makeEvent({ ...common, type: 'issue_closed', timestamp: n.closedAt }));
  return events;
}

function releaseToEvents(repo: string, n: ReleaseNode): Event[] {
  return [
    makeEvent({
      repo,
      type: 'release',
      nativeId: n.tagName,
      timestamp: n.publishedAt ?? n.createdAt,
      actor: login(n.author),
      title: n.name ?? n.tagName,
      url: n.url,
      shortId: n.tagName,
    }),
  ];
}

// --- Pagination -------------------------------------------------------------

type GraphqlClient = typeof graphql;

async function paginate<T extends { updatedAt?: string; createdAt: string }>(
  client: GraphqlClient,
  query: string,
  owner: string,
  name: string,
  pageSize: number,
  maxNodes: number,
  cutoffMs: number,
  pickConnection: (data: any) => Connection<T> | null,
  label: string,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;

  while (all.length < maxNodes) {
    const data = await retryable(
      () =>
        client<any>(query, {
          owner,
          name,
          first: Math.min(pageSize, maxNodes - all.length),
          after: cursor,
        }),
      { label: `github ${owner}/${name} ${label}` },
    );
    const conn = pickConnection(data);
    if (!conn) break;
    all.push(...conn.nodes);

    const last = conn.nodes[conn.nodes.length - 1];
    if (last) {
      const lastTs = last.updatedAt ?? last.createdAt;
      if (Date.parse(lastTs) < cutoffMs) break;
    }

    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return all;
}

async function fetchCommits(
  client: GraphqlClient,
  owner: string,
  name: string,
  sinceISO: string,
): Promise<{ commits: CommitNode[]; repoFound: boolean }> {
  const all: CommitNode[] = [];
  let cursor: string | null = null;
  let repoFound = true;

  while (all.length < COMMITS_MAX_PER_REPO) {
    const data: CommitsHistoryResponse = await retryable(
      () =>
        client<CommitsHistoryResponse>(COMMITS_QUERY, {
          owner,
          name,
          first: Math.min(COMMITS_PAGE_SIZE, COMMITS_MAX_PER_REPO - all.length),
          after: cursor,
          since: sinceISO,
        }),
      { label: `github ${owner}/${name} commits` },
    );

    if (data.repository == null) {
      repoFound = false;
      break;
    }

    const history: Connection<CommitNode> | undefined =
      data.repository.defaultBranchRef?.target?.history;
    if (!history) break;

    all.push(...history.nodes);

    if (!history.pageInfo.hasNextPage) break;
    cursor = history.pageInfo.endCursor;
  }

  return { commits: all, repoFound };
}

// --- Public entry point -----------------------------------------------------

export type GitHubFetchResult = {
  events: Event[];
  ok: boolean;
  reason?: string;
};

export function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required to run the fetcher.');
  }
  return token;
}

export function makeGitHubClient(token: string): GraphqlClient {
  return graphql.defaults({ headers: { authorization: `token ${token}` } });
}

export async function fetchGitHubRepo(
  client: GraphqlClient,
  ownerName: string,
  cutoffMs: number,
): Promise<GitHubFetchResult> {
  const [owner, name] = ownerName.split('/');
  const sinceISO = new Date(cutoffMs).toISOString();

  let commitsResult: { commits: CommitNode[]; repoFound: boolean };
  try {
    commitsResult = await fetchCommits(client, owner, name, sinceISO);
  } catch (err) {
    return { events: [], ok: false, reason: `commits fetch failed: ${(err as Error).message}` };
  }

  if (!commitsResult.repoFound) {
    return { events: [], ok: false, reason: 'not found or inaccessible' };
  }

  const [prs, issues, releases] = await Promise.all([
    paginate<PrNode>(
      client,
      PRS_QUERY,
      owner,
      name,
      PRS_PAGE_SIZE,
      PRS_MAX_PER_REPO,
      cutoffMs,
      (data) => data?.repository?.pullRequests ?? null,
      'pulls',
    ),
    paginate<IssueNode>(
      client,
      ISSUES_QUERY,
      owner,
      name,
      ISSUES_PAGE_SIZE,
      ISSUES_MAX_PER_REPO,
      cutoffMs,
      (data) => data?.repository?.issues ?? null,
      'issues',
    ),
    paginate<ReleaseNode>(
      client,
      RELEASES_QUERY,
      owner,
      name,
      RELEASES_PAGE_SIZE,
      RELEASES_MAX_PER_REPO,
      cutoffMs,
      (data) => data?.repository?.releases ?? null,
      'releases',
    ),
  ]);

  const events = [
    ...commitsResult.commits.flatMap((n) => commitToEvents(ownerName, n)),
    ...prs.flatMap((n) => prToEvents(ownerName, n)),
    ...issues.flatMap((n) => issueToEvents(ownerName, n)),
    ...releases.flatMap((n) => releaseToEvents(ownerName, n)),
  ];

  return { events, ok: true };
}
