import assert from 'node:assert/strict';
import test from 'node:test';
import { powGithubToken, quotaPauseUntil } from './github-budget.js';

// No network calls: exercise the credential boundary and early-stop threshold.
test('PoW never falls back to shared credentials or accepts the same token', () => {
  const old = { shared: process.env.GITHUB_TOKEN, pow: process.env.POW_GITHUB_TOKEN };
  try {
    process.env.GITHUB_TOKEN = 'shared';
    delete process.env.POW_GITHUB_TOKEN;
    assert.throws(powGithubToken, /separate PoW credential/);
    process.env.POW_GITHUB_TOKEN = 'shared';
    assert.throws(powGithubToken, /separate PoW credential/);
    process.env.POW_GITHUB_TOKEN = 'dedicated';
    assert.equal(powGithubToken(), 'dedicated');
  } finally {
    if (old.shared === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = old.shared;
    if (old.pow === undefined) delete process.env.POW_GITHUB_TOKEN;
    else process.env.POW_GITHUB_TOKEN = old.pow;
  }
});

test('quota reserve stops before exhaustion and resumes after reset', () => {
  const now = 1_000_000;
  const response = (remaining: string, reset = '2000') =>
    new Response(null, {
      headers: { 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': reset },
    });
  assert.equal(quotaPauseUntil(response('1001'), 1000, now), null);
  assert.equal(quotaPauseUntil(response('1000'), 1000, now), 2_001_000);
  assert.equal(quotaPauseUntil(response('0'), 1000, now), 2_001_000);
  assert.equal(quotaPauseUntil(response('5'), 5, now), 2_001_000);
  assert.equal(quotaPauseUntil(response('5', 'bad'), 5, now), now + 60_000);
  assert.equal(quotaPauseUntil(new Response(null), 1000, now), null);
});
