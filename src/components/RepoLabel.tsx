const shortRepo = (r: string) => r.split('/').pop() ?? r;

/**
 * Renders a repo identifier responsively: the short name on mobile
 * (e.g. `amethyst`) and the full `owner/name` on desktop. Returns a
 * fragment so the caller controls truncation/styling.
 *
 * If `host` is provided, an unobtrusive `[host]` badge is rendered
 * after the name. The badge is intended only for collision cases in
 * the filter bar — i.e. when the same `owner/name` exists on multiple
 * hosts and the user needs to pick one. Most callers should leave
 * `host` undefined.
 */
export function RepoLabel({ repo, host }: { repo: string; host?: string | null }) {
  const badge = host ? (
    <span className="ml-1 text-[10px] text-zinc-600 lowercase">[{host}]</span>
  ) : null;

  return (
    <>
      <span className="sm:hidden">
        {shortRepo(repo)}
        {badge}
      </span>
      <span className="hidden sm:inline">
        {repo}
        {badge}
      </span>
    </>
  );
}
