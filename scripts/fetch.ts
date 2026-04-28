import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphql } from '@octokit/graphql';
import yaml from 'js-yaml';
import {
  ConfigSchema,
  DatasetSchema,
  ProfilesConfigSchema,
  type Dataset,
  type Event,
  type EventType,
} from '../src/types';

type LoadedConfig = {
  repos: string[];
  funds: Record<string, string[]>;
};

const WINDOW_DAYS = 90;
const COMMITS_PER_REPO = 100;
const PRS_PER_REPO = 50;
const ISSUES_PER_REPO = 50;
const RELEASES_PER_REPO = 20;
const TOP_REPOS_PER_PROFILE = 5;
const REPO_FETCH_CONCURRENCY = 8;
const PROFILE_FETCH_CONCURRENCY = 10;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE_PATTERN = /^repos(\..+)?\.ya?ml$/i;
const PROFILE_FILE_PATTERN = /^profiles(\..+)?\.ya?ml$/i;
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

type ProfileQueryResult = {
  repositoryOwner: {
    repositories: {
      nodes: Array<{
        nameWithOwner: string;
        isDisabled: boolean;
        isEmpty: boolean;
      }>;
    };
  } | null;
};

const PROFILE_QUERY = /* GraphQL */ `
  query Profile($login: String!, $first: Int!) {
    repositoryOwner(login: $login) {
      repositories(
        first: $first
        orderBy: { field: PUSHED_AT, direction: DESC }
        ownerAffiliations: OWNER
        isFork: false
        privacy: PUBLIC
        isArchived: false
      ) {
        nodes {
          nameWithOwner
          isDisabled
          isEmpty
        }
      }
    }
  }
`;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchProfileRepos(
  client: typeof graphql,
  login: string,
  n: number,
): Promise<string[]> {
  const data = await client<ProfileQueryResult>(PROFILE_QUERY, {
    login,
    first: n + 5,
  });
  const owner = data.repositoryOwner;
  if (!owner) return [];
  return owner.repositories.nodes
    .filter((r) => !r.isDisabled && !r.isEmpty)
    .slice(0, n)
    .map((r) => r.nameWithOwner);
}

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
    makeEvent(
      repo,
      'pr_opened',
      String(n.number),
      n.createdAt,
      login(n.author),
      n.title,
      n.url,
      short,
    ),
  ];
  if (n.merged && n.mergedAt) {
    out.push(
      makeEvent(
        repo,
        'pr_merged',
        String(n.number),
        n.mergedAt,
        login(n.mergedBy ?? n.author),
        n.title,
        n.url,
        short,
      ),
    );
  } else if (n.closedAt) {
    out.push(
      makeEvent(
        repo,
        'pr_closed',
        String(n.number),
        n.closedAt,
        login(n.author),
        n.title,
        n.url,
        short,
      ),
    );
  }
  return out;
}

function issueToEvents(repo: string, n: IssueNode): Event[] {
  const short = `#${n.number}`;
  const out: Event[] = [
    makeEvent(
      repo,
      'issue_opened',
      String(n.number),
      n.createdAt,
      login(n.author),
      n.title,
      n.url,
      short,
    ),
  ];
  if (n.closedAt) {
    out.push(
      makeEvent(
        repo,
        'issue_closed',
        String(n.number),
        n.closedAt,
        login(n.author),
        n.title,
        n.url,
        short,
      ),
    );
  }
  return out;
}

function releaseToEvents(repo: string, n: ReleaseNode): Event[] {
  const ts = n.publishedAt ?? n.createdAt;
  return [
    makeEvent(
      repo,
      'release',
      n.tagName,
      ts,
      login(n.author),
      n.name ?? n.tagName,
      n.url,
      n.tagName,
    ),
  ];
}

function fundFromFilename(file: string): string {
  const m = file.match(/^(?:repos|profiles)\.(.+)\.ya?ml$/i);
  return m ? m[1] : 'general';
}

const sortByName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

async function loadConfig(client: typeof graphql): Promise<LoadedConfig> {
  const allFiles = await readdir(ROOT);
  const repoFiles = allFiles.filter((f) => CONFIG_FILE_PATTERN.test(f)).sort();
  const profileFiles = allFiles.filter((f) => PROFILE_FILE_PATTERN.test(f)).sort();
  if (repoFiles.length === 0 && profileFiles.length === 0) {
    throw new Error('No repos.*.yml or profiles.*.yml files found at the project root.');
  }

  const all = new Set<string>();
  const funds: Record<string, Set<string>> = {};
  const bucket = (fund: string) => (funds[fund] ??= new Set<string>());
  const add = (fund: string, repos: Iterable<string>) => {
    const b = bucket(fund);
    for (const r of repos) {
      all.add(r);
      b.add(r);
    }
  };

  for (const file of repoFiles) {
    const raw = await readFile(resolve(ROOT, file), 'utf8');
    const parsed = ConfigSchema.parse(yaml.load(raw));
    const fund = parsed.fund ?? fundFromFilename(file);
    console.log(`  ${file}: ${parsed.repos.length} repos -> "${fund}"`);
    add(fund, parsed.repos);
  }

  for (const file of profileFiles) {
    const raw = await readFile(resolve(ROOT, file), 'utf8');
    const parsed = ProfilesConfigSchema.parse(yaml.load(raw));
    const fund = parsed.fund ?? fundFromFilename(file);
    console.log(
      `  ${file}: expanding ${parsed.profiles.length} profile(s) (top ${TOP_REPOS_PER_PROFILE}) -> "${fund}"`,
    );
    const before = bucket(fund).size;
    const results = await mapWithConcurrency(
      parsed.profiles,
      PROFILE_FETCH_CONCURRENCY,
      async (login) => {
        try {
          return await fetchProfileRepos(client, login, TOP_REPOS_PER_PROFILE);
        } catch (err) {
          console.warn(`    ! ${login}: ${(err as Error).message}`);
          return [] as string[];
        }
      },
    );
    add(fund, results.flat());
    console.log(`    -> +${bucket(fund).size - before} new repo(s) in "${fund}"`);
  }

  return {
    repos: [...all].sort(sortByName),
    funds: Object.fromEntries(Object.entries(funds).map(([k, v]) => [k, [...v].sort(sortByName)])),
  };
}

function getToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required to run the fetcher.');
  }
  return token;
}

async function fetchRepo(client: typeof graphql, ownerName: string): Promise<Event[]> {
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
  const token = getToken();
  const client = graphql.defaults({ headers: { authorization: `token ${token}` } });

  console.log('Loading config...');
  const config = await loadConfig(client);

  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  console.log(
    `Fetching ${config.repos.length} repo(s), window=${WINDOW_DAYS}d, concurrency=${REPO_FETCH_CONCURRENCY}`,
  );

  const fetched = await mapWithConcurrency(config.repos, REPO_FETCH_CONCURRENCY, async (repo) => {
    try {
      const events = await fetchRepo(client, repo);
      const recent = events.filter((e) => Date.parse(e.timestamp) >= cutoff);
      console.log(`  ${repo}: ${recent.length} events (of ${events.length} fetched)`);
      return recent;
    } catch (err) {
      console.error(`! ${repo}: ${(err as Error).message}`);
      return [] as Event[];
    }
  });

  const all = fetched.flat();
  all.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const dataset: Dataset = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    repos: config.repos,
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
