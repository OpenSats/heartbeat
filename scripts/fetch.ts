import { execFile } from 'node:child_process';
import { readdir, readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { graphql } from '@octokit/graphql';
import yaml from 'js-yaml';
import {
  ConfigSchema,
  DatasetSchema,
  type Dataset,
  type Event,
  type EventType,
  type RepoConfigEntry,
} from '../src/types';

type GitHubRepoTarget = {
  provider: 'github';
  ownerName: string;
  key: string;
};

type GitLabRepoTarget = {
  provider: 'gitlab';
  fullPath: string;
  host: string;
  key: string;
};

type GitRepoTarget = {
  provider: 'git';
  url: string;
  key: string;
};

type RepoTarget = GitHubRepoTarget | GitLabRepoTarget | GitRepoTarget;

type LoadedConfig = {
  repos: RepoTarget[];
  funds: Record<string, string[]>;
};

const WINDOW_DAYS = 90;
const COMMITS_PER_REPO = 100;
const PRS_PER_REPO = 50;
const ISSUES_PER_REPO = 50;
const RELEASES_PER_REPO = 20;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE_PATTERN = /^repos(\..+)?\.ya?ml$/i;
const OUT_PATH = resolve(ROOT, 'public/data/events.json');

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
type RepoQueryResult = {
  repository: {
    nameWithOwner: string;
    defaultBranchRef: { target: { history: { nodes: CommitNode[] } } } | null;
    pullRequests: { nodes: PrNode[] };
    issues: { nodes: IssueNode[] };
    releases: { nodes: ReleaseNode[] };
  } | null;
};

type GitLabUser = { username: string | null } | null;
type GitLabCommitNode = {
  id: string;
  short_id: string;
  committed_date: string;
  title: string;
  web_url: string;
  author_name: string | null;
};
type GitLabIssueNode = {
  iid: number;
  title: string;
  web_url: string;
  created_at: string;
  closed_at: string | null;
  author: GitLabUser;
  closed_by?: GitLabUser;
};
type GitLabTagNode = {
  name: string;
  created_at: string | null;
  message: string | null;
  commit: { committed_date: string };
  release?: { tag_name: string; description: string | null } | null;
};
type GitLabMergeRequestNode = {
  iid: string;
  title: string;
  state: string;
  webUrl: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  author: GitLabUser;
  mergeUser: GitLabUser;
};
type GitLabGraphQlResponse = {
  data?: { project: { mergeRequests: { nodes: GitLabMergeRequestNode[] } } | null };
  errors?: Array<{ message: string }>;
};

const REPO_QUERY = /* GraphQL */ `
  query Repo(
    $owner: String!
    $name: String!
    $commits: Int!
    $prs: Int!
    $issues: Int!
    $releases: Int!
  ) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: $commits) {
              nodes {
                oid
                abbreviatedOid
                committedDate
                messageHeadline
                url
                author {
                  name
                  user {
                    login
                  }
                }
              }
            }
          }
        }
      }
      pullRequests(first: $prs, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number
          title
          url
          createdAt
          mergedAt
          closedAt
          merged
          author {
            login
          }
          mergedBy {
            login
          }
        }
      }
      issues(first: $issues, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number
          title
          url
          createdAt
          closedAt
          author {
            login
          }
        }
      }
      releases(first: $releases, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          tagName
          name
          url
          publishedAt
          createdAt
          author {
            login
          }
        }
      }
    }
  }
`;

const GITLAB_MERGE_REQUESTS_QUERY = (
  fullPath: string,
  count: number,
  state: string,
) => /* GraphQL */ `
  query {
    project(fullPath: ${JSON.stringify(fullPath)}) {
      mergeRequests(first: ${count}, state: ${state}, sort: UPDATED_DESC) {
        nodes {
          iid
          title
          state
          webUrl
          createdAt
          mergedAt
          closedAt
          author {
            username
          }
          mergeUser {
            username
          }
        }
      }
    }
  }
`;

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
  return {
    id: `${e.repo}:${e.type}:${e.nativeId}`,
    repo: e.repo,
    type: e.type,
    timestamp: e.timestamp,
    actor: e.actor,
    title: e.title,
    url: e.url,
    shortId: e.shortId,
  };
}

const login = (a: Actor) => a?.login ?? 'unknown';
const gitlabLogin = (a: GitLabUser) => a?.username ?? 'unknown';

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

function gitlabCommitToEvents(repo: string, n: GitLabCommitNode): Event[] {
  return [
    makeEvent({
      repo,
      type: 'commit',
      nativeId: n.id,
      timestamp: n.committed_date,
      actor: n.author_name ?? 'unknown',
      title: n.title,
      url: n.web_url,
      shortId: n.short_id,
    }),
  ];
}

function gitlabIssueToEvents(repo: string, n: GitLabIssueNode): Event[] {
  const opener = gitlabLogin(n.author);
  const common = {
    repo,
    nativeId: String(n.iid),
    title: n.title,
    url: n.web_url,
    shortId: `#${n.iid}`,
  };
  const events: Event[] = [
    makeEvent({ ...common, type: 'issue_opened', timestamp: n.created_at, actor: opener }),
  ];
  if (n.closed_at) {
    events.push(
      makeEvent({
        ...common,
        type: 'issue_closed',
        timestamp: n.closed_at,
        actor: n.closed_by ? gitlabLogin(n.closed_by) : opener,
      }),
    );
  }
  return events;
}

function gitlabTagToEvents(repo: GitLabRepoTarget, n: GitLabTagNode): Event[] {
  const tag = n.name;
  const hasReleasePage = Boolean(n.release);
  const url = hasReleasePage
    ? `https://${repo.host}/${repo.fullPath}/-/releases/${encodeURIComponent(tag)}`
    : `https://${repo.host}/${repo.fullPath}/-/tags/${encodeURIComponent(tag)}`;
  return [
    makeEvent({
      repo: repo.key,
      type: 'release',
      nativeId: tag,
      timestamp: n.created_at ?? n.commit.committed_date,
      actor: 'unknown',
      title: tag,
      url,
      shortId: tag,
    }),
  ];
}

function gitlabMergeRequestToEvents(repo: string, n: GitLabMergeRequestNode): Event[] {
  const common = {
    repo,
    nativeId: String(n.iid),
    title: n.title,
    url: n.webUrl,
    shortId: `!${n.iid}`,
  };
  const events: Event[] = [
    makeEvent({
      ...common,
      type: 'pr_opened',
      timestamp: n.createdAt,
      actor: gitlabLogin(n.author),
    }),
  ];
  if (n.mergedAt) {
    events.push(
      makeEvent({
        ...common,
        type: 'pr_merged',
        timestamp: n.mergedAt,
        actor: gitlabLogin(n.mergeUser ?? n.author),
      }),
    );
  } else if (n.closedAt) {
    events.push(
      makeEvent({
        ...common,
        type: 'pr_closed',
        timestamp: n.closedAt,
        actor: gitlabLogin(n.author),
      }),
    );
  }
  return events;
}

function fundFromFilename(file: string): string {
  const m = file.match(/^repos\.(.+)\.ya?ml$/i);
  return m ? m[1].toLowerCase() : 'general';
}

function normalizeRepoEntry(entry: RepoConfigEntry): RepoTarget {
  if (typeof entry === 'string') {
    return { provider: 'github', ownerName: entry, key: entry };
  }

  if (entry.provider === 'git') {
    const url = entry.url.replace(/\/+$/, '');
    return {
      provider: 'git',
      url,
      key: url.replace(/^https?:\/\//, '').replace(/\.git$/, ''),
    };
  }

  const host = (entry.host ?? 'gitlab.com').toLowerCase();
  return {
    provider: 'gitlab',
    fullPath: entry.repo,
    host,
    key: `${host}/${entry.repo}`,
  };
}

async function loadConfig(): Promise<LoadedConfig> {
  const files = (await readdir(ROOT)).filter((f) => CONFIG_FILE_PATTERN.test(f)).sort();
  if (files.length === 0) {
    throw new Error('No repos.yml or repos.<group>.yml files found at the project root.');
  }
  const all = new Map<string, RepoTarget>();
  const funds: Record<string, Set<string>> = {};
  for (const file of files) {
    const raw = await readFile(resolve(ROOT, file), 'utf8');
    const parsed = ConfigSchema.parse(yaml.load(raw));
    const fundName = parsed.fund ?? fundFromFilename(file);
    console.log(`  ${file}: ${parsed.repos.length} repos -> "${fundName}"`);
    const bucket = (funds[fundName] ??= new Set<string>());
    for (const entry of parsed.repos) {
      const repo = normalizeRepoEntry(entry);
      all.set(repo.key, repo);
      bucket.add(repo.key);
    }
  }
  return {
    repos: [...all.values()].sort((a, b) => a.key.toLowerCase().localeCompare(b.key.toLowerCase())),
    funds: Object.fromEntries(
      Object.entries(funds).map(([k, v]) => [
        k,
        [...v].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      ]),
    ),
  };
}

function getGitHubToken(hasGitHubRepos: boolean): string | null {
  if (!hasGitHubRepos) return null;

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required to run the fetcher.');
  }
  return token;
}

async function fetchGitHubRepo(
  client: typeof graphql,
  repoTarget: GitHubRepoTarget,
): Promise<Event[]> {
  const [owner, name] = repoTarget.ownerName.split('/');
  const data = await client<RepoQueryResult>(REPO_QUERY, {
    owner,
    name,
    commits: COMMITS_PER_REPO,
    prs: PRS_PER_REPO,
    issues: ISSUES_PER_REPO,
    releases: RELEASES_PER_REPO,
  });
  const repo = data.repository;
  if (!repo) {
    console.warn(`! ${repoTarget.key}: not found or inaccessible, skipping`);
    return [];
  }
  const commits = repo.defaultBranchRef?.target.history.nodes ?? [];
  return [
    ...commits.flatMap((n) => commitToEvents(repoTarget.key, n)),
    ...repo.pullRequests.nodes.flatMap((n) => prToEvents(repoTarget.key, n)),
    ...repo.issues.nodes.flatMap((n) => issueToEvents(repoTarget.key, n)),
    ...repo.releases.nodes.flatMap((n) => releaseToEvents(repoTarget.key, n)),
  ];
}

async function gitlabJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  return (await response.json()) as T;
}

function gitlabProjectApiBase(repo: GitLabRepoTarget): string {
  return `https://${repo.host}/api/v4/projects/${encodeURIComponent(repo.fullPath)}`;
}

async function fetchGitLabMergeRequestsByState(
  repo: GitLabRepoTarget,
  state: 'opened' | 'merged' | 'closed',
): Promise<GitLabMergeRequestNode[]> {
  const body = JSON.stringify({
    query: GITLAB_MERGE_REQUESTS_QUERY(repo.fullPath, PRS_PER_REPO, state),
  });
  const data = await gitlabJson<GitLabGraphQlResponse>(`https://${repo.host}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  if (data.errors?.length) {
    throw new Error(data.errors.map((e) => e.message).join('; '));
  }

  return data.data?.project?.mergeRequests.nodes ?? [];
}

async function fetchGitLabRepo(repo: GitLabRepoTarget): Promise<Event[]> {
  const base = gitlabProjectApiBase(repo);

  const [commitsRes, issuesRes, tagsRes, openedMrsRes, mergedMrsRes, closedMrsRes] =
    await Promise.allSettled([
      gitlabJson<GitLabCommitNode[]>(`${base}/repository/commits?per_page=${COMMITS_PER_REPO}`),
      gitlabJson<GitLabIssueNode[]>(
        `${base}/issues?per_page=${ISSUES_PER_REPO}&state=all&order_by=updated_at&sort=desc`,
      ),
      gitlabJson<GitLabTagNode[]>(`${base}/repository/tags?per_page=${RELEASES_PER_REPO}`),
      fetchGitLabMergeRequestsByState(repo, 'opened'),
      fetchGitLabMergeRequestsByState(repo, 'merged'),
      fetchGitLabMergeRequestsByState(repo, 'closed'),
    ]);

  const warnIfRejected = (label: string, result: PromiseSettledResult<unknown>) => {
    if (result.status === 'rejected') {
      console.warn(`! ${repo.key}: failed to fetch GitLab ${label}: ${result.reason}`);
    }
  };

  warnIfRejected('commits', commitsRes);
  warnIfRejected('issues', issuesRes);
  warnIfRejected('tags/releases', tagsRes);
  warnIfRejected('merge requests (opened)', openedMrsRes);
  warnIfRejected('merge requests (merged)', mergedMrsRes);
  warnIfRejected('merge requests (closed)', closedMrsRes);

  const commits = commitsRes.status === 'fulfilled' ? commitsRes.value : [];
  const issues = issuesRes.status === 'fulfilled' ? issuesRes.value : [];
  const tags = tagsRes.status === 'fulfilled' ? tagsRes.value : [];
  const mergeRequests = [openedMrsRes, mergedMrsRes, closedMrsRes].flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );

  return [
    ...commits.flatMap((n) => gitlabCommitToEvents(repo.key, n)),
    ...mergeRequests.flatMap((n) => gitlabMergeRequestToEvents(repo.key, n)),
    ...issues.flatMap((n) => gitlabIssueToEvents(repo.key, n)),
    ...tags.flatMap((n) => gitlabTagToEvents(repo, n)),
  ];
}

const execFileAsync = promisify(execFile);
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Fetches activity from a plain git remote (e.g. cgit instances like
 * git.zx2c4.com) by making a shallow bare clone and reading the log.
 * Only commits and tags are available; there is no PR/issue API.
 */
async function fetchGitRepo(repo: GitRepoTarget): Promise<Event[]> {
  const dir = await mkdtemp(join(tmpdir(), 'heartbeat-git-'));
  try {
    try {
      // --filter is ignored with a warning by servers without partial
      // clone support, so it is a free optimization where available.
      await git([
        'clone',
        '--bare',
        '--quiet',
        '--single-branch',
        '--filter=tree:0',
        `--shallow-since=${WINDOW_DAYS + 1} days ago`,
        repo.url,
        dir,
      ]);
    } catch (err) {
      // A shallow clone of a repo with no commits inside the window fails
      // with "fatal: error processing shallow info".
      if (String(err).includes('error processing shallow info')) {
        console.warn(`! ${repo.key}: no commits in window, skipping`);
        return [];
      }
      throw err;
    }

    const log = await git([
      '-C',
      dir,
      'log',
      `--max-count=${COMMITS_PER_REPO}`,
      `--format=%H${FIELD_SEP}%h${FIELD_SEP}%cI${FIELD_SEP}%an${FIELD_SEP}%s${RECORD_SEP}`,
    ]);
    const commits = log
      .split(RECORD_SEP)
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [oid, shortId, timestamp, author, subject] = record.split(FIELD_SEP);
        return makeEvent({
          repo: repo.key,
          type: 'commit',
          nativeId: oid,
          timestamp,
          actor: author || 'unknown',
          title: subject ?? '',
          url: `${repo.url}/commit/?id=${oid}`,
          shortId,
        });
      });

    const tagsOut = await git([
      '-C',
      dir,
      'for-each-ref',
      'refs/tags',
      `--format=%(refname:short)${FIELD_SEP}%(creatordate:iso-strict)${FIELD_SEP}%(taggername)`,
    ]);
    const tags = tagsOut
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [tag, timestamp, tagger] = line.split(FIELD_SEP);
        return makeEvent({
          repo: repo.key,
          type: 'release',
          nativeId: tag,
          timestamp,
          actor: tagger || 'unknown',
          title: tag,
          url: `${repo.url}/tag/?h=${encodeURIComponent(tag)}`,
          shortId: tag,
        });
      });

    return [...commits, ...tags];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const config = await loadConfig();
  const token = getGitHubToken(config.repos.some((repo) => repo.provider === 'github'));
  const client = token ? graphql.defaults({ headers: { authorization: `token ${token}` } }) : null;
  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  console.log(`Fetching ${config.repos.length} repo(s), window=${WINDOW_DAYS}d`);

  const all: Event[] = [];
  for (const repo of config.repos) {
    try {
      const events =
        repo.provider === 'github'
          ? await fetchGitHubRepo(client!, repo)
          : repo.provider === 'gitlab'
            ? await fetchGitLabRepo(repo)
            : await fetchGitRepo(repo);
      const recent = events.filter((e) => Date.parse(e.timestamp) >= cutoff);
      console.log(`  ${repo.key}: ${recent.length} events (of ${events.length} fetched)`);
      all.push(...recent);
    } catch (err) {
      console.error(`! ${repo.key}: ${(err as Error).message}`);
    }
  }

  all.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const dataset: Dataset = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    repos: config.repos.map((repo) => repo.key),
    funds: config.funds,
    events: all,
  };
  DatasetSchema.parse(dataset);

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(dataset, null, 2) + '\n');
  console.log(`Wrote ${all.length} events -> ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
