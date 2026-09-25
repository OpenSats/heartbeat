import WebSocket from 'ws';
import { collectNgit } from './ngit.js';
import { collectGithub } from './github.js';
import { nip19, verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import type { Snapshot, Source } from '../src/pow/model.js';

export function monthBounds(month: string) {
  const from = new Date(`${month}-01T00:00:00Z`);
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return {
    from: from.toISOString(),
    to: new Date(Math.min(next.getTime() - 1, Date.now())).toISOString(),
  };
}
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
function relayEvents(
  url: string,
  author: string,
  month: string,
): Promise<{ events: NostrEvent[]; exhaustive: boolean }> {
  return new Promise((resolve, reject) => {
    const bounds = monthBounds(month);
    const since = Math.floor(Date.parse(bounds.from) / 1000);
    let until = Math.floor(Date.parse(bounds.to) / 1000);
    const events = new Map<string, NostrEvent>();
    let batch: NostrEvent[] = [];
    let pages = 0;
    let subscription = '';
    const ws = new WebSocket(url, { maxPayload: 128 * 1024, handshakeTimeout: 8000 });
    let finished = false;
    const finish = (exhaustive: boolean, error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.terminate();
      if (error && !events.size) reject(new Error(error));
      else resolve({ events: [...events.values()], exhaustive });
    };
    const timer = setTimeout(() => finish(false, 'Relay timed out'), 35000);
    const request = () => {
      batch = [];
      subscription = `pow-${++pages}`;
      ws.send(
        JSON.stringify([
          'REQ',
          subscription,
          { authors: [author], kinds: [1], since, until, limit: 200 },
        ]),
      );
    };
    ws.on('open', request);
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message[1] !== subscription) return;
        if (message[0] === 'CLOSED') {
          finish(false, 'Relay refused request');
          return;
        }
        if (message[0] === 'EOSE') {
          ws.send(JSON.stringify(['CLOSE', subscription]));
          // Continue even below the requested limit: relays may impose lower caps.
          if (!batch.length) {
            finish(true);
            return;
          }
          const oldest = Math.min(...batch.map((e) => e.created_at));
          if (pages >= 30 || (oldest >= until && batch.length >= 200)) {
            finish(false);
            return;
          }
          until = oldest === until ? oldest - 1 : oldest;
          if (until < since) {
            finish(true);
            return;
          }
          request();
          return;
        }
        if (message[0] === 'EVENT' && batch.length < 200) {
          const e = message[2] as NostrEvent;
          if (
            e.pubkey === author &&
            e.kind === 1 &&
            e.created_at >= since &&
            e.created_at <= until &&
            verifyEvent(e)
          ) {
            batch.push(e);
            events.set(e.id, e);
          }
        }
      } catch {
        /* Ignore invalid protocol events. */
      }
    });
    ws.on('error', () => finish(false, 'Relay unavailable'));
    ws.on('close', () => finish(false, 'Relay closed before completing request'));
  });
}
export async function collect(
  source: Source,
  month: string,
  previous?: Snapshot | null,
): Promise<Snapshot> {
  if (source.kind === 'ngit' || source.kind === 'grasp')
    return collectNgit(source, month, previous, monthBounds(month));
  if (source.kind !== 'nostr') return collectGithub(source, monthBounds(month), previous);
  const results = await Promise.allSettled(
    RELAYS.map((url) => relayEvents(url, source.value, month)),
  );
  const successful = results.filter((r) => r.status === 'fulfilled');
  if (!successful.length) throw new Error('Nostr relays unavailable; cached history is retained.');
  const events = new Map<string, NostrEvent>();
  for (const result of successful) for (const e of result.value.events) events.set(e.id, e);
  return {
    events: [...events.values()].map((e) => ({
      id: e.id,
      timestamp: new Date(e.created_at * 1000).toISOString(),
      type: e.tags.some((t) => t[0] === 'e') ? 'reply' : 'post',
      title: e.content.slice(0, 4000),
      url: `https://njump.to/${nip19.noteEncode(e.id)}`,
      actor: source.label,
    })),
    profileUrl: `https://njump.to/${source.label}`,
    coverage: `${month}: paginated text notes from ${successful.length}/${RELAYS.length} relays. Relays can omit history; empty days cannot confirm inactivity. Notes with event references are labeled replies.`,
    windows: [
      {
        ...monthBounds(month),
        exhaustive: results.every((r) => r.status === 'fulfilled' && r.value.exhaustive),
        basis: 'relay',
      },
    ],
  };
}
