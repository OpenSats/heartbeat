import { collectNgit } from './ngit.js';
import { collectGithub } from './github.js';
import { collectNostr } from './nostr.js';
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
export async function collect(
  source: Source,
  month: string,
  previous?: Snapshot | null,
): Promise<Snapshot> {
  const bounds = monthBounds(month);
  if (source.kind === 'ngit' || source.kind === 'grasp')
    return collectNgit(source, month, previous, bounds);
  if (source.kind === 'nostr') return collectNostr(source, month, previous, bounds);
  return collectGithub(source, bounds, previous);
}
