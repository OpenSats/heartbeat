import type { VercelRequest, VercelResponse } from '@vercel/node';
import { nip05Address } from '../../src/pow/nip05.js';
import { nip19 } from 'nostr-tools';
import { resolveNip05, verifiedNip05 } from '../../server/nip05.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET required.' });
  }
  if ('npub' in req.query) {
    let npub: string;
    try {
      if (
        typeof req.query.npub !== 'string' ||
        Object.keys(req.query).some((key) => key !== 'npub')
      )
        throw new Error('Supply one npub.');
      const decoded = nip19.decode(req.query.npub);
      if (decoded.type !== 'npub') throw new Error('Supply one npub.');
      npub = nip19.npubEncode(decoded.data);
    } catch {
      return res.status(400).json({ error: 'Supply one valid npub.' });
    }
    const identifier = await verifiedNip05(npub);
    res.setHeader(
      'Cache-Control',
      identifier ? 'public, max-age=300, s-maxage=3600' : 'public, max-age=60, s-maxage=300',
    );
    return res.status(200).json({ npub, identifier });
  }
  let address: string;
  try {
    if (
      typeof req.query.address !== 'string' ||
      Object.keys(req.query).some((key) => key !== 'address')
    )
      throw new Error('Supply one NIP-05 address.');
    address = nip05Address(req.query.address).address;
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
  try {
    const result = await resolveNip05(address);
    // Cache this public lookup independently. Activity remains keyed by the resolved npub.
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
    return res.status(200).json(result);
  } catch (error) {
    const message =
      error instanceof Error && error.message.startsWith('No valid Nostr')
        ? error.message
        : 'Unable to resolve this NIP-05 address. Check the address or use its npub.';
    return res.status(502).json({ error: message });
  }
}
