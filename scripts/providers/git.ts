import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event } from '../../src/types';

// --- Provider identity ------------------------------------------------------
//
// This provider speaks plain Git over HTTPS. It performs a shallow clone of
// each repo, reads commit metadata via `git log`, and emits "commit" events
// only. No API. No pull requests, issues, or releases.
//
// Supported config syntax (v1):
//   "git:https://example.com/foo/bar"
//   "git:https://example.com/foo/bar.git"
//
// Not supported in v1:
//   ssh://, git@, http://, file://, private auth, push access

export const GIT_HOST = 'git';

// --- Configurable knobs (env vars override defaults) ------------------------

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  }
  return Math.floor(n);
}

const COMMITS_MAX_PER_REPO = intFromEnv('HEARTBEAT_COMMITS_MAX_PER_REPO', 5000);
const CLONE_TIMEOUT_MS = intFromEnv('HEARTBEAT_GIT_CLONE_TIMEOUT_MS', 60_000);
const LOG_TIMEOUT_MS = intFromEnv('HEARTBEAT_GIT_LOG_TIMEOUT_MS', 30_000);
// Buffer the --shallow-since cutoff by one day to handle out-of-order commit
// timestamps and timezone edge cases at the boundary.
const SHALLOW_BUFFER_MS = 24 * 60 * 60 * 1000;
// Fallback depth when --shallow-since fails (rare git footgun with certain
// commit topologies).
const FALLBACK_DEPTH = 1000;

// --- URL normalization ------------------------------------------------------
//
// Public helpers consumed by fetch.ts so config-load-time dedup can collapse
// equivalent spellings into one entry.

export type NormalizedGitUrl = {
  // Canonical URL: no .git suffix. Used as the repoKey suffix and event URL.
  // Example: "https://example.com/foo/bar"
  url: string;
  // Actual URL passed to `git clone`. Preserves the user-supplied .git if
  // present. Some servers (older cgit, dumb HTTP) require the .git suffix.
  // Example: "https://example.com/foo/bar.git" or "https://example.com/foo/bar"
  cloneUrl: string;
  // Display form used for the `repo` field and dataset.repos list.
  // Example: "example.com/foo/bar"
  display: string;
};

// Normalizes a raw "git:..." config entry. Returns null if the input is not a
// recognizable git: entry. The ConfigSchema regex should reject malformed
// inputs before they reach here, but we defend against bad calls anyway.
export function normalizeGitEntry(raw: string): NormalizedGitUrl | null {
  if (!raw.startsWith('git:https://')) return null;
  const rest = raw.slice('git:'.length); // "https://example.com/foo/bar.git/"

  let parsed: URL;
  try {
    parsed = new URL(rest);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  // Query strings and fragments are not part of a Git remote URL; rejecting
  // them prevents silently dropping ?token=... or #frag that the caller may
  // have intended.
  if (parsed.search || parsed.hash) return null;
  // Credentials embedded in URLs are out of scope for v1 (no private auth).
  // Reject rather than silently dropping them.
  if (parsed.username || parsed.password) return null;

  // Lowercase hostname (DNS is case-insensitive; this is the only safe
  // case-normalization we can do without breaking case-sensitive paths).
  const host = parsed.hostname.toLowerCase();

  // Clone path: strip only trailing slash. Preserve .git if user wrote it,
  // since some servers require it.
  let clonePath = parsed.pathname;
  if (clonePath.endsWith('/')) clonePath = clonePath.slice(0, -1);

  // Display/canonical path: also strip .git so equivalent spellings dedup.
  let displayPath = clonePath;
  if (displayPath.endsWith('.git')) displayPath = displayPath.slice(0, -4);

  if (!displayPath.startsWith('/') || displayPath.length < 2) return null;

  const cloneUrl = `https://${host}${clonePath}`;
  const url = `https://${host}${displayPath}`;
  const display = `${host}${displayPath}`;

  return { url, cloneUrl, display };
}

// --- git subprocess wrapper -------------------------------------------------
//
// Args are always passed as an array (never a shell string), so URLs and
// paths cannot be interpreted as shell metacharacters.

type GitRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

function runGit(args: string[], cwd: string | undefined, timeoutMs: number): Promise<GitRunResult> {
  return new Promise((resolveRun) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        // Make git non-interactive: never prompt for credentials, never
        // open a pager, never use a global config that might inject hooks.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/bin/echo',
        GIT_PAGER: 'cat',
        LANG: 'C',
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const STDOUT_LIMIT = 50 * 1024 * 1024; // 50 MB cap on captured output
    let stdoutLen = 0;
    let stderrLen = 0;

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen <= STDOUT_LIMIT) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen <= 1024 * 1024) {
        stderr += chunk.toString('utf8');
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolveRun({ ok: false, stdout, stderr: stderr + '\n' + err.message, code: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ ok: code === 0 && !timedOut, stdout, stderr, code, timedOut });
    });
  });
}

// --- Clone strategy ---------------------------------------------------------

async function cloneShallow(
  url: string,
  destDir: string,
  cutoffMs: number,
): Promise<{ ok: boolean; reason?: string }> {
  // Primary attempt: --shallow-since with a one-day buffer.
  const sinceISO = new Date(cutoffMs - SHALLOW_BUFFER_MS).toISOString();
  const primary = await runGit(
    [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      '--single-branch',
      `--shallow-since=${sinceISO}`,
      '--',
      url,
      destDir,
    ],
    undefined,
    CLONE_TIMEOUT_MS,
  );
  if (primary.ok) return { ok: true };
  if (primary.timedOut) {
    return { ok: false, reason: `clone timed out after ${CLONE_TIMEOUT_MS}ms` };
  }

  // Primary may have left a partial directory behind (git refuses to clone
  // into a non-empty path). Clear it before the fallback attempt.
  try {
    await rm(destDir, { recursive: true, force: true });
  } catch {
    // If we can't clean up, the fallback clone will fail with a clear
    // "destination path already exists" error, which we'll surface below.
  }

  // Fallback: --depth=N. Some commit topologies make --shallow-since fail
  // with "error: no commits selected for shallow request" or produce an
  // empty clone. The depth-based fallback is more robust at the cost of
  // potentially fetching more history than needed.
  const fallback = await runGit(
    [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      '--single-branch',
      `--depth=${FALLBACK_DEPTH}`,
      '--',
      url,
      destDir,
    ],
    undefined,
    CLONE_TIMEOUT_MS,
  );
  if (fallback.ok) return { ok: true };
  if (fallback.timedOut) {
    return { ok: false, reason: `clone (depth fallback) timed out after ${CLONE_TIMEOUT_MS}ms` };
  }

  // Both attempts failed. Surface a useful subset of stderr (last line tends
  // to be the actual error).
  const errLine = (fallback.stderr || primary.stderr).trim().split('\n').pop() ?? 'unknown error';
  return { ok: false, reason: `clone failed: ${errLine.slice(0, 200)}` };
}

// --- git log parsing --------------------------------------------------------
//
// We use ASCII unit separator (0x1f) between fields and record separator
// (0x1e) between commits. These chars do not appear in commit subjects,
// author names, or emails in practice.

const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

// Fields, in order:
//   %H  full SHA
//   %h  abbreviated SHA
//   %aI strict ISO 8601 author date (with timezone)
//   %an author name
//   %ae author email
//   %s  subject line
const LOG_FORMAT = `%H${FIELD_SEP}%h${FIELD_SEP}%aI${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%s${RECORD_SEP}`;

type ParsedCommit = {
  sha: string;
  shortSha: string;
  authorISO: string;
  authorName: string;
  authorEmail: string;
  subject: string;
};

function parseLogOutput(stdout: string): ParsedCommit[] {
  const out: ParsedCommit[] = [];
  // Split on record separator. Trailing empty entry expected (every record
  // ends with the separator).
  const records = stdout.split(RECORD_SEP);
  for (const r of records) {
    // git prefixes records after the first with a newline; trim it.
    const rec = r.startsWith('\n') ? r.slice(1) : r;
    if (rec === '') continue;
    const fields = rec.split(FIELD_SEP);
    if (fields.length < 6) continue; // malformed, skip
    const [sha, shortSha, authorISO, authorName, authorEmail, subject] = fields;
    if (!sha || !shortSha || !authorISO) continue; // required fields
    out.push({
      sha,
      shortSha,
      authorISO,
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      subject: subject ?? '',
    });
  }
  return out;
}

async function runGitLog(
  repoDir: string,
  cutoffMs: number,
): Promise<{ ok: boolean; commits: ParsedCommit[]; reason?: string }> {
  const sinceISO = new Date(cutoffMs).toISOString();
  const result = await runGit(
    [
      'log',
      `--since=${sinceISO}`,
      `--max-count=${COMMITS_MAX_PER_REPO}`,
      `--format=${LOG_FORMAT}`,
    ],
    repoDir,
    LOG_TIMEOUT_MS,
  );
  if (!result.ok) {
    if (result.timedOut) {
      return { ok: false, commits: [], reason: `git log timed out after ${LOG_TIMEOUT_MS}ms` };
    }
    const errLine = result.stderr.trim().split('\n').pop() ?? 'unknown error';
    return { ok: false, commits: [], reason: `git log failed: ${errLine.slice(0, 200)}` };
  }
  return { ok: true, commits: parseLogOutput(result.stdout) };
}

// --- Event shaping ----------------------------------------------------------

function actorKeyFor(authorName: string, authorEmail: string): string {
  // Prefer email (lowercased) for dedup since it tends to be stable across
  // name variations. Fall back to lowercased name. Final fallback: 'unknown'.
  if (authorEmail) return `${GIT_HOST}:${authorEmail.toLowerCase()}`;
  if (authorName) return `${GIT_HOST}:${authorName.toLowerCase()}`;
  return `${GIT_HOST}:unknown`;
}

function commitToEvent(repoKey: string, repo: string, repoUrl: string, c: ParsedCommit): Event {
  return {
    id: `${repoKey}:commit:${c.sha}`,
    host: GIT_HOST,
    repoKey,
    repo,
    type: 'commit',
    timestamp: c.authorISO,
    actorKey: actorKeyFor(c.authorName, c.authorEmail),
    actor: c.authorName || c.authorEmail || 'unknown',
    title: c.subject,
    url: repoUrl,
    shortId: c.shortSha,
  };
}

// --- Public entry point -----------------------------------------------------

export type GitFetchResult = {
  events: Event[];
  ok: boolean;
  reason?: string;
};

// `normalizedUrl` is the canonical .git-stripped form, used for repoKey and
// the per-commit event URL. `cloneUrl` is what gets passed to `git clone` —
// it may include .git if the user supplied it, since some servers require
// that suffix. `display` is the human-readable form ("example.com/foo/bar").
// The caller (fetch.ts) is responsible for passing already-normalized values;
// this provider does not re-parse the raw config entry.
export async function fetchGitRepo(
  normalizedUrl: string,
  cloneUrl: string,
  display: string,
  cutoffMs: number,
): Promise<GitFetchResult> {
  const repoKey = `${GIT_HOST}:${normalizedUrl}`;
  let tmpDir: string | null = null;

  try {
    const dir = await mkdtemp(join(tmpdir(), 'heartbeat-git-'));
    tmpDir = dir;

    const cloneResult = await cloneShallow(cloneUrl, dir, cutoffMs);
    if (!cloneResult.ok) {
      return { events: [], ok: false, reason: cloneResult.reason };
    }

    const logResult = await runGitLog(dir, cutoffMs);
    if (!logResult.ok) {
      return { events: [], ok: false, reason: logResult.reason };
    }

    const events = logResult.commits.map((c) =>
      commitToEvent(repoKey, display, normalizedUrl, c),
    );
    return { events, ok: true };
  } catch (err) {
    return { events: [], ok: false, reason: `git provider error: ${(err as Error).message}` };
  } finally {
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Cleanup failure is non-fatal; CI tmp will be reaped anyway.
      }
    }
  }
}
