# heartbeat

## PoW activity explorer (MVP)

Open `/pow?gh=dergigi` or supply `p=npub…` and repeated `repo=owner/repo`
parameters. The browser combines sources; the backend accepts exactly one source
per request. No person registry, identity mappings, or combined reports are stored.

`/api/pow/source?kind=github&value=dergigi` uses a Neon Postgres source cache.
Set server-only `DATABASE_URL` and `GITHUB_TOKEN`; run `npm run db:migrate` once
against that database. For local setup using pulled Vercel variables:
`node --env-file=.env.local --import tsx scripts/migrate-pow.ts`.
Use `vercel dev` for the frontend and API together.

The browser backfills 365 days in monthly requests and draws a daily heatmap.
The current month stays fresh for 24 hours; finished historical months are cached
for 90 days. Incomplete months retry after one hour. Failed requests preserve
cached results and back off for two minutes. A database lease prevents duplicate
fetches. Each cache key identifies one source and month; associations remain in
the URL. Historical snapshots are occasionally revalidated for edits, deletions,
and changes to search indexing.

GitHub collection paginates commit and issue/PR search results. Intervals with
more than 1,000 results are subdivided. A per-request budget bounds collection;
months that hit it are marked incomplete. Reviews and merge actions are excluded.
Extra GitHub repos include all contributors. Other git hosts are not supported.
Nostr paginates signed kind-1 notes across three fixed relays. Its relay coverage
can never prove inactivity. All Nostr days, unfetched periods, and incomplete
GitHub periods are striped in the heatmap. Plain empty cells mean no indexed
activity in the fetched GitHub categories. Today remains uncertain until complete.
Click a day to filter the timeline. The source form is hidden when URL parameters
are present. Nostr links use njump.to.

A global limit allows 120 refresh attempts per hour. Production and previews
share the cache, so schema changes must remain backwards compatible. Budget rows
older than two days are removed by the migration command. Very large month
responses are bounded at 3 MB and explicitly marked incomplete. Backfill resumes
from cached months when the page is reopened.

The page sends no combined identifiers to the API and suppresses Referer headers.
Full page URLs can still appear in browser history and hosting access logs; do not
add analytics that store query strings. Database credentials stay server-side.

Static activity dashboard for a set of GitHub repos. Renders commits, PRs,
issues, and releases as a `git log --oneline`-style timeline.

Live at [heartbeat.opensats.org](https://heartbeat.opensats.org/)

A GitHub Action fetches data via the GitHub GraphQL API at build time and
writes `public/data/events.json`. The browser never talks to GitHub directly,
so visitors don't burn any rate-limit budget.

Today only GitHub is wired up. The plan is to also pull from Gitea, GitLab,
and nostr-native hosts like [gitworkshop.dev](https://gitworkshop.dev/).

## Develop

Requires Node 22+.

```bash
npm install
export GITHUB_TOKEN=ghp_yourtoken   # any PAT; no scopes needed for public repos
npm run fetch                       # writes public/data/events.json
npm run dev
```

## Configure

Each `repos*.yml` file at the project root lists tracked repos; all matching
files are merged and deduplicated.

```yaml
repos:
  - owner/repo-1
  - owner/repo-2
```

Knobs (time window, page sizes) live at the top of
[`scripts/fetch.ts`](scripts/fetch.ts).

## Deploy

Built for Vercel. Set `GITHUB_TOKEN` as an env var; `vercel-build` runs
`npm run fetch && npm run build`. For periodic refreshes, save a Vercel
Deploy Hook URL as the `VERCEL_DEPLOY_HOOK_URL` repo secret and the included
[`refresh.yml`](.github/workflows/refresh.yml) workflow pings it every 6 hours.
