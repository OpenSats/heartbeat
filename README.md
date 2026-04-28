# heartbeat

A static, single-page activity dashboard for a set of GitHub repositories. It
renders commits, pull requests, issues, and releases as a unified
`git log --oneline`-style timeline.

No backend, no database. A scheduled GitHub Action queries the GitHub GraphQL
API at build time and bakes the results into a static JSON file that ships
with the site.

## How it works

```
repos.yml -> scripts/fetch.ts -> public/data/events.json -> Vite build -> GitHub Pages
                  (Action cron)
```

- `repos.yml` lists the repos you want to track.
- `scripts/fetch.ts` runs in CI, queries one GraphQL request per repo, and
  normalizes commits / PRs / issues / releases into a flat `Event[]`.
- The React app (`src/`) loads that JSON and renders it.

The browser never talks to GitHub directly, so visitors don't consume any
rate-limit budget and no token ever ships to the client.

## Local development

Requirements: Node 22+.

```bash
npm install

export GITHUB_TOKEN=ghp_yourtoken   # any classic or fine-grained PAT works
npm run fetch                       # populates public/data/events.json
npm run dev                         # http://localhost:5173
```

A PAT with no extra scopes is enough for public repos. For private repos,
grant the `repo` scope.

Other scripts:

- `npm run build` - production build into `dist/`
- `npm run preview` - serve the built site locally
- `npm run typecheck` - TypeScript only

## Configuration

Edit `repos.yml`:

```yaml
repos:
  - owner/repo-1
  - owner/repo-2
```

The fetcher is configured at the top of `scripts/fetch.ts`:

| Constant            | Default | Meaning                              |
| ------------------- | ------- | ------------------------------------ |
| `WINDOW_DAYS`       | 90      | Discard events older than this.      |
| `COMMITS_PER_REPO`  | 100     | Latest commits on the default branch |
| `PRS_PER_REPO`      | 50      | Latest PRs by `updatedAt`            |
| `ISSUES_PER_REPO`   | 50      | Latest issues by `updatedAt`         |
| `RELEASES_PER_REPO` | 20      | Latest releases by `createdAt`       |

## Deploying to Vercel

1. Import the repo into Vercel. Framework preset: **Vite** (auto-detected).
2. Add an environment variable `GITHUB_TOKEN` with a PAT that can read your
   tracked repos (no extra scopes needed for public-only).
3. Deploy. Vercel runs the `vercel-build` script
   (`npm run fetch && npm run build`), so the JSON is generated fresh in
   each build.

Vercel rebuilds automatically on every push to `master`. For periodic
refreshes without code changes, create a *Deploy Hook* in *Project
Settings > Git*, save its URL as a `VERCEL_DEPLOY_HOOK_URL` repo secret,
and the included [`refresh.yml`](.github/workflows/refresh.yml) workflow
will `POST` to it every 6 hours.

## Adding a new event type

The data shape is the single source of truth, so adding a type touches three
small files:

1. Add the new variant to `EVENT_TYPES` in [`src/types.ts`](src/types.ts).
2. Add a metadata entry to `EVENT_TYPE_META` in
   [`src/eventTypes.ts`](src/eventTypes.ts) (label, sigil, Tailwind color).
3. In [`scripts/fetch.ts`](scripts/fetch.ts), extend the GraphQL query and
   add a mapper that emits an `Event` with the new `type`.

The UI picks up the new type automatically.

## Layout

```
heartbeat/
  repos.yml                       # tracked repos
  scripts/fetch.ts                # build-time fetcher
  src/
    types.ts                      # Event + Dataset zod schemas
    eventTypes.ts                 # per-type label/sigil/color
    App.tsx
    components/
      Timeline.tsx
      EventRow.tsx
      FilterBar.tsx
    lib/
      loadEvents.ts
      useUrlSet.ts
  public/data/events.json         # generated; placeholder committed
  .github/workflows/deploy.yml
```
