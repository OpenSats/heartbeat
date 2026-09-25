import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { collectNostr, latestRelayList, writeRelays } from './nostr.js';
import { parseSource } from '../src/pow/model.js';

const secret = generateSecretKey();
const author = getPublicKey(secret);
const source = parseSource('nostr', nip19.npubEncode(author));
const bounds = { from: '2025-01-01T00:00:00.000Z', to: '2025-01-31T23:59:59.999Z' };
const signed = (created_at: number, tags: string[][], key = secret) =>
  finalizeEvent({ kind: 10002, created_at, tags, content: '' }, key);

test('outbox selection uses the latest signed author list and only write/both relays', () => {
  const old = signed(1, [['r', 'wss://old.example']]);
  const current = signed(2, [
    ['r', 'wss://write.example', 'write'],
    ['r', 'wss://both.example/'],
    ['r', 'wss://both.example'],
    ['r', 'wss://read.example', 'read'],
    ['r', 'wss://unknown.example', 'unknown'],
    ['r', 'http://unsafe.example'],
  ]);
  const otherAuthor = signed(3, [['r', 'wss://wrong.example']], generateSecretKey());
  const forged = JSON.parse(JSON.stringify(current));
  forged.created_at = 4;
  assert.equal(latestRelayList(author, [old, current, otherAuthor, forged])?.id, current.id);
  assert.deepEqual(writeRelays(current), ['wss://write.example', 'wss://both.example']);
  const cleared = signed(5, []);
  assert.deepEqual(writeRelays(latestRelayList(author, [current, cleared])), []);
  const tie = signed(2, [['r', 'wss://tie.example']]);
  assert.equal(latestRelayList(author, [tie, current])?.id, [tie.id, current.id].sort()[0]);
});

test('month collection resumes relay cursors and retains observations when relays omit them', async () => {
  const note = finalizeEvent(
    { kind: 1, created_at: 1736000000, tags: [], content: 'hello' },
    secret,
  );
  let discoveries = 0;
  const discover = async () => {
    discoveries++;
    return { relays: ['wss://write.example'], incomplete: false };
  };
  const first = await collectNostr(source, '2025-01', null, bounds, {
    discover,
    query: async () => ({ events: [note], exhaustive: false, nextUntil: note.created_at }),
  });
  assert.equal(first.windows?.[0].exhaustive, false);
  assert.equal(first.relayFetches?.[0].status, 'partial');
  assert.equal(first.relayFetches?.[0].eventCount, 1);
  assert.equal(first.pendingRelays?.[0].until, note.created_at);
  const second = await collectNostr(source, '2025-01', first, bounds, {
    discover,
    query: async (_url, _filters, options) => {
      assert.equal(options?.until, note.created_at);
      return { events: [], exhaustive: true };
    },
  });
  assert.equal(discoveries, 1);
  assert.equal(second.events.length, 1);
  assert.equal(second.relayFetches?.[0].status, 'complete');
  assert.equal(second.windows?.[0].exhaustive, true);
  const refreshed = await collectNostr(source, '2025-01', second, bounds, {
    discover,
    query: async () => ({ events: [], exhaustive: true }),
  });
  assert.equal(refreshed.events[0].id, note.id);
});

test('unavailable relays get bounded retries and leave coverage incomplete', async () => {
  const dependencies = {
    discover: async () => ({ relays: ['wss://down.example'], incomplete: false }),
    query: async () => {
      throw new Error('unavailable');
    },
  };
  let snapshot = await collectNostr(source, '2025-01', null, bounds, dependencies);
  for (let i = 0; i < 2; i++)
    snapshot = await collectNostr(source, '2025-01', snapshot, bounds, dependencies);
  assert.deepEqual(snapshot.pendingRelays, []);
  assert.equal(snapshot.relayIncomplete, true);
  assert.equal(snapshot.relayFetches?.[0].status, 'unavailable');
  assert.equal(snapshot.windows?.[0].exhaustive, false);
});
