import { describe, expect, test } from 'bun:test';

type HeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
};

describe('vercel.json', () => {
  test('declares security and cache headers for the static deployment', async () => {
    const config = (await Bun.file('vercel.json').json()) as { headers: HeaderRule[] };
    const allRoutes = config.headers.find((rule) => rule.source === '/(.*)');
    const assets = config.headers.find((rule) => rule.source === '/assets/(.*)');
    const events = config.headers.find((rule) => rule.source === '/data/events.json');

    expect(allRoutes?.headers.map((header) => header.key)).toContain('Content-Security-Policy');
    expect(allRoutes?.headers).toContainEqual({
      key: 'X-Content-Type-Options',
      value: 'nosniff',
    });
    expect(assets?.headers).toContainEqual({
      key: 'Cache-Control',
      value: 'public, max-age=31536000, immutable',
    });
    expect(events?.headers).toContainEqual({
      key: 'Cache-Control',
      value: 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    });
  });
});
