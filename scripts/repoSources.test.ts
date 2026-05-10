import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROJECTS_JSON_URL,
  buildRepoGroupsFromProjects,
  githubReferenceFromUrl,
  loadShowcaseProjects,
  type GithubOwnerRepoLister,
  type ShowcaseProject,
} from './repoSources';

describe('githubReferenceFromUrl', () => {
  test('normalizes repository URLs and strips deeper paths', () => {
    expect(githubReferenceFromUrl('https://github.com/hzrd149/blossom')).toEqual({
      type: 'repo',
      repo: 'hzrd149/blossom',
    });
    expect(githubReferenceFromUrl('https://github.com/OpenTollGate/tollgate/pull/9')).toEqual({
      type: 'repo',
      repo: 'OpenTollGate/tollgate',
    });
    expect(githubReferenceFromUrl('https://github.com/gzuuus/fips/tree/bloom-research')).toEqual({
      type: 'repo',
      repo: 'gzuuus/fips',
    });
  });

  test('recognizes owner-only GitHub URLs for expansion', () => {
    expect(githubReferenceFromUrl('https://github.com/orgs/Routstr')).toEqual({
      type: 'owner',
      owner: 'Routstr',
    });
    expect(githubReferenceFromUrl('https://github.com/totemize')).toEqual({
      type: 'owner',
      owner: 'totemize',
    });
  });

  test('skips non-GitHub, gist, and invalid URLs', () => {
    expect(githubReferenceFromUrl('https://sigit.io')).toMatchObject({ type: 'skip' });
    expect(
      githubReferenceFromUrl(
        'https://gist.github.com/BoltTouring/dde944661df330ec5119af8ef94159e1',
      ),
    ).toMatchObject({
      type: 'skip',
    });
    expect(githubReferenceFromUrl('not a url')).toMatchObject({ type: 'skip' });
  });
});

describe('buildRepoGroupsFromProjects', () => {
  test('builds SEC groups, expands owners, dedupes repos, and reports skipped links', async () => {
    const projects: ShowcaseProject[] = [
      {
        name: 'Blossom',
        cohort: 'SEC-01',
        link: 'https://github.com/hzrd149/blossom',
        extraLinks: [{ link: 'https://github.com/hzrd149/awesome-blossom' }],
      },
      {
        name: 'Routstr',
        cohort: 'SEC-05',
        link: 'https://github.com/orgs/Routstr',
      },
      {
        name: 'NIP-61',
        cohort: 'SEC-02',
        link: 'https://github.com/cashubtc/nuts/pull/292',
        links: [{ link: 'https://github.com/cashubtc/nuts/pull/293' }],
      },
      {
        name: 'Site-only project',
        cohort: 'SEC-07',
        link: 'https://learn.fips.network',
      },
    ];
    const ownerRepos: Record<string, string[]> = {
      Routstr: ['Routstr/local-plus-plus', 'Routstr/otrta-client'],
      soveng: ['soveng/website', 'soveng/heartbeat'],
    };
    const listOwnerRepos: GithubOwnerRepoLister = async (owner) => ownerRepos[owner] ?? [];

    const config = await buildRepoGroupsFromProjects(projects, listOwnerRepos, {
      additionalOwners: ['soveng'],
    });

    expect(config.groups['SEC-01']).toEqual(['hzrd149/awesome-blossom', 'hzrd149/blossom']);
    expect(config.groups['SEC-02']).toEqual(['cashubtc/nuts']);
    expect(config.groups['SEC-05']).toEqual(['Routstr/local-plus-plus', 'Routstr/otrta-client']);
    expect(config.groups.soveng).toEqual(['soveng/heartbeat', 'soveng/website']);
    expect(config.emptyGroups).toEqual(['SEC-07']);
    expect(config.repos.filter((repo) => repo === 'cashubtc/nuts')).toHaveLength(1);
    expect(config.skipped).toContainEqual(
      expect.objectContaining({ cohort: 'SEC-07', project: 'Site-only project' }),
    );
  });
});

describe('loadShowcaseProjects', () => {
  test('uses the GitHub website catalog by default', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toBe(DEFAULT_PROJECTS_JSON_URL);
      return new Response(JSON.stringify([{ name: 'Remote project', cohort: 'SEC-01' }]));
    }) as typeof fetch;

    try {
      const loaded = await loadShowcaseProjects();
      expect(loaded.source).toBe(DEFAULT_PROJECTS_JSON_URL);
      expect(loaded.projects).toEqual([{ name: 'Remote project', cohort: 'SEC-01' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
