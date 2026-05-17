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

// Repo entry grammar:
//   "owner/name"                          -> implicit GitHub
//   "host:owner/name"                     -> Forgejo/Codeberg/Gitea (exactly 2 segments)
//   "gitlab:group/project"                -> GitLab simple project
//   "gitlab:group/subgroup/.../project"   -> GitLab nested namespace (2+ segments)
//   "git:https://host/path/to/repo"       -> Plain Git URL (https only, commits-only)
//   "git:https://host/path/to/repo.git"   -> Plain Git URL with .git suffix (normalized away)
//   "nostr:naddr1..."                     -> NIP-34 Nostr-native repo (bech32 naddr payload)
// "github:" as an explicit prefix is rejected; GitHub entries must use the
// bare "owner/name" form. Only "gitlab:" entries may have more than two
// slash-separated segments after the prefix. Plain-Git entries must start
// with "git:https://" and contain at least one path segment after the host.
// Nostr entries must be a "nostr:" prefix followed by a NIP-19 naddr1 string
// (lowercase bech32 alphabet, no separators). YAML requires quoting these
// values because the embedded colon is otherwise ambiguous.
export const ConfigSchema = z.object({
  fund: z.string().optional(),
  repos: z.array(
    z.string().regex(
      /^(?:[^/\s:]+\/[^/\s:]+|gitlab:[^/\s:]+(?:\/[^/\s:]+)+|git:https:\/\/[^/\s:?#@]+(?:\/[^/\s?#]+)+(?:\.git)?\/?|nostr:naddr1[a-z0-9]+|(?!(?:github|gitlab|git|nostr):)[a-z0-9]+:[^/\s:]+\/[^/\s:]+)$/,
      'expected "owner/name", "gitlab:group/project", "gitlab:group/subgroup/project", "host:owner/name", "git:https://host/path/to/repo", or "nostr:naddr1..."',
    ),
  ),
});

export type Config = z.infer<typeof ConfigSchema>;

// Schema for the optional `instances.yml` file at the project root, used to
// register self-hosted Forgejo/Gitea instances. Each top-level key is the
// host label that will appear as a prefix in repos.*.yml entries (e.g.
// `mygitea:owner/repo`).
//
// `tokenEnv` should name a dedicated environment variable holding an API
// token for that instance. If unset, requests are made unauthenticated.
export const InstanceSchema = z.object({
  baseUrl: z.string().url(),
  tokenEnv: z.string().optional(),
});

export const InstancesSchema = z.record(
  z.string().regex(/^[a-z0-9]+$/, 'host label must be lowercase alphanumeric'),
  InstanceSchema,
);

export type Instance = z.infer<typeof InstanceSchema>;
export type Instances = z.infer<typeof InstancesSchema>;
