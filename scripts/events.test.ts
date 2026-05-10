import { describe, expect, test } from 'bun:test';
import { DatasetSchema } from '../src/types';
import { repoActivityToEvents, type GitHubRepoActivity } from './events';

const repo = 'owner/project';

describe('repoActivityToEvents', () => {
  test('maps GitHub activity to stable heartbeat events', () => {
    const activity: GitHubRepoActivity = {
      repo,
      commits: [
        {
          oid: 'abcdef123',
          abbreviatedOid: 'abcdef1',
          committedDate: '2026-05-01T10:00:00Z',
          messageHeadline: 'add feature',
          url: 'https://github.com/owner/project/commit/abcdef123',
          author: { user: { login: 'alice' }, name: 'Alice' },
        },
      ],
      pullRequests: [
        {
          number: 42,
          title: 'Ship it',
          url: 'https://github.com/owner/project/pull/42',
          createdAt: '2026-05-01T11:00:00Z',
          mergedAt: '2026-05-02T11:00:00Z',
          closedAt: '2026-05-02T11:00:00Z',
          merged: true,
          author: { login: 'bob' },
          mergedBy: { login: 'carol' },
        },
      ],
      issues: [
        {
          number: 7,
          title: 'Broken thing',
          url: 'https://github.com/owner/project/issues/7',
          createdAt: '2026-05-01T12:00:00Z',
          closedAt: '2026-05-03T12:00:00Z',
          author: { login: 'dave' },
        },
      ],
      releases: [
        {
          tagName: 'v1.0.0',
          name: null,
          url: 'https://github.com/owner/project/releases/tag/v1.0.0',
          publishedAt: null,
          createdAt: '2026-05-04T12:00:00Z',
          author: null,
        },
      ],
    };

    const events = repoActivityToEvents(activity);

    expect(events.map((event) => event.id)).toEqual([
      `${repo}:commit:abcdef123`,
      `${repo}:pr_opened:42`,
      `${repo}:pr_merged:42`,
      `${repo}:issue_opened:7`,
      `${repo}:issue_closed:7`,
      `${repo}:release:v1.0.0`,
    ]);
    expect(events.map((event) => event.actor)).toEqual([
      'alice',
      'bob',
      'carol',
      'dave',
      'dave',
      'unknown',
    ]);
  });

  test('maps closed unmerged PRs separately from merged PRs', () => {
    const activity: GitHubRepoActivity = {
      repo,
      commits: [],
      pullRequests: [
        {
          number: 3,
          title: 'Close only',
          url: 'https://github.com/owner/project/pull/3',
          createdAt: '2026-05-01T11:00:00Z',
          mergedAt: null,
          closedAt: '2026-05-02T11:00:00Z',
          merged: false,
          author: null,
          mergedBy: null,
        },
      ],
      issues: [],
      releases: [],
    };

    expect(repoActivityToEvents(activity).map((event) => event.type)).toEqual([
      'pr_opened',
      'pr_closed',
    ]);
  });
});

describe('DatasetSchema', () => {
  test('accepts grouped datasets', () => {
    expect(() =>
      DatasetSchema.parse({
        generatedAt: '2026-05-01T00:00:00Z',
        windowDays: 90,
        repos: [repo],
        groups: { 'SEC-01': [repo] },
        catalog: {
          source: 'test',
          projectCount: 1,
          skippedLinkCount: 0,
          emptyGroups: [],
          groupCounts: { 'SEC-01': 1 },
        },
        events: [],
      }),
    ).not.toThrow();
  });
});
