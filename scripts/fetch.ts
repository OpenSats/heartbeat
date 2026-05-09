import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { ConfigSchema, DatasetSchema, type Dataset, type Event } from '../src/types';
import { fetchGitHubRepo, getGitHubToken, makeGitHubClient } from './providers/github';

type LoadedConfig = {
  repos: string[];
  funds: Record<string, string[]>;
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  }
  return Math.floor(n);
}

const WINDOW_DAYS = intFromEnv('HEARTBEAT_WINDOW_DAYS', 90);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE_PATTERN = /^repos(\..+)?\.ya?ml$/i;
const OUT_PATH = resolve(ROOT, 'public/data/events.json');

function fundFromFilename(file: string): string {
  const m = file.match(/^repos\.(.+)\.ya?ml$/i);
  return m ? m[1].toLowerCase() : 'general';
}

async function loadConfig(): Promise<LoadedConfig> {
  const files = (await readdir(ROOT)).filter((f) => CONFIG_FILE_PATTERN.test(f)).sort();
  if (files.length === 0) {
    throw new Error('No repos.yml or repos.<group>.yml files found at the project root.');
  }

  const all = new Set<string>();
  const funds: Record<string, Set<string>> = {};

  for (const file of files) {
    const raw = await readFile(resolve(ROOT, file), 'utf8');
    const parsed = ConfigSchema.parse(yaml.load(raw));
    const fundName = parsed.fund ?? fundFromFilename(file);
    console.log(`  ${file}: ${parsed.repos.length} repos -> "${fundName}"`);
    const bucket = (funds[fundName] ??= new Set<string>());
    for (const r of parsed.repos) {
      all.add(r);
      bucket.add(r);
    }
  }

  return {
    repos: [...all].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    funds: Object.fromEntries(
      Object.entries(funds).map(([k, v]) => [
        k,
        [...v].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      ]),
    ),
  };
}

async function main() {
  const config = await loadConfig();
  const token = getGitHubToken();
  const client = makeGitHubClient(token);

  const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  console.log(`Fetching ${config.repos.length} repo(s), window=${WINDOW_DAYS}d`);

  const all: Event[] = [];
  for (const repo of config.repos) {
    try {
      const result = await fetchGitHubRepo(client, repo, cutoffMs);
      if (!result.ok) {
        console.warn(`! ${repo}: ${result.reason ?? 'fetch failed'}, skipping`);
        continue;
      }
      const recent = result.events.filter((e) => Date.parse(e.timestamp) >= cutoffMs);
      console.log(`  ${repo}: ${recent.length} events (of ${result.events.length} fetched)`);
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
