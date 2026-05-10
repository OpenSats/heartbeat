import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphql } from '@octokit/graphql';
import { DatasetSchema, type CatalogCoverage, type Dataset, type Event } from '../src/types';
import { fetchRepoActivity, type RepoFetchLimits } from './github';
import { repoActivityToEvents } from './events';
import { loadRepoConfig, type RepoGroupConfig } from './repoSources';
import type { GitHubRepoActivity } from './events';

const WINDOW_DAYS = 90;
const COMMITS_PER_REPO = 100;
const PRS_PER_REPO = 50;
const ISSUES_PER_REPO = 50;
const RELEASES_PER_REPO = 20;
const MAX_FETCH_FAILURES = 0;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = resolve(ROOT, 'public/data/events.json');

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export type RepoFetchFailure = {
  repo: string;
  message: string;
};

export type FetchHealth = {
  totalRepos: number;
  successfulRepos: number;
  missingRepos: string[];
  failedRepos: RepoFetchFailure[];
  eventCount: number;
};

type FetchDatasetOptions = {
  fetchActivity: (repo: string, limits: RepoFetchLimits) => Promise<GitHubRepoActivity | null>;
  generatedAt?: Date;
  logger?: Logger;
  limits?: RepoFetchLimits;
  windowDays?: number;
};

export class UnhealthyFetchError extends Error {
  constructor(
    message: string,
    readonly health: FetchHealth,
  ) {
    super(message);
    this.name = 'UnhealthyFetchError';
  }
}

export function getToken(env: Record<string, string | undefined> = process.env): string {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required to run the fetcher.');
  }
  return token;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function eventSort(a: Event, b: Event): number {
  return a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0;
}

function defaultLimits(): RepoFetchLimits {
  return {
    commits: COMMITS_PER_REPO,
    prs: PRS_PER_REPO,
    issues: ISSUES_PER_REPO,
    releases: RELEASES_PER_REPO,
  };
}

function catalogCoverage(config: RepoGroupConfig): CatalogCoverage {
  const groupCounts = Object.fromEntries(
    [...Object.keys(config.groups), ...config.emptyGroups]
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((group) => [group, config.groups[group]?.length ?? 0]),
  );
  return {
    source: config.source,
    projectCount: config.projectCount,
    skippedLinkCount: config.skipped.length,
    emptyGroups: config.emptyGroups,
    groupCounts,
  };
}

export function assertFetchHealthy(health: FetchHealth, maxFailures = MAX_FETCH_FAILURES): void {
  if (health.failedRepos.length <= maxFailures) return;
  const failed = health.failedRepos
    .map((failure) => `${failure.repo}: ${failure.message}`)
    .join('; ');
  throw new UnhealthyFetchError(
    `GitHub activity refresh failed for ${health.failedRepos.length} repo(s): ${failed}`,
    health,
  );
}

export async function buildDatasetFromConfig(
  config: RepoGroupConfig,
  options: FetchDatasetOptions,
): Promise<{ dataset: Dataset; health: FetchHealth }> {
  const generatedAt = options.generatedAt ?? new Date();
  const logger = options.logger ?? console;
  const windowDays = options.windowDays ?? WINDOW_DAYS;
  const cutoff = generatedAt.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const limits = options.limits ?? defaultLimits();
  const all: Event[] = [];
  const missingRepos: string[] = [];
  const failedRepos: RepoFetchFailure[] = [];
  let successfulRepos = 0;

  for (const repo of config.repos) {
    try {
      const activity = await options.fetchActivity(repo, limits);
      if (!activity) {
        missingRepos.push(repo);
        logger.warn(`! ${repo}: not found or inaccessible, skipping`);
        continue;
      }
      successfulRepos += 1;
      const events = repoActivityToEvents(activity);
      const recent = events.filter((e) => Date.parse(e.timestamp) >= cutoff);
      logger.log(`  ${repo}: ${recent.length} events (of ${events.length} fetched)`);
      all.push(...recent);
    } catch (err) {
      const message = errorMessage(err);
      failedRepos.push({ repo, message });
      logger.error(`! ${repo}: ${message}`);
    }
  }

  all.sort(eventSort);

  const dataset: Dataset = {
    generatedAt: generatedAt.toISOString(),
    windowDays,
    repos: config.repos,
    groups: config.groups,
    catalog: catalogCoverage(config),
    events: all,
  };
  DatasetSchema.parse(dataset);

  return {
    dataset,
    health: {
      totalRepos: config.repos.length,
      successfulRepos,
      missingRepos,
      failedRepos,
      eventCount: all.length,
    },
  };
}

async function main() {
  const token = getToken();
  const config = await loadRepoConfig();
  if (config.repos.length === 0) {
    throw new Error('No GitHub repositories found in SovEng project sources.');
  }

  const client = graphql.defaults({ headers: { authorization: `token ${token}` } });

  console.log(
    `Fetching ${config.repos.length} repo(s), groups=${Object.keys(config.groups).length}, window=${WINDOW_DAYS}d`,
  );
  console.log(`Project source: ${config.source} (${config.projectCount} project(s))`);
  if (config.skipped.length > 0) {
    console.log(`Skipped ${config.skipped.length} non-GitHub repo link(s)`);
  }

  const { dataset, health } = await buildDatasetFromConfig(config, {
    fetchActivity: (repo, limits) => fetchRepoActivity(client, repo, limits),
  });
  console.log(
    `Fetch summary: ${health.successfulRepos}/${health.totalRepos} repo(s), ${health.missingRepos.length} missing, ${health.failedRepos.length} failed, ${health.eventCount} event(s)`,
  );
  assertFetchHealthy(health);

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(dataset, null, 2) + '\n');
  console.log(`Wrote ${dataset.events.length} events -> ${OUT_PATH}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
