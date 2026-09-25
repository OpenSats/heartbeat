function pathSource(pathname: string) {
  const match = /^\/pow\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let value: string;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    value = match[1];
  }
  const parameter = /^(nostr:)?npub1/i.test(value) || /[.@]/.test(value) ? 'p' : 'gh';
  return { parameter, value };
}

export function powParams(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  const source = pathSource(pathname);
  if (source && !params.getAll(source.parameter).includes(source.value)) {
    const others = params.getAll(source.parameter);
    params.delete(source.parameter);
    params.append(source.parameter, source.value);
    for (const value of others) params.append(source.parameter, value);
  }
  return params;
}

export function powUrl(params: URLSearchParams, pathname = '/pow') {
  const query = new URLSearchParams(params);
  const source = pathSource(pathname);
  const keepPath = source && query.getAll(source.parameter).includes(source.value);
  if (keepPath) query.delete(source.parameter, source.value);
  const path = keepPath ? pathname.replace(/\/$/, '') : '/pow';
  return `${path}${query.size ? `?${query}` : ''}`;
}
