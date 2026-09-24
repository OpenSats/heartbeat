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

Snapshots stay fresh for 24 hours. Stale data is served during refresh, failed
refreshes preserve the last snapshot and back off for 15 minutes, and a database
lease prevents duplicate fetches. A global limit allows 120 refresh attempts per
hour. Production and previews share this cache, so schema changes must remain
backwards compatible. Cache budget rows older than two days are removed by the
migration command. Successful refreshes replace bounded 90-day snapshots; this
MVP is not a permanent archive or an incremental collector.

GitHub coverage: up to 100 authored commits and 100 authored issues/PRs from
public search. Extra GitHub repos show all contributors, separately labeled as
repository context. Other git hosts, reviews, and merge actions are not supported
yet. Nostr fetches up to 200 signed kind-1 notes from each of three fixed relays;
coverage is shown per source. Each source can succeed or fail independently.

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
