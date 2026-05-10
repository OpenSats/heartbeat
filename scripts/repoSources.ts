import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { listPublicOwnerRepos } from './github';

export const DEFAULT_PROJECTS_JSON_URL =
  'https://raw.githubusercontent.com/soveng/website/main/src/data/showcaseProjects.json';

const LinkSchema = z.object({
  link: z.string().optional().nullable(),
});

const ShowcaseProjectSchema = z.object({
  name: z.string(),
  cohort: z.string().optional(),
  link: z.string().optional().nullable(),
  links: z.array(LinkSchema).optional(),
  extraLinks: z.array(LinkSchema).optional(),
});

const ShowcaseProjectsSchema = z.array(ShowcaseProjectSchema);

export type ShowcaseProject = z.infer<typeof ShowcaseProjectSchema>;
export type GithubOwnerRepoLister = (owner: string) => Promise<string[]>;

export type GithubReference =
  | { type: 'repo'; repo: string }
  | { type: 'owner'; owner: string }
  | { type: 'skip'; reason: string };

export type SkippedProjectLink = {
  cohort: string;
  project: string;
  url: string;
  reason: string;
};

export type RepoGroupConfig = {
  repos: string[];
  groups: Record<string, string[]>;
  emptyGroups: string[];
  skipped: SkippedProjectLink[];
  source: string;
  projectCount: number;
};

type BuildOptions = {
  additionalOwners?: string[];
  source?: string;
};

type LoadRepoConfigOptions = BuildOptions & {
  projectsSource?: string;
  listOwnerRepos?: GithubOwnerRepoLister;
};

function compareIds(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
}

function normalizeRepoId(owner: string, repo: string): string | null {
  const normalizedRepo = repo.replace(/\.git$/i, '');
  const candidate = `${owner}/${normalizedRepo}`;
  return /^[^/\s]+\/[^/\s]+$/.test(candidate) ? candidate : null;
}

function githubHostname(hostname: string): boolean {
  return hostname.toLowerCase() === 'github.com' || hostname.toLowerCase() === 'www.github.com';
}

export function githubReferenceFromUrl(rawUrl: string): GithubReference {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { type: 'skip', reason: 'invalid_url' };
  }

  if (!githubHostname(url.hostname)) return { type: 'skip', reason: 'not_github' };

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { type: 'skip', reason: 'github_root' };

  if (parts[0] === 'orgs') {
    return parts[1] ? { type: 'owner', owner: parts[1] } : { type: 'skip', reason: 'org_missing' };
  }

  if (parts.length === 1) return { type: 'owner', owner: parts[0] };

  const repo = normalizeRepoId(parts[0], parts[1]);
  return repo ? { type: 'repo', repo } : { type: 'skip', reason: 'invalid_repo' };
}

function projectLinks(project: ShowcaseProject): string[] {
  return [
    project.link,
    ...(project.links ?? []).map((link) => link.link),
    ...(project.extraLinks ?? []).map((link) => link.link),
  ].filter((link): link is string => Boolean(link));
}

async function addOwnerRepos(
  owner: string,
  group: string,
  groups: Map<string, Set<string>>,
  ownerCache: Map<string, Promise<string[]>>,
  listOwnerRepos: GithubOwnerRepoLister,
): Promise<void> {
  const reposPromise = ownerCache.get(owner) ?? listOwnerRepos(owner);
  ownerCache.set(owner, reposPromise);
  const bucket = groups.get(group) ?? new Set<string>();
  for (const repo of await reposPromise) {
    const [repoOwner, repoName] = repo.split('/');
    const normalized = repoOwner && repoName ? normalizeRepoId(repoOwner, repoName) : null;
    if (normalized) bucket.add(normalized);
  }
  groups.set(group, bucket);
}

export async function buildRepoGroupsFromProjects(
  projects: ShowcaseProject[],
  listOwnerRepos: GithubOwnerRepoLister,
  options: BuildOptions = {},
): Promise<RepoGroupConfig> {
  const groups = new Map<string, Set<string>>();
  const seenGroups = new Set<string>();
  const skipped: SkippedProjectLink[] = [];
  const ownerCache = new Map<string, Promise<string[]>>();

  for (const project of projects) {
    const cohort = project.cohort ?? 'unknown';
    seenGroups.add(cohort);
    for (const rawLink of projectLinks(project)) {
      const ref = githubReferenceFromUrl(rawLink);
      if (ref.type === 'repo') {
        const bucket = groups.get(cohort) ?? new Set<string>();
        bucket.add(ref.repo);
        groups.set(cohort, bucket);
      } else if (ref.type === 'owner') {
        await addOwnerRepos(ref.owner, cohort, groups, ownerCache, listOwnerRepos);
      } else {
        skipped.push({ cohort, project: project.name, url: rawLink, reason: ref.reason });
      }
    }
  }

  for (const owner of options.additionalOwners ?? []) {
    seenGroups.add(owner);
    await addOwnerRepos(owner, owner, groups, ownerCache, listOwnerRepos);
  }

  const sortedGroups = Object.fromEntries(
    [...groups.entries()]
      .map(([group, repos]) => [group, [...repos].sort(compareIds)] as const)
      .filter(([, repos]) => repos.length > 0)
      .sort(([a], [b]) => compareIds(a, b)),
  );
  const allRepos = new Set<string>();
  for (const repos of Object.values(sortedGroups)) {
    for (const repo of repos) allRepos.add(repo);
  }

  return {
    repos: [...allRepos].sort(compareIds),
    groups: sortedGroups,
    emptyGroups: [...seenGroups].filter((group) => !sortedGroups[group]).sort(compareIds),
    skipped,
    source: options.source ?? 'inline',
    projectCount: projects.length,
  };
}

async function readProjectsSource(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to load projects JSON: ${res.status} ${res.statusText}`);
    return await res.text();
  }
  return await readFile(source, 'utf8');
}

export async function loadShowcaseProjects(source?: string): Promise<{
  source: string;
  projects: ShowcaseProject[];
}> {
  const resolvedSource = source ?? process.env.SOVENG_PROJECTS_JSON ?? DEFAULT_PROJECTS_JSON_URL;
  const raw = await readProjectsSource(resolvedSource);
  return {
    source: resolvedSource,
    projects: ShowcaseProjectsSchema.parse(JSON.parse(raw)),
  };
}

export async function loadRepoConfig(
  options: LoadRepoConfigOptions = {},
): Promise<RepoGroupConfig> {
  const loaded = await loadShowcaseProjects(options.projectsSource);
  return await buildRepoGroupsFromProjects(
    loaded.projects,
    options.listOwnerRepos ?? listPublicOwnerRepos,
    {
      additionalOwners: options.additionalOwners ?? ['soveng'],
      source: loaded.source,
    },
  );
}
