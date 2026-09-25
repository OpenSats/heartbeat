import type { VercelRequest } from '@vercel/node';
import { powParams } from '../src/pow/url.js';

export const previewKeys = ['p', 'gh', 'ngit', 'repo', 'year'] as const;
export function previewParams(req: VercelRequest) {
  const params = new URLSearchParams();
  for (const key of previewKeys) {
    const value = req.query[key];
    for (const item of Array.isArray(value) ? value : value ? [value] : [])
      params.append(key, item);
  }
  const person = typeof req.query.person === 'string' ? req.query.person : '';
  if (params.toString().length + person.length > 6000 || [...params].length > 24)
    throw new Error('Too many sources.');
  return powParams(person ? `/pow/${encodeURIComponent(person)}` : '/pow', params.toString());
}

// Never use a caller-supplied host for server-side requests.
export function evidenceOrigin() {
  const host = process.env.VERCEL_URL;
  return host && /^[a-z0-9.-]+\.vercel\.app$/i.test(host)
    ? `https://${host}`
    : 'https://heartbeat.opensats.org';
}
export function publicOrigin(req: VercelRequest) {
  const host = req.headers.host ?? '';
  return /^(heartbeat\.opensats\.org|[a-z0-9-]+\.vercel\.app)$/i.test(host)
    ? `https://${host}`
    : evidenceOrigin();
}
