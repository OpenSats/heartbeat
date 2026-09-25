import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectGithub, threadActivities, type GithubRequest } from './github.js';
import {
  hasPending,
  parseSource,
  sourceCacheKey,
  type Snapshot,
  type GithubThreadTask,
} from '../src/pow/model.js';

const bounds = { from: '2025-01-01T00:00:00.000Z', to: '2025-01-31T23:59:59.999Z' };
const timestamp = '2025-01-12T12:00:00Z';
const task: GithubThreadTask = {
  repo: 'example/project',
  number: 10,
  title: 'An old PR',
  endpoint: 'timeline',
  page: 1,
};
const issue = {
  ...task,
  html_url: 'https://github.com/example/project/pull/10',
  repository_url: 'https://api.github.com/repos/example/project',
  created_at: '2024-02-01T00:00:00Z',
  user: { login: 'creator' },
  pull_request: {},
};

test('backfills actions on old PRs, uses action authors, resumes and deduplicates discoveries', async () => {
  const requests: string[] = [];
  const request: GithubRequest = async <T>(path: string) => {
    requests.push(path);
    if (path.startsWith('/users/')) return {} as T;
    if (path === '/repos/example/project') return { private: false } as T;
    if (path.startsWith('/search/')) {
      const query = new URL(`https://api.github.com${path}`).searchParams.get('q')!;
      const items = /involves:|reviewed-by:/.test(query) ? [issue] : [];
      if (items.length) assert.match(query, /updated:2025-01-01.*\.\./);
      return { items, total_count: items.length, incomplete_results: false } as T;
    }
    if (path.includes('/timeline?'))
      return [
        {
          id: 1,
          event: 'commented',
          user: { login: 'TARGET' },
          body: 'A comment',
          created_at: timestamp,
        },
        { id: 2, event: 'closed', actor: { login: 'target' }, created_at: timestamp },
        { id: 3, event: 'closed', actor: { login: 'creator' }, created_at: timestamp },
        {
          id: 4,
          event: 'commented',
          user: { login: 'target' },
          created_at: '2024-12-31T23:59:59Z',
        },
        { id: 5, event: 'reviewed', user: { login: 'target' }, submitted_at: timestamp },
      ] as T;
    if (path.includes('/reviews?'))
      return [
        { id: 5, user: { login: 'target' }, state: 'APPROVED', submitted_at: timestamp },
        { id: 6, user: { login: 'target' }, state: 'PENDING', submitted_at: null },
        { id: 7, user: { login: 'creator' }, state: 'COMMENTED', submitted_at: timestamp },
      ] as T;
    if (path.includes('/comments?'))
      return [
        { id: 8, user: { login: 'target' }, body: 'A code comment', created_at: timestamp },
      ] as T;
    throw new Error(`Unexpected path ${path}`);
  };
  let snapshot: Snapshot | undefined;
  for (let i = 0; i < 10; i++) {
    snapshot = await collectGithub(parseSource('github', 'target'), bounds, snapshot, request);
    if (!hasPending(snapshot)) break;
  }
  assert.ok(snapshot);
  assert.equal(hasPending(snapshot), false);
  assert.deepEqual(snapshot.events.map((e) => e.type).sort(), [
    'code comment',
    'comment',
    'review',
    'status: closed',
  ]);
  assert.ok(
    snapshot.events.every((e) => e.actor.toLowerCase() === 'target' && e.timestamp === timestamp),
  );
  assert.equal(requests.filter((p) => p.includes('/timeline?')).length, 1);
  assert.equal(snapshot.windows?.[0].discoveryLimited, true);
  assert.equal(snapshot.windows?.[0].exhaustive, true);
});

test('status variants retain their action actor and IDs; actorless events are omitted', () => {
  const events = threadActivities(
    task,
    ['closed', 'reopened', 'merged', 'convert_to_draft', 'ready_for_review'].map((event, i) => ({
      id: i + 1,
      event,
      actor: { login: 'maintainer' },
      created_at: timestamp,
    })),
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ['status: closed', 'status: open', 'status: merged', 'status: draft', 'status: ready'],
  );
  assert.ok(events.every((e) => e.actor === 'maintainer'));
  assert.equal(
    threadActivities(task, [{ id: 88, event: 'closed', created_at: timestamp }]).length,
    0,
  );
});

test('thread pagination checkpoints and repository context include all actors', async () => {
  const request: GithubRequest = async <T>(path: string) => {
    if (path === '/repos/example/project') return { private: false } as T;
    const page = Number(new URL(`https://api.github.com${path}`).searchParams.get('page'));
    return Array.from({ length: page <= 5 ? 100 : 1 }, (_, i) => ({
      id: page * 100 + i,
      event: 'commented',
      user: { login: i % 2 ? 'alice' : 'bob' },
      created_at: timestamp,
    })) as T;
  };
  const previous: Snapshot = {
    githubVersion: 4,
    events: [],
    pending: [],
    pendingGithub: [task],
    windows: [{ ...bounds, exhaustive: false, basis: 'github-search' }],
    coverage: '',
    profileUrl: '',
  };
  const first = await collectGithub(
    parseSource('repo', 'example/project'),
    bounds,
    previous,
    request,
  );
  assert.equal(first.events.length, 500);
  assert.equal(first.pendingGithub?.[0].page, 6);
  const second = await collectGithub(
    parseSource('repo', 'example/project'),
    bounds,
    first,
    request,
  );
  assert.equal(second.events.length, 501);
  assert.equal(hasPending(second), false);
  assert.equal(second.windows?.[0].exhaustive, true);
  assert.equal(second.windows?.[0].discoveryLimited, false);
});

test('expanded GitHub caches are isolated from older deployments; Nostr keeps its cache', () => {
  assert.equal(
    sourceCacheKey(parseSource('github', 'target'), '2025-01'),
    'github:target:v4:2025-01',
  );
  assert.equal(
    sourceCacheKey(parseSource('repo', 'example/project'), '2025-01'),
    'repo:example/project:v4:2025-01',
  );
  const nostr = parseSource(
    'nostr',
    'npub1dergggklka99wwrs92yz8wdjs952h2ux2ha2ed598ngwu9w7a6fsh9xzpc',
  );
  assert.equal(sourceCacheKey(nostr, '2025-01'), `${nostr.key}:v3:2025-01`);
});
