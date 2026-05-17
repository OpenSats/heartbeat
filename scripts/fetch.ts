import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import {
  ConfigSchema,
  DatasetSchema,
  InstancesSchema,
  type Dataset,
  type Event,
  type Instances,
} from '../src/types';
import { fetchGitHubRepo, getGitHubToken, makeGitHubClient } from './providers/github';
import {
  CODEBERG_BASE_URL,
  CODEBERG_HOST,
  fetchForgejoRepo,
  getCodebergToken,
  makeForgejoClient,
  type ForgejoClient,
} from './providers/forgejo';
import {
  GITLAB_BASE_URL,
  GITLAB_HOST,
  fetchGitLabRepo,
  getGitLabToken,
  makeGitLabClient,
  type GitLabClient,
} from './providers/gitlab';
import { GIT_HOST, fetchGitRepo, normalizeGitEntry } from './providers/git';
import { NOSTR_HOST, fetchNostrRepo, parseNostrEntry } from './providers/nostr';

type RepoEntry = {
  raw: string; // original yaml string (post-normalization for git: entries)
  host: string; // "github" | "codeberg" | "gitlab" | "git" | "nostr" | any registered self-hosted label
  ownerName: string; // "forgejo/forgejo" or "gitlab-org/cli" or normalized URL for git: entries or "<pubkey>:<d-tag>" for nostr
  displayName: string; // no host prefix; used in dataset.repos and UI
  cloneUrl?: string; // git: entries only; the URL passed to `git clone` (may include .git)
  naddr?: string; // nostr: entries only; the original "nostr:naddr1..." string passed to the provider
};

type LoadedConfig = {
  entries: RepoEntry[];
  funds: Record<string, string[]>; // values are displayNames
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
const INSTANCES_FILE = resolve(ROOT, 'instances.yml');

function fundFromFilename(file: string): string {
  const m = file.match(/^repos\.(.+)\.ya?ml$/i);
  return m ? m[1].toLowerCase() : 'general';
}

// Parses a single repo entry from YAML into a structured RepoEntry. For
// "git:" entries the URL is normalized (lowercase host, strip trailing
// slash, strip .git) so equivalent spellings collapse to one entry. For
// "nostr:" entries the naddr is decoded into pubkey + identifier for the
// repoKey; the original naddr is preserved for the provider to use. For
// other entries the raw string is preserved as-is.
function parseRepoEntry(raw: string): RepoEntry | null {
  // git: entries get URL normalization
  if (raw.startsWith('git:')) {
    const norm = normalizeGitEntry(raw);
    if (!norm) return null; // malformed; ConfigSchema regex should have caught it
    return {
      raw: `git:${norm.url}`, // normalized form used as the dedup key
      host: GIT_HOST,
      ownerName: norm.url, // canonical URL (no .git), used for repoKey + event URLs
      displayName: norm.display, // "example.com/foo/bar"
      cloneUrl: norm.cloneUrl, // URL to pass to `git clone` (may include .git)
    };
  }

  // nostr: entries get naddr decoded for pubkey/identifier extraction
  if (raw.startsWith('nostr:')) {
    let coords;
    try {
      coords = parseNostrEntry(raw);
    } catch (err) {
      console.warn(`! ${raw}: ${(err as Error).message}`);
      return null;
    }
    if (!coords) return null; // not a nostr:naddr1... shape; ConfigSchema regex should have caught it
    return {
      raw, // original "nostr:naddr1..." used as the dedup key
      host: NOSTR_HOST,
      ownerName: `${coords.pubkey}:${coords.identifier}`, // used in repoKey
      displayName: coords.identifier, // d-tag; replaced by 30617 "name" tag once fetched
      naddr: raw, // passed verbatim to fetchNostrRepo
    };
  }

  const idx = raw.indexOf(':');
  if (idx === -1) {
    return { raw, host: 'github', ownerName: raw, displayName: raw };
  }
  const host = raw.slice(0, idx).toLowerCase();
  const ownerName = raw.slice(idx + 1);
  return { raw, host, ownerName, displayName: ownerName };
}

async function loadConfig(): Promise<LoadedConfig> {
  const files = (await readdir(ROOT)).filter((f) => CONFIG_FILE_PATTERN.test(f)).sort();
  if (files.length === 0) {
    throw new Error('No repos.yml or repos.<group>.yml files found at the project root.');
  }

  const seen = new Map<string, RepoEntry>(); // key: post-normalization raw
  const funds: Record<string, Set<string>> = {}; // values: displayName

  for (const file of files) {
    const raw = await readFile(resolve(ROOT, file), 'utf8');
    const parsed = ConfigSchema.parse(yaml.load(raw));
    const fundName = parsed.fund ?? fundFromFilename(file);
    console.log(`  ${file}: ${parsed.repos.length} repos -> "${fundName}"`);
    const bucket = (funds[fundName] ??= new Set<string>());
    for (const r of parsed.repos) {
      const entry = parseRepoEntry(r);
      if (!entry) {
        console.warn(`! ${file}: could not parse entry "${r}", skipping`);
        continue;
      }
      if (!seen.has(entry.raw)) seen.set(entry.raw, entry);
      bucket.add(seen.get(entry.raw)!.displayName);
    }
  }

  const entries = [...seen.values()].sort((a, b) =>
    a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()),
  );

  return {
    entries,
    funds: Object.fromEntries(
      Object.entries(funds).map(([k, v]) => [
        k,
        [...v].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      ]),
    ),
  };
}

// Loads optional instances.yml. Missing file is treated as an empty registry,
// not an error.
async function loadInstances(): Promise<Instances> {
  let raw: string;
  try {
    raw = await readFile(INSTANCES_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed = yaml.load(raw);
  // An empty file (or one with only comments) parses as null/undefined; treat
  // that as an empty registry too.
  if (parsed == null) return {};
  return InstancesSchema.parse(parsed);
}

// Builds a map of host label -> ForgejoClient for every Forgejo/Gitea-style
// host that appears in config. Codeberg is always registered as a built-in
// (using the constants from the forgejo provider). Self-hosted instances come
// from instances.yml. The built-in always wins over a user-defined `codeberg`.
function buildForgejoClients(
  hostsInUse: Set<string>,
  instances: Instances,
): Map<string, ForgejoClient> {
  const clients = new Map<string, ForgejoClient>();

  // Built-in: Codeberg.
  if (hostsInUse.has(CODEBERG_HOST)) {
    clients.set(
      CODEBERG_HOST,
      makeForgejoClient({
        baseUrl: CODEBERG_BASE_URL,
        host: CODEBERG_HOST,
        token: getCodebergToken(),
      }),
    );
  }

  // User-defined instances. Reserved labels (built-ins) cannot be redefined.
  const reserved = new Set<string>([
    CODEBERG_HOST,
    GITLAB_HOST,
    GIT_HOST,
    NOSTR_HOST,
    'github',
  ]);
  for (const [label, inst] of Object.entries(instances)) {
    if (reserved.has(label)) {
      console.warn(
        `! instances.yml: "${label}" is a built-in host and cannot be redefined; ignoring`,
      );
      continue;
    }
    if (!hostsInUse.has(label)) continue;

    const token = inst.tokenEnv ? process.env[inst.tokenEnv] : undefined;
    clients.set(
      label,
      makeForgejoClient({
        baseUrl: inst.baseUrl,
        host: label,
        token: token && token !== '' ? token : undefined,
      }),
    );
  }

  return clients;
}

async function main() {
  const config = await loadConfig();
  const instances = await loadInstances();

  const hostsInUse = new Set(config.entries.map((e) => e.host));
  const usesGitHub = hostsInUse.has('github');
  const usesGitLab = hostsInUse.has(GITLAB_HOST);

  const githubClient = usesGitHub ? makeGitHubClient(getGitHubToken()) : null;
  const gitlabClient: GitLabClient | null = usesGitLab
    ? makeGitLabClient({
        baseUrl: GITLAB_BASE_URL,
        host: GITLAB_HOST,
        token: getGitLabToken(),
      })
    : null;
  const forgejoClients = buildForgejoClients(hostsInUse, instances);

  const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  console.log(`Fetching ${config.entries.length} repo(s), window=${WINDOW_DAYS}d`);

  const all: Event[] = [];
  for (const entry of config.entries) {
    try {
      let result: { events: Event[]; ok: boolean; reason?: string };

      if (entry.host === 'github') {
        result = await fetchGitHubRepo(githubClient!, entry.ownerName, cutoffMs);
      } else if (entry.host === GITLAB_HOST) {
        result = await fetchGitLabRepo(gitlabClient!, entry.ownerName, cutoffMs);
      } else if (entry.host === GIT_HOST) {
        result = await fetchGitRepo(
          entry.ownerName,
          entry.cloneUrl ?? entry.ownerName,
          entry.displayName,
          cutoffMs,
        );
      } else if (entry.host === NOSTR_HOST) {
        result = await fetchNostrRepo(entry.naddr ?? entry.raw, cutoffMs);
      } else {
        const client = forgejoClients.get(entry.host);
        if (!client) {
          console.warn(
            `! ${entry.raw}: unknown host "${entry.host}" (not built-in and not in instances.yml), skipping`,
          );
          continue;
        }
        result = await fetchForgejoRepo(client, entry.ownerName, cutoffMs);
      }

      if (!result.ok) {
        console.warn(`! ${entry.raw}: ${result.reason ?? 'fetch failed'}, skipping`);
        continue;
      }

      const recent = result.events.filter((e) => Date.parse(e.timestamp) >= cutoffMs);
      console.log(`  ${entry.raw}: ${recent.length} events (of ${result.events.length} fetched)`);
      all.push(...recent);
    } catch (err) {
      console.error(`! ${entry.raw}: ${(err as Error).message}`);
    }
  }

  all.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const dataset: Dataset = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    repos: config.entries.map((e) => e.displayName),
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
