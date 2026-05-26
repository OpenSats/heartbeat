import { existsSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

describe('netlify.toml', () => {
  test('runs the provider-neutral deploy build before publishing the static site', async () => {
    const config = await Bun.file('netlify.toml').text();
    const pkg = await Bun.file('package.json').json();

    expect(config).toContain('command = "bun run deploy-build"');
    expect(config).toContain('publish = "dist"');
    expect(config).toContain('BUN_VERSION = "1.3.3"');
    expect(pkg.scripts['deploy-build']).toBe('bun run fetch && bun run build');
    expect(pkg.scripts['vercel-build']).toBeUndefined();
  });

  test('does not keep active legacy-provider deployment config on the Netlify branch', () => {
    expect(existsSync('vercel.json')).toBe(false);
  });

  test('declares security and cache headers for the Netlify deployment', async () => {
    const config = await Bun.file('netlify.toml').text();

    expect(config).toContain('for = "/*"');
    expect(config).toContain('Content-Security-Policy = "default-src');
    expect(config).toContain('X-Content-Type-Options = "nosniff"');
    expect(config).toContain('for = "/assets/*"');
    expect(config).toContain('Cache-Control = "public, max-age=31536000, immutable"');
    expect(config).toContain('for = "/data/events.json"');
    expect(config).toContain(
      'Cache-Control = "public, max-age=0, s-maxage=300, stale-while-revalidate=3600"',
    );
  });
});
