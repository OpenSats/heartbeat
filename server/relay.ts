import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import WebSocket from 'ws';
import { matchFilters, verifyEvent, type Event, type Filter } from 'nostr-tools';
import { relayUrl } from '../src/pow/ngit.js';

export function publicAddress(address: string) {
  return ipaddr.process(address).range() === 'unicast';
}

async function connect(url: string) {
  const normalized = relayUrl(url);
  const hostname = new URL(normalized).hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Relay DNS timed out.')), 4000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw new Error('Relay must resolve to public addresses.');
  const { address, family } = addresses[0];
  // Pin the checked address so a second DNS lookup cannot redirect into a private network.
  return new WebSocket(normalized, {
    maxPayload: 256 * 1024,
    handshakeTimeout: 5000,
    followRedirects: false,
    lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    },
  });
}

type Page = { events: Event[]; exhaustive: boolean; nextUntil?: number };
export async function queryRelay(
  url: string,
  filters: Filter[],
  options: {
    since?: number;
    until?: number;
    once?: boolean;
    timeout?: number;
  } = {},
): Promise<Page> {
  const ws = await connect(url);
  return new Promise((resolve, reject) => {
    let until = options.until ?? Math.floor(Date.now() / 1000);
    const events = new Map<string, Event>();
    let batch = new Map<string, Event>();
    let subscription = '';
    let pages = 0;
    let finished = false;
    let requested: Filter[] = [];
    const finish = (exhaustive: boolean, nextUntil?: number, error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.terminate();
      if (error && !events.size) reject(new Error(error));
      else resolve({ events: [...events.values()], exhaustive, nextUntil });
    };
    const timer = setTimeout(
      () => finish(false, until, 'Relay timed out.'),
      options.timeout ?? 14000,
    );
    const request = () => {
      batch = new Map();
      subscription = `pow-code-${++pages}`;
      requested = filters.map((filter) => ({
        ...filter,
        ...(options.since === undefined ? {} : { since: options.since }),
        until,
        limit: 200,
      }));
      ws.send(JSON.stringify(['REQ', subscription, ...requested]));
    };
    ws.on('open', request);
    ws.on('error', () => finish(false, until, 'Relay unavailable.'));
    ws.on('close', () => finish(false, until, 'Relay closed before completing the request.'));
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message[1] !== subscription) return;
        if (message[0] === 'CLOSED') return finish(false, until, 'Relay refused the request.');
        if (message[0] === 'EVENT' && batch.size < 200 * filters.length) {
          const event = message[2] as Event;
          if (matchFilters(requested, event) && verifyEvent(event)) {
            batch.set(event.id, event);
            events.set(event.id, event);
          }
        }
        if (message[0] !== 'EOSE') return;
        ws.send(JSON.stringify(['CLOSE', subscription]));
        if (options.once || !batch.size) return finish(true);
        const oldest = Math.min(...[...batch.values()].map((event) => event.created_at));
        // A full same-second page cannot be safely paginated using an until cursor.
        if (oldest === until && batch.size >= 200) return finish(false);
        until = oldest === until ? oldest - 1 : oldest;
        if (until < (options.since ?? 0)) return finish(true);
        if (pages >= 4) return finish(false, until);
        request();
      } catch {
        /* Ignore malformed or invalid events from relays. */
      }
    });
  });
}
