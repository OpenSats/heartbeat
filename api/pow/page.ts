import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { powParams } from '../../src/pow/url.js';
import { previewParams, publicOrigin } from '../../server/preview-request.js';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
let template: Promise<string> | undefined;
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).end();
  }
  let params: URLSearchParams;
  try {
    params = previewParams(req);
  } catch {
    return res.status(400).send('Invalid preview sources.');
  }
  template ??= readFile(join(process.cwd(), 'dist/index.html'), 'utf8').catch((error) => {
    template = undefined;
    throw error;
  });
  const origin = publicOrigin(req);
  const person = typeof req.query.person === 'string' ? req.query.person : '';
  const label = (
    person ||
    params.get('p') ||
    params.get('gh') ||
    params.get('ngit') ||
    params.get('repo') ||
    'Public activity'
  ).slice(0, 120);
  const title = `heartbeat/pow · ${label}`;
  const description =
    'Public activity across GitHub, Nostr, and ngit / GRASP. A year of activity in one heatmap.';
  params.sort();
  const image = `${origin}/api/pow/og?${params.toString()}`;
  const canonical = new URL(person ? `/pow/${encodeURIComponent(person)}` : '/pow', origin);
  const query = new URLSearchParams(params);
  if (person) {
    // The path already supplies this source. Preserve all additional sources and the year.
    const source = powParams(`/pow/${encodeURIComponent(person)}`, '');
    for (const [key, value] of source) query.delete(key, value);
  }
  canonical.search = query.toString();
  const meta = [
    ['name', 'description', description],
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', 'heartbeat by OpenSats'],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:url', canonical.toString()],
    ['property', 'og:image', image],
    ['property', 'og:image:type', 'image/png'],
    ['property', 'og:image:width', '1200'],
    ['property', 'og:image:height', '630'],
    [
      'property',
      'og:image:alt',
      `${label}: combined public activity heatmap, with counts by source`,
    ],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', description],
    ['name', 'twitter:image', image],
    ['name', 'twitter:image:alt', `${label}: public activity heatmap`],
  ]
    .map(
      ([attribute, key, value]) => `<meta ${attribute}="${key}" content="${escapeHtml(value)}" />`,
    )
    .join('\n');
  const html = (await template)
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
    .replace(
      /<meta\b[^>]*(?:property|name)=["'](?:og:[^"']*|twitter:[^"']*|description)["'][^>]*>/gi,
      '',
    )
    .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi, '')
    .replace(
      '</head>',
      `<link rel="canonical" href="${escapeHtml(canonical.toString())}" />\n${meta}\n</head>`,
    );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return req.method === 'HEAD' ? res.status(200).end() : res.status(200).send(html);
}
