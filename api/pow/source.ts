import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { FIRST_HISTORY_YEAR, historyMonths, parseSource } from '../../src/pow/model.js';
import { claimRefresh, readCache, refresh } from '../../server/cache.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET required.' });
  }
  let source;
  let month: string;
  try {
    if (
      Object.keys(req.query).some((k) => k !== 'kind' && k !== 'value' && k !== 'month') ||
      typeof req.query.kind !== 'string' ||
      typeof req.query.value !== 'string'
    )
      throw new Error('Supply exactly one source: kind and value.');
    source = parseSource(req.query.kind, req.query.value);
    month = typeof req.query.month === 'string' ? req.query.month : historyMonths()[0];
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
      month < `${FIRST_HISTORY_YEAR}-01` ||
      month > new Date().toISOString().slice(0, 7)
    )
      throw new Error('Month must be between January 2008 and the current month.');
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
  try {
    const cached = await readCache(source, month);
    if (cached.stale && cached.retry && !cached.refreshing) {
      const token = await claimRefresh(source, month);
      if (token) {
        if (cached.snapshot) {
          waitUntil(refresh(source, token, month));
          cached.refreshing = true;
        } else {
          await refresh(source, token, month);
          return res.status(200).json(await readCache(source, month));
        }
      } else if (!cached.snapshot) {
        const latest = await readCache(source, month);
        return res.status(200).json({
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
