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
      if (error instanceof Error && error.name === 'TypeError') {
        const cause = error.cause as { code?: string; message?: string } | undefined;
        throw new Error(`GitHub ${endpoint}: ${cause?.code ?? cause?.message ?? error.message}`, {
          cause: error,
        });
      }
      throw error;
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error(`GitHub ${endpoint}: redirect without a location.`);
    url = new URL(location, url);
  }
  throw new Error(`GitHub ${path}: too many redirects.`);
}
