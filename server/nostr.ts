import { neon } from '@neondatabase/serverless';
import { nip19, verifyEvent, type Event } from 'nostr-tools';
import { relayUrl } from '../src/pow/ngit.js';
import type { RelayTask, Snapshot, Source } from '../src/pow/model.js';
import { queryRelay } from './relay.js';

const FALLBACK = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const DISCOVERY = [
  'wss://purplepag.es',
  ...FALLBACK,
  'wss://relay.nostr.com',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://nos.relay',
  'wss://nostr.inosta.cc',
  'wss://nostr.wine',
];
type Outbox = { relays: string[]; incomplete: boolean };

export function latestRelayList(author: string, events: Event[]): Event | undefined {
  return events
    .filter((event) => {
      try {
        return (
          event.pubkey === author &&
          event.kind === 10002 &&
          event.created_at <= Math.floor(Date.now() / 1000) &&
          verifyEvent(event)
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

export function writeRelays(event?: Event): string[] {
  const urls: string[] = [];
  for (const [name, url, marker] of event?.tags ?? []) {
    if (name !== 'r' || (marker !== undefined && marker !== '' && marker !== 'write')) continue;
    try {
      urls.push(relayUrl(url));
    } catch {
      /* Unsupported relay address. */
    }
  }
  return [...new Set(urls)];
}

export async function discoverOutbox(author: string): Promise<Outbox> {
  const sql = neon(process.env.DATABASE_URL!);
  // This stores one pubkey's relay list, never associations between accounts.
  const key = `nostr:${author}:outbox:v1`;
  const [cached] =
    await sql`SELECT snapshot, fetched_at FROM pow_sources WHERE source_key = ${key}`;
  const ttl = cached?.snapshot?.incomplete ? 3600000 : 86400000;
  if (cached && Date.now() - Date.parse(cached.fetched_at) < ttl) return cached.snapshot;
  const results = await Promise.allSettled(
    DISCOVERY.map((url) =>
      queryRelay(url, [{ authors: [author], kinds: [10002] }], { once: true, timeout: 7000 }),
    ),
  );
  const observed = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.events : []));
  // A temporarily missing list must not erase previously discovered write relays.
  const event = latestRelayList(author, [
    ...observed,
    ...(cached?.snapshot?.event ? [cached.snapshot.event] : []),
  ]);
  const writes = writeRelays(event);
  const incomplete =
    !results.some((r) => r.status === 'fulfilled' && r.value.exhaustive) || writes.length > 8;
  const snapshot = {
    event,
    relays: [...new Set([...writes.slice(0, 8), ...FALLBACK])],
    incomplete,
  };
  await sql`INSERT INTO pow_sources (source_key, snapshot, fetched_at) VALUES (${key}, ${JSON.stringify(snapshot)}::jsonb, now())
    ON CONFLICT (source_key) DO UPDATE SET snapshot = EXCLUDED.snapshot, fetched_at = now()`;
  return snapshot;
}

export async function collectNostr(
  source: Source,
  month: string,
  previous: Snapshot | null | undefined,
  bounds: { from: string; to: string },
  dependencies = { discover: discoverOutbox, query: queryRelay },
): Promise<Snapshot> {
  const resuming = !!previous?.pendingRelays?.length;
  if (resuming && previous?.windows?.[0]) bounds = previous.windows[0];
  const outbox = resuming ? null : await dependencies.discover(source.value);
  const tasks: RelayTask[] = resuming
    ? previous!.pendingRelays!
    : outbox!.relays.map((url) => ({
        url,
        filters: [{ authors: [source.value], kinds: [1] }],
        until: Math.floor(Date.parse(bounds.to) / 1000),
      }));
  const events = new Map((previous?.events ?? []).map((event) => [event.id, event]));
  const pendingRelays: RelayTask[] = [];
  let incomplete = resuming ? !!previous?.relayIncomplete : !!outbox?.incomplete;
  const results = await Promise.allSettled(
    tasks.map((task) =>
      dependencies.query(task.url, task.filters, {
        since: Math.floor(Date.parse(bounds.from) / 1000),
        until: task.until,
      }),
    ),
  );
  for (const [index, result] of results.entries()) {
    const task = tasks[index];
    if (result.status === 'rejected') {
      if ((task.failures ?? 0) < 2)
        pendingRelays.push({ ...task, failures: (task.failures ?? 0) + 1 });
      else incomplete = true;
      continue;
    }
    for (const event of result.value.events)
      events.set(event.id, {
        id: event.id,
        timestamp: new Date(event.created_at * 1000).toISOString(),
        type: event.tags.some((tag) => tag[0] === 'e') ? 'reply' : 'post',
        title: event.content.slice(0, 4000),
        url: `https://njump.to/${nip19.noteEncode(event.id)}`,
        actor: source.label,
      });
    if (result.value.nextUntil !== undefined) {
      const failures = result.value.nextUntil < task.until ? 0 : (task.failures ?? 0) + 1;
      if (failures < 3) pendingRelays.push({ ...task, until: result.value.nextUntil, failures });
      else incomplete = true;
    } else if (!result.value.exhaustive) incomplete = true;
  }
  return {
    events: [...events.values()],
    pendingRelays,
    relayIncomplete: incomplete,
    profileUrl: `https://njump.to/${source.label}`,
    coverage: `${month}: signed text notes from NIP-65 write relays and fallback relays, with up to eight advertised write relays per author. Relays can omit history; empty days cannot confirm inactivity. Notes with event references are labeled replies.`,
    windows: [{ ...bounds, exhaustive: !pendingRelays.length && !incomplete, basis: 'relay' }],
  };
}
