export function githubPowPath(handle: string): string | undefined {
  return /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(handle) && handle !== 'unknown'
    ? `/pow/${encodeURIComponent(handle)}`
    : undefined;
}

export function developerRedirect(pathname: string, search: string): string | undefined {
  if (pathname !== '/') return;
  const params = new URLSearchParams(search);
  if ([...params].some(([key, value]) => key !== 'devs' && value.trim())) return;
  const handles = params
    .getAll('devs')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (new Set(handles.map((handle) => handle.toLowerCase())).size !== 1) return;
  return githubPowPath(handles[0]);
}
