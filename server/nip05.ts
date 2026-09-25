import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { nip19 } from 'nostr-tools';
import { publicAddress } from './relay.js';
import { nip05Address } from '../src/pow/nip05.js';

export async function resolveNip05(input: string) {
  const { name, domain, address } = nip05Address(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(domain, { all: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('NIP-05 lookup timed out.')), 4000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw new Error('NIP-05 must resolve to a public server.');
  const target = addresses[0];
  const document = await new Promise<string>((resolve, reject) => {
    const request = get(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [target]);
          else callback(null, target.address, target.family);
        },
      },
      (response) => {
        // NIP-05 forbids redirects. Never forward requests to another destination.
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error('The domain did not return a NIP-05 document.'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256 * 1024) {
            response.destroy(new Error('The NIP-05 document is too large.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      },
    );
    request.on('error', reject);
  });
  let pubkey: unknown;
  try {
    pubkey = JSON.parse(document)?.names?.[name];
  } catch {
    throw new Error('The domain returned an invalid NIP-05 document.');
  }
  if (typeof pubkey !== 'string' || !/^[a-f0-9]{64}$/.test(pubkey))
    throw new Error(`No valid Nostr public key was found for ${address}.`);
  return { address, npub: nip19.npubEncode(pubkey) };
}
