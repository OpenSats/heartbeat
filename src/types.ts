import { z } from 'zod';

export const EVENT_TYPES = [
  'commit',
  'pr_opened',
  'pr_merged',
  'pr_closed',
  'issue_opened',
  'issue_closed',
  'release',
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const HostSchema = z.string().min(1);
export type Host = z.infer<typeof HostSchema>;

export const EventSchema = z.object({
  id: z.string(),

  // Host-aware identity fields.
  // `repo` and `actor` stay simple for display/search.
  // `repoKey` and `actorKey` are safe internal keys.
  host: HostSchema,
  repoKey: z.string(),
  repo: z.string(),

  type: EventTypeSchema,
  timestamp: z.string(),

  actorKey: z.string(),
  actor: z.string(),

  title: z.string(),
  url: z.string(),
  shortId: z.string(),
});

export type Event = z.infer<typeof EventSchema>;

export const DatasetSchema = z.object({
  generatedAt: z.string(),
  windowDays: z.number(),
  repos: z.array(z.string()),
  funds: z.record(z.string(), z.array(z.string())).default({}),
  events: z.array(EventSchema),
});

export type Dataset = z.infer<typeof DatasetSchema>;

export const ConfigSchema = z.object({
  fund: z.string().optional(),
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/name"')),
});

export type Config = z.infer<typeof ConfigSchema>;
