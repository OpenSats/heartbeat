export const displayRepo = (repo: string) => repo.replace(/^gitlab\.com\//, '');

const shortRepo = (repo: string) => displayRepo(repo).split('/').pop() ?? displayRepo(repo);

/**
 * Renders a repo identifier responsively: the short name on mobile
 * (e.g. `amethyst`) and the full `owner/name` on desktop. Returns a
 * fragment so the caller controls truncation/styling.
 */
export function RepoLabel({ repo }: { repo: string }) {
  const display = displayRepo(repo);

  return (
    <>
      <span className="sm:hidden">{shortRepo(repo)}</span>
      <span className="hidden sm:inline">{display}</span>
    </>
  );
}
