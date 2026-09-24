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

An `npub` in `p=` loads both text notes and ngit activity. Use `ngit=npub…`
to load code activity alone. NIP-34 patches, PRs, PR updates, issues, NIP-22 code
comments, status messages, repository announcements and ref updates appear in an
amber ngit/GRASP heatmap. All events are signature-checked and attributed to their
signer. A published patch or ref update is counted as one event, not as a Git commit.

`repo=` also accepts `nostr://npub/identifier`, `nostr://npub/relay/identifier`,
NIP-19 repository `naddr` values, and GRASP HTTPS URLs ending in
`/npub/identifier.git`. These show repository context from all contributors.
Repository comments/statuses without repository address tags can be missing.
NIP-05 clone addresses and raw Git object/commit history are not supported yet.

The ngit collector discovers public relays from signed GRASP lists, outbox lists,
and repository announcements, with `relay.ngit.dev`, `nos.lol`, and `relay.damus.io`
as discovery relays. Relay discovery is cached per source for 24 hours. Monthly
pagination checkpoints use the existing queue and source cache. Public WSS relays
on port 443 are supported; resolved IPs are checked and pinned before connecting.
No new credentials or database migration are required.

Relay-backed heatmaps remain striped: relays can omit data, and replaceable
repository state does not provide a complete history of pushes. Previously seen
ngit events are retained when refreshing a month, even if a relay later drops them.

The browser defaults to 365 days and queues all requested months up front. A year selector
loads calendar years back to 2008, stored as `year=2025` in the view URL. Each
platform has a separate heatmap, yearly total, and coverage indicators.
The current month stays fresh for 24 hours; finished historical months are cached
indefinitely. Incomplete months retry after one hour. Failed requests preserve
cached results and back off for two minutes, or until GitHub permits retrying.
After five consecutive collection errors, a job stops and can be requested again
after an hour. A database lease prevents duplicate
fetches. Each cache key identifies one source and month; associations remain in
the URL. Completed historical snapshots have no automatic expiry. A month fetched while
it was current is fetched through month-end once it closes. Edits, deletions, and
indexing changes after that require explicit cache invalidation.

GitHub collection paginates commit and issue/PR search results. Intervals with
more than 1,000 results are subdivided. Search pagination progress is saved between requests. Busy months resume on
subsequent worker deliveries and remain marked incomplete until pagination finishes. Reviews and merge actions are excluded.
Extra GitHub repos include all contributors. Other git hosts are not supported.
Nostr paginates signed kind-1 notes across three fixed relays. Its relay coverage
can never prove inactivity. All Nostr days, unfetched periods, and incomplete
GitHub periods are striped in the heatmap. Plain empty cells mean no indexed
activity in the fetched GitHub categories. Today remains uncertain until complete.
Click a day to filter the timeline. The source form is hidden when URL parameters
are present. Nostr links use njump.to.

Vercel Queues runs separate GitHub and Nostr consumers, configured in `vercel.json`.
No extra queue credentials are needed on Vercel. GitHub has one worker per deployment;
Nostr has two. A shared database throttle spaces GitHub search requests and honors
rate-limit reset and Retry-After headers across deployments. Jobs contain one source
and one month. Leases deduplicate jobs across visitors, preview, and production.
The page polls cached results every ten seconds; queued jobs continue after it closes.
Queue messages expire after seven days; revisiting a source recovers expired jobs.
Production and previews share the cache, so schema changes must remain backwards
compatible. The old budget table is retained for older previews but these workers
no longer use it. Very large month responses are bounded at 3 MB and explicitly
marked incomplete.

The page sends no combined identifiers to the API and suppresses Referer headers.
Full page URLs can still appear in browser history and hosting access logs; do not
add analytics that store query strings. Database credentials stay server-side.

Static activity dashboard for a set of GitHub, GitLab, Forgejo, and plain
git repos. Renders commits, PRs, issues, and releases as a
`git log --oneline`-style timeline.

Live at [heartbeat.opensats.org](https://heartbeat.opensats.org/)

A build-time fetcher pulls activity data and writes `public/data/events.json`.
The browser never talks to GitHub or GitLab directly, so visitors don't burn
any rate-limit budget.

Today GitHub, public GitLab, Forgejo/Gitea instances (e.g.
[codeberg.org](https://codeberg.org/) or
[git.rust-bitcoin.org](https://git.rust-bitcoin.org/)), and plain git
remotes (e.g. cgit hosts like [git.zx2c4.com](https://git.zx2c4.com/)) are
wired up. The plan is to also pull from nostr-native hosts like
[gitworkshop.dev](https://gitworkshop.dev/).

## Develop

Requires Node 22+.

```bash
npm install
export GITHUB_TOKEN=ghp_yourtoken   # any PAT; only needed for GitHub repos
npm run fetch                       # writes public/data/events.json
npm run dev
```

Public GitLab and Forgejo repos are fetched without auth.

## Configure

Each `repos*.yml` file at the project root lists tracked repos; all matching
files are merged and deduplicated.

```yaml
repos:
  - owner/repo-1
  - owner/repo-2
  - provider: gitlab
    repo: group/project
    # host: gitlab.com
  - provider: forgejo
    repo: owner/repo
    # host: codeberg.org
  - provider: git
    url: https://git.zx2c4.com/wireguard-tools
```

Forgejo (and Gitea) instances are queried via their REST API; commits,
PRs, issues, and releases all show up, same as GitHub.

Plain git repos are fetched with a shallow `git clone`, so only commits and
tags show up (there are no PRs or issues on a bare remote). Event links use
cgit-style URLs (`<url>/commit/?id=<hash>`).

Knobs (time window, page sizes) live at the top of
[`scripts/fetch.ts`](scripts/fetch.ts).

## Deploy

Built for Vercel. Set `GITHUB_TOKEN` as an env var when GitHub repos are
tracked; `vercel-build` runs `npm run fetch && npm run build`. For periodic
refreshes, save a Vercel Deploy Hook URL as the `VERCEL_DEPLOY_HOOK_URL` repo
secret and the included [`refresh.yml`](.github/workflows/refresh.yml)
workflow pings it every 6 hours.
