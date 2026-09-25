import { latestRelayFetches, type RelayFetch, type RelayTask } from '../src/pow/model.js';

export function recordRelayFetches(
  previous: RelayFetch[],
  tasks: RelayTask[],
  results: PromiseSettledResult<{ events: unknown[]; exhaustive: boolean }>[],
): RelayFetch[] {
  const checkedAt = new Date().toISOString();
  return latestRelayFetches([
    ...previous,
    ...results.map(
      (result, index): RelayFetch => ({
        url: tasks[index].url,
        checkedAt,
        status:
          result.status === 'rejected'
            ? 'unavailable'
            : result.value.exhaustive
              ? 'complete'
              : 'partial',
        eventCount: result.status === 'fulfilled' ? result.value.events.length : 0,
      }),
    ),
  ]);
}
