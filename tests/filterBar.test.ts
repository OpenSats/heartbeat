import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilterBar } from '../src/components/FilterBar';
import type { FilterControl } from '../src/lib/useUrlSet';

function installWindow() {
  const fakeWindow = {
    location: new URL('https://heartbeat.sovereignengineering.io/'),
    history: {
      replaceState() {},
    },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(globalThis, 'window', {
    value: fakeWindow,
    writable: true,
    configurable: true,
  });
}

function filterControl(): FilterControl {
  return {
    selected: null,
    set() {},
    toggle() {},
    clear() {},
  };
}

describe('FilterBar', () => {
  test('renders SovEng group filters without OpenSats copy', () => {
    installWindow();
    const html = renderToStaticMarkup(
      React.createElement(FilterBar, {
        repos: ['soveng/website'],
        groups: { soveng: ['soveng/website'] },
        groupFilter: filterControl(),
        repoFilter: filterControl(),
        typeFilter: filterControl(),
        actorFilter: filterControl(),
      }),
    );

    expect(html).toContain('group:');
    expect(html).toContain('Sovereign Engineering');
    expect(html).not.toContain('OpenSats');
  });
});
