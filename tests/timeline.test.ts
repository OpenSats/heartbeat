import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { INITIAL_VISIBLE_EVENTS, Timeline } from '../src/components/Timeline';
import type { Event } from '../src/types';

function eventAt(index: number): Event {
  return {
    id: `soveng/heartbeat:commit:${index}`,
    repo: 'soveng/heartbeat',
    type: 'commit',
    timestamp: '2026-05-09T00:00:00Z',
    actor: 'alice',
    title: `event ${index}`,
    url: `https://github.com/soveng/heartbeat/commit/${index}`,
    shortId: String(index),
  };
}

describe('Timeline', () => {
  test('caps the initial rendered event rows and exposes a show more control', () => {
    const events = Array.from({ length: INITIAL_VISIBLE_EVENTS + 1 }, (_, index) => eventAt(index));

    const html = renderToStaticMarkup(React.createElement(Timeline, { events }));

    expect(html).toContain(`event ${INITIAL_VISIBLE_EVENTS - 1}`);
    expect(html).not.toContain(`event ${INITIAL_VISIBLE_EVENTS}`);
    expect(html).toContain('show 1 more');
    expect(html).toContain(`${INITIAL_VISIBLE_EVENTS.toLocaleString()} of ${events.length}`);
  });

  test('does not show the control when all rows are visible', () => {
    const html = renderToStaticMarkup(React.createElement(Timeline, { events: [eventAt(0)] }));

    expect(html).toContain('event 0');
    expect(html).not.toContain('show');
  });
});
