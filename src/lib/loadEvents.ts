import { DatasetSchema, type Dataset } from '../types';

export async function loadEvents(): Promise<Dataset> {
  const url = `${import.meta.env.BASE_URL}data/events.json`;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`Failed to load events.json: ${res.status} ${res.statusText}`);
  }
  return DatasetSchema.parse(await res.json());
}
