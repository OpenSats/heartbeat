# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-29

First tagged release. Heartbeat is a static activity dashboard that renders
commits, PRs, issues, and releases for a curated set of GitHub repos as a
`git log --oneline`-style timeline. Data is fetched at build time and served
as a static JSON file, so visitors never hit the GitHub API directly.

### Added

- Timeline view with per-event-type sigils, colors, and short ids.
- Clickable short ids: commit hashes, `#PR`/`#issue` numbers, and release
  tags link straight to GitHub.
- Click a repo name or username inside an event row to filter the timeline
  by that repo or dev.
- Repo lists are loaded from grouped `repos.*.yml` files (one per fund)
  and merged on build.
- Filter bar with chip-based filters for fund, repo, type, and dev.
- Live `filter:` textbox that auto-selects matching repos as you type,
  with debounced URL writes for snappy typing on large repo lists.
- `?q=` URL param prefills the filter textbox so links are shareable;
  matching repos are re-selected on load.
- Fund-level filter with row label and lowercase fund names derived from
  the filename.
- Collapsible repos row with a `show all <n>` / `<n> selected` summary
  chip and a clear shortcut.
- Click the OpenSats mark / "heartbeat" title to reset every filter.
- Footer line summarizing unfiltered totals by event type, plus a
  `repo missing? create a PR` invite.
- Sticky filter bar and sticky day headers on desktop.
- Mobile-tuned layout: condensed metadata line, truncated dev name,
  hidden commit hashes, and a `└─` prefix on wrapped titles.
- OpenGraph and Twitter card metadata for rich link previews.
- Vercel build script (`vercel-build`) and a scheduled GitHub Action
  (`refresh.yml`) that pings a Vercel deploy hook every 6 hours.

### Changed

- `actor` filter renamed to `dev` end-to-end: row label, internal naming,
  and URL param (`?actors=` → `?devs=`).
- Filter input restyled to match chip buttons and moved below the repo
  chips; row labels aligned to a fixed-width column.

### Performance

- `EventRow` is memoized and click handlers are stabilized so timeline
  re-renders stay cheap as filters change.
- Filter-driven work is deferred via `useDeferredValue` and the
  query-to-repos auto-select is debounced to coalesce history writes.

[Unreleased]: https://github.com/OpenSats/heartbeat/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OpenSats/heartbeat/releases/tag/v0.1.0
