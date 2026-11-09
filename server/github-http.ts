import { RetryLater } from './rate-limit.js';

const origin = 'https://api.github.com';

// Each hop goes through the caller's quota reservation and response handling.
export async function githubResponse(
  path: string,
  send: (path: string) => Promise<Response>,
): Promise<Response> {
  let url = new URL(path, origin);
  for (let hop = 0; hop < 4; hop++) {
    if (url.origin !== origin || url.username || url.password)
      throw new Error('Refusing a GitHub API redirect outside api.github.com.');
    const endpoint = url.pathname + url.search;
    let response: Response;
    try {
      response = await send(endpoint);
    } catch (error) {
      // Keep RetryLater intact so provider cooldowns do not count as failures.
      if (error instanceof RetryLater) throw error;
      const cause =
        error instanceof Error
          ? (error.cause as { code?: string; message?: string } | undefined)
          : undefined;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`GitHub ${endpoint}: ${cause?.code ?? cause?.message ?? message}`, {
        cause: error,
      });
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error(`GitHub ${endpoint}: redirect without a location.`);
    url = new URL(location, url);
  }
  throw new Error(`GitHub ${path}: too many redirects.`);
}

export class GithubSearchUnavailable extends Error {}

// Only this validation error means the account cannot be searched. Other 422s
// (including abuse limits) must keep their normal retry/failure behavior.
export async function checkGithubSearchResponse(path: string, response: Response) {
  if (!path.startsWith('/search/') || response.status !== 422) return;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    errors?: { resource?: string; field?: string; code?: string; message?: string }[];
  } | null;
  if (
    body?.errors?.some(
      (error) =>
        error.resource === 'Search' &&
        error.field === 'q' &&
        error.code === 'invalid' &&
        error.message?.includes('The listed users cannot be searched'),
    )
  )
    throw new GithubSearchUnavailable('GitHub cannot search this account.');
}
