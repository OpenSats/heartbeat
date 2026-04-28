import type { EventType } from './types';

export type EventTypeMeta = {
  label: string;
  sigil: string;
  colorClass: string;
};

export const EVENT_TYPE_META: Record<EventType, EventTypeMeta> = {
  commit: {
    label: 'commit',
    sigil: '*',
    colorClass: 'text-zinc-300',
  },
  pr_opened: {
    label: 'PR opened',
    sigil: '>',
    colorClass: 'text-sky-400',
  },
  pr_merged: {
    label: 'PR merged',
    sigil: '@',
    colorClass: 'text-violet-400',
  },
  pr_closed: {
    label: 'PR closed',
    sigil: 'x',
    colorClass: 'text-zinc-500',
  },
  issue_opened: {
    label: 'issue opened',
    sigil: '!',
    colorClass: 'text-amber-400',
  },
  issue_closed: {
    label: 'issue closed',
    sigil: '~',
    colorClass: 'text-emerald-400',
  },
  release: {
    label: 'release',
    sigil: '#',
    colorClass: 'text-yellow-400',
  },
};
