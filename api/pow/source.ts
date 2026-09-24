import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { parseSource } from '../../src/pow/model.js';
import { claimRefresh, readCache, refresh } from '../../server/cache.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET required.' });
  }
  let source;
  try {
    if (
      Object.keys(req.query).some((k) => k !== 'kind' && k !== 'value') ||
      typeof req.query.kind !== 'string' ||
      typeof req.query.value !== 'string'
    )
      throw new Error('Supply exactly one source: kind and value.');
    source = parseSource(req.query.kind, req.query.value);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
  try {
    const cached = await readCache(source);
    if (cached.stale && cached.retry && !cached.refreshing) {
      const token = await claimRefresh(source);
      if (token) {
        if (cached.snapshot) {
          waitUntil(refresh(source, token));
          cached.refreshing = true;
        } else {
          await refresh(source, token);
          return res.status(200).json(await readCache(source));
        }
      } else if (!cached.snapshot) {
        const latest = await readCache(source);
        return res
          .status(200)
          .json({
            ...latest,
            error: latest.refreshing ? null : 'Refresh capacity reached. Please try again later.',
          });
      }
    }
    return res.status(200).json(cached);
  } catch {
    return res
      .status(503)
      .json({ error: 'The activity cache is temporarily unavailable. Please try again shortly.' });
  }
}
