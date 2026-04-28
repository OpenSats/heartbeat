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

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. In *Settings > Pages*, set "Build and deployment" source to **GitHub
   Actions**.
3. (Optional) For private repos, create a PAT with `repo` scope and add it as
   a repository secret named `HEARTBEAT_TOKEN`. Public-only setups can rely
   on the auto-provided `GITHUB_TOKEN`.
4. Push to `main` (or run the *Build & Deploy* workflow manually). It also
   re-runs every 6 hours via cron.

The site will be available at
`https://<your-username>.github.io/<repo-name>/`.

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
