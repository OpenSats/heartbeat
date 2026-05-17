import { SimplePool } from 'nostr-tools/pool';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import { type Filter } from 'nostr-tools/filter';
import * as nip19 from 'nostr-tools/nip19';

import type { Event, EventType } from '../../src/types';

export const NOSTR_HOST = 'nostr';

// Bootstrap relays: used to find the kind:30617 repo announcement when the
// naddr's embedded relay hints are empty or unreachable. These are large,
// public, free relays that reliably hold most repo announcements.
const BOOTSTRAP_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

// Per-relay timeout for any single query. Nostr relays are usually fast but
// can stall; we'd rather move on than block the whole fetch.
const RELAY_TIMEOUT_MS = 15_000;

// NIP-34 event kinds we care about.
const KIND_REPO_ANNOUNCE = 30617;
const KIND_PATCH = 1617;
const KIND_PULL_REQUEST = 1618;
const KIND_ISSUE = 1621;
const KIND_PROFILE_METADATA = 0;
// Status events: 1630=Open, 1631=Applied/Merged, 1632=Closed, 1633=Draft.
// We only act on Applied (-> pr_merged) and Closed (-> pr_closed / issue_closed).
const KIND_STATUS_APPLIED = 1631;
const KIND_STATUS_CLOSED = 1632;
const STATUS_KINDS = [1630, KIND_STATUS_APPLIED, KIND_STATUS_CLOSED, 1633];

// Repo state events (kind 30618) are intentionally not consumed in v1.
// They carry ref-tip pointers, not actual commit timestamps, so synthesizing
// "commit" events from them would be lossy. Anyone wanting Nostr-repo commits
// can add a paired git: entry with the clone URL from the 30617 announcement.

export type NostrFetchResult = {
  events: Event[];
  ok: boolean;
  reason?: string;
};

type RepoCoords = {
  naddr: string; // original input
  pubkey: string; // hex, lowercase, 64 chars
  identifier: string; // d-tag value, the repo-id
  relayHints: string[]; // relays embedded in the naddr (may be empty)
};

type RepoMetadata = {
  name: string; // from "name" tag, fallback to identifier
  declaredRelays: string[]; // from "relays" tag in 30617
};

// --- naddr parsing ----------------------------------------------------------

export function parseNostrEntry(raw: string): RepoCoords | null {
  // Accept "nostr:naddr1..." config syntax.
  if (!raw.startsWith('nostr:')) return null;
  const body = raw.slice('nostr:'.length).trim();
  if (!body.startsWith('naddr1')) return null;

  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(body);
  } catch (err) {
    throw new Error(`Invalid naddr: ${(err as Error).message}`);
  }

  if (decoded.type !== 'naddr') {
    throw new Error(`Expected naddr, got ${decoded.type}`);
  }

  const { pubkey, identifier, kind, relays } = decoded.data;

  if (kind !== KIND_REPO_ANNOUNCE) {
    throw new Error(
      `naddr points at kind ${kind}, expected ${KIND_REPO_ANNOUNCE} (NIP-34 repo announcement)`,
    );
  }

  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error(`naddr pubkey is not 64-char lowercase hex: ${pubkey}`);
  }

  if (!identifier) {
    throw new Error('naddr has empty identifier (d-tag)');
  }

  return {
    naddr: body,
    pubkey,
    identifier,
    relayHints: (relays ?? []).filter((r) => r.startsWith('wss://') || r.startsWith('ws://')),
  };
}

// --- relay queries ----------------------------------------------------------

async function querySync(
  pool: SimplePool,
  relays: string[],
  filter: Filter,
): Promise<NostrEvent[]> {
  if (relays.length === 0) return [];
  try {
    return await pool.querySync(relays, filter, { maxWait: RELAY_TIMEOUT_MS });
  } catch {
    return [];
  }
}

// Dedup by Nostr event id (32-byte hash, same event will be byte-identical
// from any relay). Verifies signatures and drops anything that doesn't match
// the claimed pubkey.
function dedupAndVerify(events: NostrEvent[]): NostrEvent[] {
  const seen = new Map<string, NostrEvent>();
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    if (!verifyEvent(ev)) continue;
    seen.set(ev.id, ev);
  }
  return [...seen.values()];
}

async function fetchRepoAnnouncement(
  pool: SimplePool,
  coords: RepoCoords,
): Promise<NostrEvent | null> {
  const tryRelays = [...new Set([...coords.relayHints, ...BOOTSTRAP_RELAYS])];

  const events = await querySync(pool, tryRelays, {
    kinds: [KIND_REPO_ANNOUNCE],
    authors: [coords.pubkey],
    '#d': [coords.identifier],
    limit: 5,
  });

  const verified = dedupAndVerify(events);
  if (verified.length === 0) return null;

  // 30617 is addressable; the latest by created_at wins.
  verified.sort((a, b) => b.created_at - a.created_at);
  return verified[0];
}

function tagValue(ev: NostrEvent, name: string): string | undefined {
  const t = ev.tags.find((x: string[]) => x[0] === name);
  return t?.[1];
}

function tagValues(ev: NostrEvent, name: string): string[] {
  return ev.tags
    .filter((x: string[]) => x[0] === name)
    .map((x: string[]) => x[1])
    .filter((v): v is string => Boolean(v));
}

function extractRepoMetadata(announcement: NostrEvent, fallbackId: string): RepoMetadata {
  const declaredRelays = tagValues(announcement, 'relays').filter(
    (r) => r.startsWith('wss://') || r.startsWith('ws://'),
  );
  return {
    name: tagValue(announcement, 'name') ?? fallbackId,
    declaredRelays,
  };
}

async function fetchActorMetadata(
  pool: SimplePool,
  relays: string[],
  pubkeys: string[],
): Promise<Map<string, string>> {
  // pubkey hex -> display name. Falls back to short npub on miss in the caller.
  const result = new Map<string, string>();
  if (pubkeys.length === 0) return result;

  const events = await querySync(pool, relays, {
    kinds: [KIND_PROFILE_METADATA],
    authors: pubkeys,
  });

  const verified = dedupAndVerify(events);
  // Most recent kind:0 per pubkey wins.
  const latest = new Map<string, NostrEvent>();
  for (const ev of verified) {
    const prior = latest.get(ev.pubkey);
    if (!prior || ev.created_at > prior.created_at) latest.set(ev.pubkey, ev);
  }

  for (const [pubkey, ev] of latest) {
    try {
      const meta = JSON.parse(ev.content) as { name?: string; display_name?: string };
      const name = (meta.display_name?.trim() || meta.name?.trim()) ?? '';
      if (name) result.set(pubkey, name);
    } catch {
      // ignore malformed metadata
    }
  }

  return result;
}

// --- event shaping ----------------------------------------------------------

function shortNpub(pubkey: string): string {
  try {
    const npub = nip19.npubEncode(pubkey);
    return `${npub.slice(0, 12)}…${npub.slice(-8)}`;
  } catch {
    return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
  }
}

function npubFull(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function gitworkshopUrl(pubkey: string, identifier: string): string {
  return `https://gitworkshop.dev/${npubFull(pubkey)}/${identifier}`;
}

function shortEventId(id: string): string {
  return id.slice(0, 8);
}

function aTagPointsAt(ev: NostrEvent, coords: RepoCoords): boolean {
  // "a" tag format: "30617:<pubkey>:<d-tag>"
  const aTags = tagValues(ev, 'a');
  const target = `${KIND_REPO_ANNOUNCE}:${coords.pubkey}:${coords.identifier}`;
  return aTags.some((v) => v === target);
}

function repoKey(coords: RepoCoords): string {
  return `${NOSTR_HOST}:${coords.pubkey}:${coords.identifier}`;
}

function actorKey(pubkey: string): string {
  return `${NOSTR_HOST}:${pubkey}`;
}

type ShapingContext = {
  coords: RepoCoords;
  repoDisplay: string;
  nameByPubkey: Map<string, string>;
};

function actorName(pubkey: string, ctx: ShapingContext): string {
  return ctx.nameByPubkey.get(pubkey) ?? shortNpub(pubkey);
}

function eventTitle(ev: NostrEvent, fallback: string): string {
  const subject = tagValue(ev, 'subject');
  if (subject) return subject;
  // Patches typically don't have a subject tag; their content is the patch
  // diff. Take the first non-empty line of content as a headline.
  const firstLine = ev.content
    .split('\n')
    .map((s: string) => s.trim())
    .find((s: string) => s.length > 0 && !s.startsWith('From ') && !s.startsWith('---'));
  return firstLine?.slice(0, 200) ?? fallback;
}

function makeBaseEvent(
  ev: NostrEvent,
  ctx: ShapingContext,
  type: EventType,
  fallbackTitle: string,
): Event {
  return {
    id: `${repoKey(ctx.coords)}:${type}:${ev.id}`,
    repo: ctx.repoDisplay,
    repoKey: repoKey(ctx.coords),
    host: NOSTR_HOST,
    type,
    timestamp: isoFromUnix(ev.created_at),
    actor: actorName(ev.pubkey, ctx),
    actorKey: actorKey(ev.pubkey),
    title: eventTitle(ev, fallbackTitle),
    url: gitworkshopUrl(ctx.coords.pubkey, ctx.coords.identifier),
    shortId: shortEventId(ev.id),
  };
}

// Index status events by the e-tag of the patch/issue they reference. Pick
// the most recent status per parent that comes from either the parent's
// author or the repo maintainer (the announcement's pubkey).
type StatusIndex = Map<string, NostrEvent>; // parent event id -> latest status event

function buildStatusIndex(
  statusEvents: NostrEvent[],
  coords: RepoCoords,
  parentAuthors: Map<string, string>, // parent event id -> author pubkey
): StatusIndex {
  const out: StatusIndex = new Map();
  for (const status of statusEvents) {
    if (!aTagPointsAt(status, coords)) continue;
    const targetIds = tagValues(status, 'e');
    for (const parentId of targetIds) {
      const parentAuthor = parentAuthors.get(parentId);
      // Only the parent's author or the repo maintainer (announcement pubkey)
      // can authoritatively change status.
      if (status.pubkey !== parentAuthor && status.pubkey !== coords.pubkey) continue;
      const prior = out.get(parentId);
      if (!prior || status.created_at > prior.created_at) out.set(parentId, status);
    }
  }
  return out;
}

function statusToCloseEventType(
  statusKind: number,
  parentKind: number,
): EventType | null {
  // Issue (1621) closures map to issue_closed.
  if (parentKind === KIND_ISSUE) {
    if (statusKind === KIND_STATUS_CLOSED) return 'issue_closed';
    return null; // open/applied/draft don't apply to issues meaningfully
  }
  // Patches (1617) / PRs (1618): applied -> pr_merged, closed -> pr_closed.
  if (statusKind === KIND_STATUS_APPLIED) return 'pr_merged';
  if (statusKind === KIND_STATUS_CLOSED) return 'pr_closed';
  return null;
}

function shapePatchOrPr(
  ev: NostrEvent,
  ctx: ShapingContext,
  statusIndex: StatusIndex,
): Event[] {
  const events: Event[] = [makeBaseEvent(ev, ctx, 'pr_opened', 'patch')];
  const status = statusIndex.get(ev.id);
  if (status) {
    const closeType = statusToCloseEventType(status.kind, ev.kind);
    if (closeType) {
      events.push({
        ...makeBaseEvent(status, ctx, closeType, eventTitle(ev, 'patch')),
        // Keep the title and url tied to the parent patch/PR, not the status event.
        title: eventTitle(ev, 'patch'),
        url: gitworkshopUrl(ctx.coords.pubkey, ctx.coords.identifier),
      });
    }
  }
  return events;
}

function shapeIssue(
  ev: NostrEvent,
  ctx: ShapingContext,
  statusIndex: StatusIndex,
): Event[] {
  const events: Event[] = [makeBaseEvent(ev, ctx, 'issue_opened', 'issue')];
  const status = statusIndex.get(ev.id);
  if (status) {
    const closeType = statusToCloseEventType(status.kind, ev.kind);
    if (closeType) {
      events.push({
        ...makeBaseEvent(status, ctx, closeType, eventTitle(ev, 'issue')),
        title: eventTitle(ev, 'issue'),
      });
    }
  }
  return events;
}

// --- public entry point -----------------------------------------------------

export async function fetchNostrRepo(
  naddrEntry: string,
  cutoffMs: number,
): Promise<NostrFetchResult> {
  let coords: RepoCoords | null;
  try {
    coords = parseNostrEntry(naddrEntry);
  } catch (err) {
    return { events: [], ok: false, reason: (err as Error).message };
  }
  if (!coords) {
    return { events: [], ok: false, reason: 'entry did not parse as nostr:naddr1...' };
  }

  const pool = new SimplePool();
  const usedRelays = new Set<string>(BOOTSTRAP_RELAYS);

  try {
    const announcement = await fetchRepoAnnouncement(pool, coords);
    if (!announcement) {
      return {
        events: [],
        ok: false,
        reason: `no kind:30617 announcement found for ${coords.pubkey}:${coords.identifier}`,
      };
    }

    const meta = extractRepoMetadata(announcement, coords.identifier);

    // Activity queries go to the maintainer-declared relays, falling back to
    // the naddr hints and then bootstrap if neither yields anything.
    const activityRelays = [
      ...new Set([
        ...meta.declaredRelays,
        ...coords.relayHints,
        ...BOOTSTRAP_RELAYS,
      ]),
    ];
    for (const r of activityRelays) usedRelays.add(r);

    const sinceUnix = Math.floor(cutoffMs / 1000);

    // Patches, PRs, and issues are all addressable via "a" tag pointing at the
    // 30617. We query them in parallel; relays may not honor `since`, so we
    // filter again client-side later.
    const aTagFilter: Filter = {
      '#a': [`${KIND_REPO_ANNOUNCE}:${coords.pubkey}:${coords.identifier}`],
      since: sinceUnix,
    };

    const [patches, prs, issues, statuses] = await Promise.all([
      querySync(pool, activityRelays, { ...aTagFilter, kinds: [KIND_PATCH] }),
      querySync(pool, activityRelays, { ...aTagFilter, kinds: [KIND_PULL_REQUEST] }),
      querySync(pool, activityRelays, { ...aTagFilter, kinds: [KIND_ISSUE] }),
      // Status events: do NOT apply `since`. A merge in-window for an
      // out-of-window patch is still relevant — but for v1 we only emit
      // close events tied to patches/issues we actually returned. So we
      // filter status events to those referencing one of our in-window
      // parents after the fact.
      querySync(pool, activityRelays, {
        '#a': [`${KIND_REPO_ANNOUNCE}:${coords.pubkey}:${coords.identifier}`],
        kinds: STATUS_KINDS,
      }),
    ]);

    const verifiedPatches = dedupAndVerify(patches);
    const verifiedPrs = dedupAndVerify(prs);
    const verifiedIssues = dedupAndVerify(issues);
    const verifiedStatuses = dedupAndVerify(statuses);

    // Collect pubkeys for actor-name lookup.
    const allPubkeys = new Set<string>();
    allPubkeys.add(coords.pubkey);
    for (const ev of [
      ...verifiedPatches,
      ...verifiedPrs,
      ...verifiedIssues,
      ...verifiedStatuses,
    ]) {
      allPubkeys.add(ev.pubkey);
    }

    const metadataRelays = [...new Set([...meta.declaredRelays, ...BOOTSTRAP_RELAYS])];
    for (const r of metadataRelays) usedRelays.add(r);

    const nameByPubkey = await fetchActorMetadata(pool, metadataRelays, [...allPubkeys]);

    const ctx: ShapingContext = {
      coords,
      repoDisplay: meta.name,
      nameByPubkey,
    };

    // Build parent-author map for status authorization.
    const parentAuthors = new Map<string, string>();
    for (const ev of [...verifiedPatches, ...verifiedPrs, ...verifiedIssues]) {
      parentAuthors.set(ev.id, ev.pubkey);
    }
    const statusIndex = buildStatusIndex(verifiedStatuses, coords, parentAuthors);

    const out: Event[] = [
      ...verifiedPatches.flatMap((ev) => shapePatchOrPr(ev, ctx, statusIndex)),
      ...verifiedPrs.flatMap((ev) => shapePatchOrPr(ev, ctx, statusIndex)),
      ...verifiedIssues.flatMap((ev) => shapeIssue(ev, ctx, statusIndex)),
    ];

    return { events: out, ok: true };
  } catch (err) {
    return { events: [], ok: false, reason: `nostr fetch failed: ${(err as Error).message}` };
  } finally {
    // SimplePool keeps WebSocket connections open across queries. Close them
    // so the process can exit cleanly when fetch.ts finishes.
    pool.close([...usedRelays]);
  }
}
