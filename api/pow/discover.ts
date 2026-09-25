import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parseSource } from '../../src/pow/model.js';
import { accountEvidence } from '../../server/account-discovery.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET required.' });
  }
  const { kind, value } = req.query;
  try {
    if (
      typeof kind !== 'string' ||
      typeof value !== 'string' ||
      Object.keys(req.query).some((k) => !['kind', 'value'].includes(k))
    )
      throw new Error('Supply one source.');
    if (kind === 'github' || kind === 'nostr') parseSource(kind, value);
    else if (kind !== 'gist' || !/^[a-f0-9]{1,64}$/i.test(value))
      throw new Error('Invalid source.');
  } catch {
    return res.status(400).json({ error: 'Supply one GitHub handle, npub, or gist ID.' });
  }
  try {
    const result = await accountEvidence(kind as string, value as string);
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
    return res.status(200).json(result);
  } catch {
    return res.status(503).json({ error: 'Account discovery is temporarily unavailable.' });
  }
}
