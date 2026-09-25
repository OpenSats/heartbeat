# heartbeat

## PoW activity explorer (MVP)

Open `/pow/dergigi`, `/pow/fiatjaf.com`, or `/pow/npub…`. Handles load
GitHub; domains and NIP-05 identifiers resolve to Nostr. Existing `/pow?gh=dergigi`
links and `p=npub…` or repeated `repo=owner/repo` parameters also work. The browser combines sources; the backend accepts exactly one source
per request. No person registry, identity mappings, or combined reports are stored.

Social previews use `@vercel/og` at `/api/pow/og`, with the same source parameters
and optional `year`. Person pages serve Open Graph and Twitter card metadata in
the initial HTML while keeping the existing React app. The card combines cached
activity with per-source counts, an avatar, and coverage markings. It never
starts activity backfills. Profile discovery uses the existing independent CDN
caches, has a 12-second budget, and shares the page's verification rules.
Rendered images are CDN-cached for one hour, or one minute when source months
are missing or unavailable. Social platforms may retain their own copies longer.
No new database tables, stored account associations, or Blob storage are needed.
Avatars use bounded HTTPS downloads with public DNS pinning; unavailable images
fall back to an initial. `/pow` previews always show the combined activity for
the URL's sources and year; temporary browser-only filters are not included.

`/api/pow/source?kind=github&value=dergigi` uses a Neon Postgres source cache.
Set server-only `DATABASE_URL` and `GITHUB_TOKEN`; run `npm run db:migrate` once
against that database. For local setup using pulled Vercel variables:
`node --env-file=.env.local --import tsx scripts/migrate-pow.ts`.
Use `vercel dev` for the frontend and API together.

`p=` and `ngit=` also accept NIP-05 addresses, such as `dergigi.com`,
`fiatjaf.com`, or `sync@nostr.boutique`. Bare domains resolve the `_` name.
The browser resolves each address independently through `/api/pow/resolve`, then
loads activity under the resulting npub. Human-readable addresses stay in the
page URL. Successful public lookups are cached at the CDN for one hour and in
the browser HTTP cache for five minutes; no identity directory is stored in the
database. Lookups use HTTPS, reject redirects, and allow only public IP addresses. Source
labels and matching timeline authors use the NIP-05 identifier from the latest
observed signed profile only after its domain resolves back to the same npub.
Root identifiers display as bare domains. Failed or mismatched checks keep the
npub visible; filtering and activity cache keys continue to use the original key.

Account discovery automatically loads npubs in GitHub bios, website
fields, or social links. These are references, not ownership proofs. In the other
direction, NIP-39 `github:` claims are read from signed kind-10011 lists (with
legacy kind-0 fallback) and loaded only when a public, single-file gist has the
claimed GitHub owner and the exact NIP-39 verification text for that npub.
A root website in a GitHub profile can also resolve through NIP-05. In the
reverse direction, a signed Nostr profile can suggest a GitHub handle through
its GitHub website link or the first label of its root NIP-05 domain. That
candidate is loaded only when its GitHub profile links back to the same npub
or qualifying NIP-05 domain; a matching name alone is insufficient.
Profile READMEs and unproven GitHub mentions in Nostr bios are not scanned.
The browser matches the evidence and adds discovered accounts to the URL without
a confirmation step, preserving filters and the eight-source limit. Public
profiles and gists are cached independently at the CDN for one hour; discovery
creates no database records or stored cross-account mappings.

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

TODO: ngit/GRASP Git commit history

- [ ] Fetch Git history from public GRASP repositories in background workers, with
      resumable backfills for the selected year.
- [ ] Cache immutable commits indefinitely by repository and commit hash; fetch
      new history incrementally and avoid duplicate counts across mirrors.
- [ ] Distinguish commit authors, committers, and npub-signed ref publishers.
      Define evidence for attributing commits to an npub; never assume the person
      pushing a branch authored every commit. Keep uncertain attribution visible
      and preserve the rule against storing account associations or a people registry.
- [ ] Show commit activity separately from ref updates, with explicit date semantics
      and coverage indicators. Missing refs, shallow history, or unavailable objects
      must remain uncertain gaps. Git history alone cannot reconstruct push dates
      lost when relays replace older ref updates.

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
more than 1,000 results are subdivided. Search and thread pagination progress is
saved between worker deliveries. It discovers additional threads with `involves:`
and `reviewed-by:` searches, then reads issue timelines, submitted reviews, and
inline review comments. Comment and review authors, or status-event actors,
determine attribution. Actions are dated when performed, not when the issue/PR
was created. Closing, reopening, merging, draft, and ready-for-review transitions
appear under “status changes”; comments and reviews have their own filter groups.
Discovery uses thread updates from the requested month onward, including later
updates, so old actions on recently updated threads are not excluded.

Thread pages are cached independently for 24 hours by repository, issue/PR,
endpoint, and page, and reused across people and months. GitHub monthly snapshots
use `v4` keys; existing `v3` activity remains visible as incomplete while the new
collector backfills. Older preview deployments cannot overwrite these expanded
snapshots. Nostr also uses `v4` keys for outbox backfills; ngit keys remain unchanged.
No database migration is needed.

Cross-repository discovery is not exhaustive: searches can miss threads where
someone only changed a status, and deleted or inaccessible content is unavailable.
Person heatmaps therefore retain uncertain coverage even after all discovered
pages have been fetched. This uncertainty does not trigger perpetual historical
backfills: completed historical collection checkpoints remain cached indefinitely.
Extra GitHub repos include all contributors. Other git hosts are not supported.
Nostr discovers the author's latest signed NIP-65 (kind 10002) relay list and
reads kind-1 notes from its write relays (including entries marked for both read
and write). These are the relays where the author publishes; read-only entries
are for receiving mentions. Up to eight advertised write relays are queried,
plus `relay.damus.io`, `nos.lol`, and `relay.primal.net` as fallbacks.
Discovery queries those three plus `purplepag.es`, `relay.nostr.com`,
`nostr.bitcoiner.social`, `nostr.mom`, `relay.snort.social`, `nos.relay`,
`nostr.inosta.cc`, and `nostr.wine`. Discovery is cached per pubkey for 24 hours;
failed discovery is retried after an hour. A cached signed list survives discovery
outages, while a newer empty list clears its advertised relays. NIP-66 health
reports are not used yet.

Monthly pagination resumes through the queue, with bounded retries for failing
relays. Previously observed posts are retained. Existing v3 months stay visible
while requested history is supplemented using outbox relays. Completed historical
months remain cached indefinitely; later relay-list changes do not automatically
reopen them. Partial months retry after an hour. Only public WSS relays on port
443 are supported. Relay coverage can never prove inactivity. All Nostr days, person-level GitHub discovery, unfetched periods, and incomplete
GitHub repository periods are striped in the heatmap. Plain empty repository cells
mean no indexed activity in the fetched GitHub categories. Today remains uncertain until complete.
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

Activity requests identify one source at a time and suppress Referer headers.
Social image requests include the URL-selected sources; the renderer combines them
in memory and caches the resulting image at the CDN without storing account
associations in the database.
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
tracked; `build:vercel` runs `npm run fetch && npm run build` once per deployment via `vercel.json`. For periodic
refreshes, save a Vercel Deploy Hook URL as the `VERCEL_DEPLOY_HOOK_URL` repo
secret and the included [`refresh.yml`](.github/workflows/refresh.yml)
workflow pings it every 6 hours.
