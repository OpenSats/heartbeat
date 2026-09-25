import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPreview } from '../../server/pow-preview.js';
import { previewParams } from '../../server/preview-request.js';
import { previewAvatar } from '../../server/preview-avatar.js';
import { renderPreview } from '../../server/preview-image.js';

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
    return res.status(400).json({ error: 'Invalid preview sources.' });
  }
  try {
    const preview = await loadPreview(params);
    const avatar = await previewAvatar(preview.avatar);
    let image: ArrayBuffer;
    try {
      image = await (await renderPreview(preview, avatar)).arrayBuffer();
    } catch {
      image = await (await renderPreview(preview)).arrayBuffer();
    }
    res.setHeader('Content-Type', 'image/png');
    // Short-lived cold/partial cards improve as the normal page fills source caches.
    const ttl =
      preview.unavailable || preview.cachedMonths < preview.expectedMonths || !preview.cachedMonths
        ? 60
        : 3600;
    res.setHeader(
      'Cache-Control',
      `public, max-age=60, s-maxage=${ttl}, stale-while-revalidate=300`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return req.method === 'HEAD' ? res.status(200).end() : res.status(200).send(Buffer.from(image));
  } catch (error) {
    console.error(
      'PoW preview rendering failed:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    return res.status(503).json({ error: 'Preview temporarily unavailable.' });
  }
}
