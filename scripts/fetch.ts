import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphql } from '@octokit/graphql';
import yaml from 'js-yaml';
import {
  ConfigSchema,
  DatasetSchema,
  type Config,
  type Dataset,
  type Event,
  type EventType,
} from '../src/types';

const WINDOW_DAYS = 90;
const COMMITS_PER_REPO = 100;
const PRS_PER_REPO = 50;
const ISSUES_PER_REPO = 50;
const RELEASES_PER_REPO = 20;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = resolve(ROOT, 'repos.yml');
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

const REPO_QUERY = /* GraphQL */ `
  query Repo($owner: String!, $name: String!, $commits: Int!, $prs: Int!, $issues: Int!, $releases: Int!) {
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
                author { name user { login } }
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
          author { login }
          mergedBy { login }
        }
      }
      issues(first: $issues, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number
          title
          url
          createdAt
          closedAt
          author { login }
        }
      }
      releases(first: $releases, orderBy: { field: CREATED_AT, direction: DESC }) {
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

function makeEvent(
  repo: string,
  type: EventType,
  nativeId: string,
  timestamp: string,
  actor: string,
  title: string,
  url: string,
  shortId: string,
): Event {
  return {
    id: `${repo}:${type}:${nativeId}`,
    repo,
    type,
    timestamp,
    actor,
    title,
    url,
    shortId,
  };
}

const login = (a: Actor) => a?.login ?? 'unknown';

function commitToEvents(repo: string, n: CommitNode): Event[] {
  return [
    makeEvent(
      repo,
      'commit',
      n.oid,
      n.committedDate,
      n.author?.user?.login ?? n.author?.name ?? 'unknown',
      n.messageHeadline,
      n.url,
      n.abbreviatedOid,
    ),
  ];
}

function prToEvents(repo: string, n: PrNode): Event[] {
  const short = `#${n.number}`;
  const out: Event[] = [
    makeEvent(repo, 'pr_opened', String(n.number), n.createdAt, login(n.author), n.title, n.url, short),
  ];
  if (n.merged && n.mergedAt) {
    out.push(
      makeEvent(repo, 'pr_merged', String(n.number), n.mergedAt, login(n.mergedBy ?? n.author), n.title, n.url, short),
    );
  } else if (n.closedAt) {
    out.push(makeEvent(repo, 'pr_closed', String(n.number), n.closedAt, login(n.author), n.title, n.url, short));
  }
  return out;
}

function issueToEvents(repo: string, n: IssueNode): Event[] {
  const short = `#${n.number}`;
  const out: Event[] = [
    makeEvent(repo, 'issue_opened', String(n.number), n.createdAt, login(n.author), n.title, n.url, short),
  ];
  if (n.closedAt) {
    out.push(makeEvent(repo, 'issue_closed', String(n.number), n.closedAt, login(n.author), n.title, n.url, short));
  }
  return out;
}

function releaseToEvents(repo: string, n: ReleaseNode): Event[] {
  const ts = n.publishedAt ?? n.createdAt;
  return [
    makeEvent(repo, 'release', n.tagName, ts, login(n.author), n.name ?? n.tagName, n.url, n.tagName),
  ];
}

async function loadConfig(): Promise<Config> {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw);
  return ConfigSchema.parse(parsed);
}

function getToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required to run the fetcher.');
  }
  return token;
}

async function fetchRepo(
  client: typeof graphql,
  ownerName: string,
): Promise<Event[]> {
  const [owner, name] = ownerName.split('/');
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
    console.warn(`! ${ownerName}: not found or inaccessible, skipping`);
    return [];
  }
  const commits = repo.defaultBranchRef?.target.history.nodes ?? [];
  return [
    ...commits.flatMap((n) => commitToEvents(ownerName, n)),
    ...repo.pullRequests.nodes.flatMap((n) => prToEvents(ownerName, n)),
    ...repo.issues.nodes.flatMap((n) => issueToEvents(ownerName, n)),
    ...repo.releases.nodes.flatMap((n) => releaseToEvents(ownerName, n)),
  ];
}

async function main() {
  const config = await loadConfig();
  const token = getToken();
  const client = graphql.defaults({ headers: { authorization: `token ${token}` } });
  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  console.log(`Fetching ${config.repos.length} repo(s), window=${WINDOW_DAYS}d`);

  const all: Event[] = [];
  for (const repo of config.repos) {
    try {
      const events = await fetchRepo(client, repo);
      const recent = events.filter((e) => Date.parse(e.timestamp) >= cutoff);
      console.log(`  ${repo}: ${recent.length} events (of ${events.length} fetched)`);
      all.push(...recent);
    } catch (err) {
      console.error(`! ${repo}: ${(err as Error).message}`);
    }
  }

  all.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const dataset: Dataset = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    repos: config.repos,
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
