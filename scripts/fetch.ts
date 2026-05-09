import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphql } from '@octokit/graphql';
import { DatasetSchema, type Dataset, type Event } from '../src/types';
import { fetchRepoActivity } from './github';
import { repoActivityToEvents } from './events';
import { loadRepoConfig } from './repoSources';

const WINDOW_DAYS = 90;
const COMMITS_PER_REPO = 100;
const PRS_PER_REPO = 50;
const ISSUES_PER_REPO = 50;
const RELEASES_PER_REPO = 20;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = resolve(ROOT, 'public/data/events.json');

function getToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required to run the fetcher.');
  }
  return token;
}

async function main() {
  const token = getToken();
  const config = await loadRepoConfig();
  if (config.repos.length === 0) {
    throw new Error('No GitHub repositories found in SovEng project sources.');
  }

  const client = graphql.defaults({ headers: { authorization: `token ${token}` } });
  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const limits = {
    commits: COMMITS_PER_REPO,
    prs: PRS_PER_REPO,
    issues: ISSUES_PER_REPO,
    releases: RELEASES_PER_REPO,
  };

  console.log(
    `Fetching ${config.repos.length} repo(s), groups=${Object.keys(config.groups).length}, window=${WINDOW_DAYS}d`,
  );
  console.log(`Project source: ${config.source} (${config.projectCount} project(s))`);
  if (config.skipped.length > 0) {
    console.log(`Skipped ${config.skipped.length} non-GitHub repo link(s)`);
  }

  const all: Event[] = [];
  for (const repo of config.repos) {
    try {
      const activity = await fetchRepoActivity(client, repo, limits);
      if (!activity) {
        console.warn(`! ${repo}: not found or inaccessible, skipping`);
        continue;
      }
      const events = repoActivityToEvents(activity);
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
    groups: config.groups,
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
