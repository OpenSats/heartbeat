import { nip19, verifyEvent, type Event } from 'nostr-tools';
import { parseSource } from './model';

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
