import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { publicAddress } from './relay.js';

// Profile pictures are untrusted URLs. Pin public DNS answers and bound every download.
export async function previewAvatar(input: string | undefined): Promise<string | undefined> {
  if (!input) return;
  try {
    const url = new URL(input);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    )
      return;
    const signal = AbortSignal.timeout(3500);
    const addresses = await new Promise<Awaited<ReturnType<typeof lookup>>[]>((resolve, reject) => {
      const abort = () => reject(new Error('Avatar lookup timed out.'));
      signal.addEventListener('abort', abort, { once: true });
      lookup(url.hostname, { all: true })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) return;
    const target = addresses[0];
    return await new Promise<string>((resolve, reject) => {
      const request = get(
        url,
        {
          signal,
          headers: { Accept: 'image/png,image/jpeg,image/webp' },
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [target]);
            else callback(null, target.address, target.family);
          },
        },
        (response) => {
          const type = response.headers['content-type']?.split(';')[0];
          if (
            response.statusCode !== 200 ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(type ?? '')
          ) {
            response.destroy();
            reject(new Error('Avatar unavailable.'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024) response.destroy(new Error('Avatar too large.'));
            else chunks.push(chunk);
          });
          response.on('end', () =>
            resolve(`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
    });
  } catch {
    return;
  }
}
