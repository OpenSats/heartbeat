import assert from 'node:assert/strict';
import test from 'node:test';
import { nip19 } from 'nostr-tools';
import { parseSource, sourceCacheKey, sourcesFromUrl } from '../src/pow/model.js';
import { powParams, powUrl } from '../src/pow/url.js';

const nprofile =
  'nprofile1qyt8wumn8ghj7ct4w35zumn0wd68yvfwvdhk6tcpzemhxue69uhk2er9dchxummnw3ezumrpdejz7qpq6c9a45p5dr6l3jzmrvgdh9m7xy994tatxd6sm7kmxaygkq4lerts4cnyzf';
const npub = 'npub16c9a45p5dr6l3jzmrvgdh9m7xy994tatxd6sm7kmxaygkq4lertsfnacfm';

test('nprofile input shares the npub source, label, and monthly cache', () => {
  for (const kind of ['nostr', 'ngit']) {
    const expected = parseSource(kind, npub);
    for (const input of [nprofile, `nostr:${nprofile}`, `NOSTR:${nprofile}`]) {
      const source = parseSource(kind, input);
      assert.deepEqual(source, expected);
      assert.equal(sourceCacheKey(source, '2026-09'), sourceCacheKey(expected, '2026-09'));
    }
  }
});

test('nprofile query and person paths load Nostr/ngit without NIP-05 resolution', () => {
  for (const input of [nprofile, `nostr:${nprofile}`]) {
    for (const params of [new URLSearchParams({ p: input }), powParams(`/pow/${input}`, '')]) {
      const result = sourcesFromUrl(params);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.pending, []);
      assert.deepEqual(
        result.sources.map((s) => s.kind),
        ['nostr', 'ngit'],
      );
      assert(result.sources.every((s) => s.label === npub));
    }
  }
  const params = powParams(`/pow/${nprofile}`, '?gh=test');
  assert.equal(powUrl(params, `/pow/${nprofile}`), `/pow/${nprofile}?gh=test`);
  const ngit = sourcesFromUrl(new URLSearchParams({ ngit: nprofile }));
  assert.deepEqual(
    ngit.sources.map((s) => s.kind),
    ['ngit'],
  );
});

test('equivalent pointers deduplicate; corrupt or unrelated identifiers are rejected', () => {
  const params = new URLSearchParams([
    ['p', npub],
    ['p', nprofile],
  ]);
  assert.equal(sourcesFromUrl(params).sources.length, 2);
  const bad = sourcesFromUrl(new URLSearchParams({ p: `${nprofile.slice(0, -1)}q` }));
  assert.equal(bad.sources.length, 0);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.pending.length, 0);
  assert.throws(() => parseSource('nostr', nip19.noteEncode('ab'.repeat(32))));
});
