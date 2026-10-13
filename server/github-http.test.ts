import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubResponse } from './github-http.js';

test('follows renamed repository redirects through the budgeted sender', async () => {
  const paths: string[] = [];
  const response = await githubResponse(
    '/repos/old/name/issues/14/timeline?page=1',
    async (path) => {
      paths.push(path);
      return paths.length === 1
        ? new Response(null, {
            status: 301,
            headers: {
              location: 'https://api.github.com/repositories/123/issues/14/timeline?page=1',
            },
          })
        : Response.json([]);
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(paths, [
    '/repos/old/name/issues/14/timeline?page=1',
    '/repositories/123/issues/14/timeline?page=1',
  ]);
});

test('rejects external redirects before sending credentials and bounds loops', async () => {
  let calls = 0;
  await assert.rejects(
    githubResponse('/repos/test/repo', async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/steal' },
      });
    }),
    /outside api.github.com/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    githubResponse('/loop', async () => {
      calls++;
      return new Response(null, { status: 301, headers: { location: '/loop' } });
    }),
    /too many redirects/,
  );
  assert.equal(calls, 4);
});

test('reports the failing endpoint and network cause', async () => {
  await assert.rejects(
    githubResponse('/repos/test/repo', async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    }),
    /GitHub \/repos\/test\/repo: ECONNRESET/,
  );
});
