import { nip19 } from 'nostr-tools';
import type { Source } from './model';

export const NGIT_KINDS = [1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 30617, 30618];
export const NGIT_COMMENT_ROOTS = ['1617', '1618', '1621', '30617'];
export const NGIT_TYPES: Record<number, string> = {
  1617: 'patch',
  1618: 'pull request',
  1619: 'PR update',
  1621: 'issue',
  1630: 'status: open',
  1631: 'status: resolved',
  1632: 'status: closed',
  1633: 'status: draft',
  30617: 'repository',
  30618: 'refs update',
  1111: 'code comment',
};

export function relayUrl(value: string): string {
  const url = new URL(value.includes('://') ? value : `wss://${value}`);
  if (
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.port && url.port !== '443') ||
    url.href.length > 300
  )
    throw new Error('Use a public wss:// relay on port 443.');
  return url.href.replace(/\/$/, '');
}

export function repositoryPointer(value: string) {
  const decoded = nip19.decode(value);
  if (decoded.type !== 'naddr' || decoded.data.kind !== 30617)
    throw new Error('Use a NIP-34 repository address (kind 30617).');
  return decoded.data;
}

export function parseGrasp(input: string): Source {
  let value = input.replace(/^nostr:(?:\/\/)?/, '').replace(/\/$/, '');
  let pubkey: string;
  let identifier: string;
  let relays: string[] = [];
  if (value.startsWith('naddr1')) {
    ({ pubkey, identifier, relays = [] } = repositoryPointer(value));
  } else {
    let parts: string[];
    if (/^https:\/\//.test(value)) {
      const url = new URL(value);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.port && url.port !== '443')
      )
        throw new Error('Use a public GRASP repository URL.');
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts.length !== 2) throw new Error('Use a GRASP URL ending in /npub/repository.git.');
      relays = [relayUrl(`wss://${url.host}`)];
      parts[1] = parts[1].replace(/\.git$/, '');
    } else {
      parts = value.split('/').map(decodeURIComponent);
      if (parts.length === 3) {
        if (parts[1]) relays = [relayUrl(parts[1])];
        parts.splice(1, 1);
      }
      if (parts.length !== 2)
        throw new Error('Use nostr://npub/repository, an naddr, or a GRASP HTTPS URL.');
    }
    const decoded = nip19.decode(parts[0]);
    if (decoded.type !== 'npub') throw new Error('The repository owner must be an npub.');
    pubkey = decoded.data;
    identifier = parts[1];
  }
  if (!identifier || identifier.length > 200 || /[\x00-\x1f\x7f]/.test(identifier))
    throw new Error('Invalid repository identifier.');
  relays = [...new Set(relays.map(relayUrl))].slice(0, 4);
  value = nip19.naddrEncode({ kind: 30617, pubkey, identifier, relays });
  return {
    key: `grasp:${pubkey}:${identifier}`,
    kind: 'grasp',
    value,
    label: `${nip19.npubEncode(pubkey)}/${identifier}`,
  };
}
