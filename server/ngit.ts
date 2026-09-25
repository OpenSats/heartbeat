import { neon } from '@neondatabase/serverless';
import { nip19, type Event, type Filter } from 'nostr-tools';
import {
  NGIT_KINDS,
  NGIT_COMMENT_ROOTS,
  NGIT_TYPES,
  relayUrl,
  repositoryPointer,
} from '../src/pow/ngit.js';
import type { Activity, Source, Snapshot, RelayTask } from '../src/pow/model.js';
import { queryRelay } from './relay.js';
import { recordRelayFetches } from './relay-provenance.js';

const BOOTSTRAP = ['wss://relay.ngit.dev', 'wss://nos.lol', 'wss://relay.damus.io'];
const tag = (event: Event, name: string) => event.tags.find((t) => t[0] === name)?.[1];

export function codeActivity(event: Event, relay?: string): Activity | null {
  if (event.kind === 1111 && !NGIT_COMMENT_ROOTS.includes(tag(event, 'K') ?? '')) return null;
  const type = NGIT_TYPES[event.kind];
  if (!type) return null;
  const coordinate = event.tags.find(
    (t) => ['a', 'A'].includes(t[0]) && /^30617:[a-f0-9]{64}:/.test(t[1] ?? ''),
  )?.[1];
  const ownRepo = [30617, 30618].includes(event.kind) ? tag(event, 'd') : undefined;
  const repo = coordinate ? coordinate.split(':').slice(2).join(':') : ownRepo;
  const subject =
    tag(event, 'subject') ??
    (event.kind === 1617
      ? /^Subject: (.+(?:\n[ \t].+)*)/m.exec(event.content)?.[1]?.replace(/\n\s+/g, ' ')
      : undefined);
  const title =
    subject ||
    (event.kind === 30617
      ? tag(event, 'name') || ownRepo
      : event.kind === 30618
        ? `Updated refs for ${ownRepo ?? 'repository'}`
        : event.content.split('\n').find(Boolean)) ||
    type;
  return {
    id: event.id,
    timestamp: new Date(event.created_at * 1000).toISOString(),
    type,
    title: title.slice(0, 1000),
    actor: nip19.npubEncode(event.pubkey),
    repo,
    url: `https://njump.to/${nip19.neventEncode({ id: event.id, author: event.pubkey, kind: event.kind, relays: relay ? [relay] : [] })}`,
  };
}

async function discover(source: Source): Promise<string[]> {
  const pointer = source.kind === 'grasp' ? repositoryPointer(source.value) : null;
  const author = pointer?.pubkey ?? source.value;
  const hints = pointer?.relays ?? [];
  // Discovery belongs to this source only. It never stores another account alongside it.
  const key = `${source.key}:discovery:v1`;
  const sql = neon(process.env.DATABASE_URL!);
  const [cached] =
    await sql`SELECT snapshot FROM pow_sources WHERE source_key = ${key} AND fetched_at > now() - interval '24 hours'`;
  if (cached) return [...new Set([...hints, ...cached.snapshot.relays])].slice(0, 6);
  const filters: Filter[] = pointer
    ? [
        { authors: [author], kinds: [30617], '#d': [pointer.identifier] },
        { authors: [author], kinds: [10317] },
      ]
    : [{ authors: [author], kinds: [10317, 10002, 30617] }];
  const results = await Promise.allSettled(
    [...new Set([...hints, ...BOOTSTRAP])]
      .slice(0, 5)
      .map((url) => queryRelay(url, filters, { once: true, timeout: 7000 })),
  );
  const latest = new Map<string, Event>();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const event of result.value.events) {
      const key = `${event.kind}:${tag(event, 'd') ?? ''}`;
      if ((latest.get(key)?.created_at ?? -1) < event.created_at) latest.set(key, event);
    }
  }
  const advertised: string[] = [];
  // Prefer GRASP servers and repository relays before general outbox relays.
  for (const event of [...latest.values()].sort((a, b) => b.kind - a.kind)) {
    for (const t of event.tags) {
      const urls =
        t[0] === 'relays'
          ? t.slice(1)
          : t[0] === 'g' || (event.kind === 10002 && t[0] === 'r' && t[2] !== 'read')
            ? [t[1]]
            : [];
      for (const url of urls)
        try {
          advertised.push(relayUrl(url));
        } catch {
          /* Skip unusable hints. */
        }
    }
  }
  const relays = [...new Set([...hints, ...advertised.slice(0, 3), ...BOOTSTRAP])].slice(0, 6);
  if (results.some((r) => r.status === 'fulfilled'))
    await sql`INSERT INTO pow_sources (source_key, snapshot, fetched_at) VALUES (${key}, ${JSON.stringify({ relays })}::jsonb, now())
      ON CONFLICT (source_key) DO UPDATE SET snapshot = EXCLUDED.snapshot, fetched_at = now()`;
  return relays;
}

export async function collectNgit(
  source: Source,
  month: string,
  previous: Snapshot | null | undefined,
  bounds: { from: string; to: string },
): Promise<Snapshot> {
  const pointer = source.kind === 'grasp' ? repositoryPointer(source.value) : null;
  const coordinate = pointer ? `30617:${pointer.pubkey}:${pointer.identifier}` : null;
  const filters: Filter[] = pointer
    ? [
        { kinds: NGIT_KINDS, '#a': [coordinate!] },
        { kinds: [1111], '#A': [coordinate!] },
        { kinds: [30617, 30618], authors: [pointer.pubkey], '#d': [pointer.identifier] },
      ]
    : [
        { kinds: NGIT_KINDS, authors: [source.value] },
        { kinds: [1111], authors: [source.value], '#K': NGIT_COMMENT_ROOTS },
      ];
  const resuming = !!previous?.pendingRelays?.length;
  if (resuming) bounds = previous!.windows![0];
  const tasks: RelayTask[] = resuming
    ? previous!.pendingRelays!
    : (await discover(source)).map((url) => ({
        url,
        filters,
        until: Math.floor(Date.parse(bounds.to) / 1000),
      }));
  // Keep observed signed events when a relay later omits or replaces them.
  const events = new Map((previous?.events ?? []).map((event) => [event.id, event]));
  const pendingRelays: RelayTask[] = [];
  let incomplete = resuming && !!previous?.relayIncomplete;
  const results = await Promise.allSettled(
    tasks.map((task) =>
      queryRelay(task.url, task.filters, {
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
    for (const event of result.value.events) {
      const activity = codeActivity(event, task.url);
      if (activity) events.set(activity.id, activity);
    }
    if (result.value.nextUntil !== undefined) {
      const failures = result.value.nextUntil < task.until ? 0 : (task.failures ?? 0) + 1;
      if (failures < 3) pendingRelays.push({ ...task, until: result.value.nextUntil, failures });
      else incomplete = true;
    } else if (!result.value.exhaustive) incomplete = true;
  }
  return {
    events: [...events.values()],
    pendingRelays,
    relayFetches: recordRelayFetches(previous?.relayFetches ?? [], tasks, results),
    relayIncomplete: incomplete,
    profileUrl: pointer ? `https://njump.to/${source.value}` : `https://njump.to/${source.label}`,
    coverage: `${month}: signed NIP-34 patches, PRs, issues, status messages, comments and repository updates.${pointer ? ' Repository context includes all contributors; comments and status events without a repository tag may be missing.' : ''} Ref updates are not individual commits. Relays can omit history and replace older repository state.`,
    windows: [{ ...bounds, exhaustive: !pendingRelays.length && !incomplete, basis: 'relay' }],
  };
}
