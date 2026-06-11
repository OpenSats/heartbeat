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

export const EventSchema = z.object({
  id: z.string(),
  repo: z.string(),
  type: EventTypeSchema,
  timestamp: z.string(),
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

const GitHubRepoSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/name"');

const GitLabRepoSchema = z.object({
  provider: z.literal('gitlab'),
  repo: z.string().regex(/^[^/\s]+(?:\/[^/\s]+)+$/, 'expected "group/project" or subgroup path'),
  host: z
    .string()
    .regex(/^[^/\s]+$/, 'expected a bare host like "gitlab.com"')
    .optional(),
});

export const RepoConfigEntrySchema = z.union([GitHubRepoSchema, GitLabRepoSchema]);
export type RepoConfigEntry = z.infer<typeof RepoConfigEntrySchema>;

export const ConfigSchema = z.object({
  fund: z.string().optional(),
  repos: z.array(RepoConfigEntrySchema),
});
export type Config = z.infer<typeof ConfigSchema>;
