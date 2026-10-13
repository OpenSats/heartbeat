// Only for derived display text. Never apply this to signed Nostr events.
export function displayText(value: string, maxLength: number): string {
  const clean = value
    .replace(/\u0000/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  return Array.from(clean).slice(0, maxLength).join('');
}
