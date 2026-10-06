import type { VercelRequest, VercelResponse } from '@vercel/node';
import { recoverExpiredJobs } from '../../server/recover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET required.' });
  }
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const result = await recoverExpiredJobs();
    console.log('PoW queue recovery', result);
    return res.status(result.failed ? 503 : 200).json(result);
  } catch {
    return res.status(503).json({ error: 'Queue recovery is temporarily unavailable.' });
  }
}
