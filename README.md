# heartbeat

Static activity dashboard for projects explored at Sovereign Engineering cohorts.
It renders commits, PRs, issues, and releases as a compact `git log --oneline`
style timeline.

Target site: [heartbeat.sovereignengineering.io](https://heartbeat.sovereignengineering.io/)

Data is fetched at build time. The browser only reads `public/data/events.json`,
so visitors never call GitHub directly and never spend API rate limit.

Fork provenance: this project is adapted from
[OpenSats/heartbeat](https://github.com/OpenSats/heartbeat). Keep the `upstream`
remote pointed at OpenSats for later generic fix PRs.

## Develop

Requires Bun 1.3+.

```bash
bun install
export GITHUB_TOKEN=ghp_yourtoken   # public_repo scope is enough for public repos
bun run fetch                       # writes public/data/events.json
bun run dev
```

Useful checks:

```bash
bun test
bun run typecheck
bun run lint
bun run format:check
bun run build
```

## Configure

Heartbeat derives its repo set from the Sovereign Engineering website project
catalog.

Default source:

- `https://raw.githubusercontent.com/soveng/website/main/src/data/showcaseProjects.json`

Rules:

- GitHub repo URLs become `owner/repo`.
- GitHub URLs with deeper paths, such as `/pull/123` or `/tree/main`, still map
  to the base repo.
- GitHub owner/org URLs, such as `github.com/orgs/Routstr`, expand to all public
  non-archived repos for that owner.
- Public `github.com/soveng` repos are always added to the `soveng` group.
- Non-GitHub and site-only project links are reported and skipped.

Override source for local testing:

```bash
SOVENG_PROJECTS_JSON=/path/to/showcaseProjects.json bun run import:repos
SOVENG_PROJECTS_JSON=https://example.com/showcaseProjects.json bun run fetch
```

Knobs for the activity window and per-repo page sizes live at the top of
[`scripts/fetch.ts`](scripts/fetch.ts).

## Branch workflow

- `master` is the Sovereign Engineering heartbeat base.
- `upstream/master` tracks OpenSats heartbeat and is not used as the fork base.
- Create scoped issue branches from latest `master`, named `issue/NN-short-name`.
- Merge issue branches back to `master` with `git merge --ff-only`.
- Keep issue branches after merge so they remain available for review and later
  upstream extraction.
- For upstream PRs, create new branches from `upstream/master` and manually port
  only generic fixes. Do not include Sovereign Engineering branding, catalog
  logic, domain config, or Bun-only choices unless upstream asks for them.

## Deploy

Built for Vercel with Bun.

Project settings:

- Install command: `bun install --frozen-lockfile`
- Build command: `bun run vercel-build`
- Output directory: `dist`

Required env:

- `GITHUB_TOKEN`: GitHub token used for owner expansion and GraphQL activity fetch

Optional env:

- `SOVENG_PROJECTS_JSON`: explicit project catalog path or URL
- `VERCEL_DEPLOY_HOOK_URL`: GitHub Actions secret used by scheduled refresh

Domain:

- Add `heartbeat.sovereignengineering.io` to the Vercel project.
- Add the DNS record requested by Vercel.
- Verify:

```bash
curl -I https://heartbeat.sovereignengineering.io/
curl -fsS https://heartbeat.sovereignengineering.io/data/events.json
```
