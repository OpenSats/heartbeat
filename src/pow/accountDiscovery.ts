import { nip19, verifyEvent, type Event } from 'nostr-tools';
import { parseSource } from './model.js';
import { nip05Address } from './nip05.js';

export function profileNpubs(text: string) {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bnpub1[023456789acdefghjklmnpqrstuvwxyz]{58}\b/gi)) {
    try {
      found.add(parseSource('nostr', match[0].toLowerCase()).label);
    } catch {
      /* Ignore invalid checksums. */
    }
  }
  return [...found].slice(0, 3);
}

export function profileNip05Links(text: string) {
  const addresses = new Set<string>();
  for (const match of text.matchAll(
    /(?<![\w@./-])(?:https?:\/\/|njump\.(?:me|to)\/)[^\s<>"']+/gi,
  )) {
    try {
      const value = match[0].replace(/[),.;!?]+$/, '');
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      if (
        !['njump.to', 'njump.me'].includes(url.hostname.toLowerCase()) ||
        url.username ||
        url.password ||
        url.port
      )
        continue;
      const path = /^\/([^/]+)\/?$/.exec(url.pathname);
      if (path) addresses.add(nip05Address(decodeURIComponent(path[1])).address);
    } catch {
      /* Ignore links that do not identify a NIP-05 address. */
    }
  }
  return [...addresses].slice(0, 3);
}

export function githubClaims(event: Event | null, npub: string) {
  const decoded = nip19.decode(npub);
  if (
    !event ||
    decoded.type !== 'npub' ||
    event.pubkey !== decoded.data ||
    ![0, 10011].includes(event.kind) ||
    !verifyEvent(event)
  )
    return [];
  return event.tags
    .flatMap((tag) => {
      if (
        tag[0] !== 'i' ||
        !tag[1]?.startsWith('github:') ||
        !/^[a-f0-9]{1,64}$/i.test(tag[2] ?? '')
      )
        return [];
      try {
        return [{ handle: parseSource('github', tag[1].slice(7)).value, gist: tag[2] }];
      } catch {
        return [];
      }
    })
    .slice(0, 3);
}

export function matchingGithubProof(
  proof: { owner?: string; content?: string | null },
  handle: string,
  npub: string,
) {
  return (
    proof.owner?.toLowerCase() === handle.toLowerCase() &&
    proof.content?.trim() === `Verifying that I control the following Nostr public key: ${npub}`
  );
}

export function profileMetadata(event: Event | null, npub: string): Record<string, unknown> {
  try {
    const decoded = nip19.decode(npub);
    if (
      !event ||
      event.kind !== 0 ||
      decoded.type !== 'npub' ||
      event.pubkey !== decoded.data ||
      !verifyEvent(event)
    )
      return {};
    const profile = JSON.parse(event.content);
    return profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  } catch {
    return {};
  }
}

export function websiteDomain(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}
