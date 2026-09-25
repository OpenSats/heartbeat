export function nip05Address(input: string) {
  const value = input
    .trim()
    .replace(/^nostr:/, '')
    .toLowerCase();
  const parts = value.split('@');
  if (parts.length > 2) throw new Error('Enter an npub, a domain, or name@domain.');
  const name = parts.length === 2 ? parts[0] : '_';
  const domain = parts.at(-1)!;
  if (
    !/^[a-z0-9_.-]{1,64}$/.test(name) ||
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)
  )
    throw new Error('Enter an npub, a domain, or name@domain.');
  return { name, domain, address: `${name}@${domain}` };
}
