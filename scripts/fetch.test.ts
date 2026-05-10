import { describe, expect, test } from 'bun:test';
import {
  UnhealthyFetchError,
  assertFetchHealthy,
  buildDatasetFromConfig,
  getToken,
  type FetchHealth,
} from './fetch';
import type { GitHubRepoActivity } from './events';
import type { RepoGroupConfig } from './repoSources';

const generatedAt = new Date('2026-05-10T00:00:00Z');

const config: RepoGroupConfig = {
  repos: ['owner/active', 'owner/old', 'owner/missing'],
  groups: { 'SEC-01': ['owner/active', 'owner/old', 'owner/missing'] },
  skipped: [],
  source: 'test',
  projectCount: 3,
};

const logger = {
  log() {},
  warn() {},
  error() {},
};

function activity(repo: string, timestamp: string): GitHubRepoActivity {
  return {
    repo,
    commits: [
      {
        oid: `${repo}-commit`,
        abbreviatedOid: 'abc1234',
        committedDate: timestamp,
        messageHeadline: `commit for ${repo}`,
        url: `https://github.com/${repo}/commit/abc1234`,
        author: { user: { login: 'alice' }, name: 'Alice' },
      },
    ],
    pullRequests: [],
    issues: [],
    releases: [],
  };
}

describe('buildDatasetFromConfig', () => {
  test('records successful and missing repos while filtering old events', async () => {
    const { dataset, health } = await buildDatasetFromConfig(config, {
      generatedAt,
      logger,
      windowDays: 90,
      fetchActivity: async (repo) => {
        if (repo === 'owner/missing') return null;
        if (repo === 'owner/old') return activity(repo, '2026-01-01T00:00:00Z');
        return activity(repo, '2026-05-09T00:00:00Z');
      },
    });

    expect(dataset.events.map((event) => event.repo)).toEqual(['owner/active']);
    expect(health).toMatchObject({
      totalRepos: 3,
      successfulRepos: 2,
      missingRepos: ['owner/missing'],
      failedRepos: [],
      eventCount: 1,
    });
  });

  test('records unexpected fetch failures without writing a healthy summary', async () => {
    const { health } = await buildDatasetFromConfig(config, {
      generatedAt,
      logger,
      fetchActivity: async (repo) => {
        if (repo === 'owner/old') throw new Error('rate limited');
        if (repo === 'owner/missing') return null;
        return activity(repo, '2026-05-09T00:00:00Z');
      },
    });

    expect(health.failedRepos).toEqual([{ repo: 'owner/old', message: 'rate limited' }]);
    expect(() => assertFetchHealthy(health)).toThrow(UnhealthyFetchError);
    expect(() => assertFetchHealthy(health, 1)).not.toThrow();
  });
});

describe('getToken', () => {
  test('requires a GitHub token and accepts GH_TOKEN fallback', () => {
    expect(() => getToken({})).toThrow('GITHUB_TOKEN (or GH_TOKEN) is required');
    expect(getToken({ GH_TOKEN: 'fallback' })).toBe('fallback');
    expect(getToken({ GITHUB_TOKEN: 'primary', GH_TOKEN: 'fallback' })).toBe('primary');
  });
});

describe('assertFetchHealthy', () => {
  test('allows healthy summaries', () => {
    const health: FetchHealth = {
      totalRepos: 1,
      successfulRepos: 1,
      missingRepos: [],
      failedRepos: [],
      eventCount: 1,
    };

    expect(() => assertFetchHealthy(health)).not.toThrow();
  });
});
