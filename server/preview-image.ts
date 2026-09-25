import { createElement as h } from 'react';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from '@vercel/og';
import { dayCovered, type Platform, type Preview } from './pow-preview.js';
import { sourcePlatform } from '../src/pow/model.js';

const palette = {
  github: ['#022c22', '#065f46', '#059669', '#34d399'],
  nostr: ['#2e1065', '#5b21b6', '#7c3aed', '#a78bfa'],
  ngit: ['#451a03', '#92400e', '#d97706', '#fbbf24'],
};
const labels = {
  github: 'GitHub events',
  nostr: 'Nostr posts + replies',
  ngit: 'ngit events',
};
function cellColor(counts: Partial<Record<Platform, number>>) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (!total) return '#18181b';
  const level = total < 3 ? 0 : total < 6 ? 1 : total < 12 ? 2 : 3;
  const rgb = [0, 0, 0];
  for (const [platform, count] of Object.entries(counts)) {
    const hex = palette[platform as Platform][level].slice(1);
    rgb.forEach((_, i) => {
      rgb[i] += (parseInt(hex.slice(i * 2, i * 2 + 2), 16) * count) / total;
    });
  }
  return `rgb(${rgb.map(Math.round).join(',')})`;
}
function heatmap(preview: Preview) {
  const start = Date.parse(`${preview.range.from}T00:00:00Z`);
  const end = Date.parse(`${preview.range.to}T00:00:00Z`);
  const offset = new Date(start).getUTCDay();
  const counts = new Map<string, Partial<Record<Platform, number>>>();
  for (const day of preview.days)
    counts.set(day.date, { ...counts.get(day.date), [day.platform]: day.count });
  const cells: string[] = [];
  const months: { x: number; label: string }[] = [];
  for (let time = start, index = offset; time <= end; time += 86400000, index++) {
    const date = new Date(time).toISOString().slice(0, 10);
    const x = Math.floor(index / 7) * 20 + 2;
    const y = (index % 7) * 20 + 32;
    if (date.endsWith('-01') || time === start) {
      // Omit a short opening month so the following month label remains visible.
      if (
        date.endsWith('-01') ||
        new Date(time + 7 * 86400000).getUTCMonth() === new Date(time).getUTCMonth()
      )
        months.push({
          x,
          label: new Date(time).toLocaleString('en', { month: 'short', timeZone: 'UTC' }),
        });
    }
    cells.push(
      `<rect x="${x}" y="${y}" width="16" height="16" rx="3" fill="${cellColor(counts.get(date) ?? {})}"/>`,
    );
    if (!dayCovered(preview, date))
      cells.push(`<rect x="${x}" y="${y}" width="16" height="16" rx="3" fill="url(#uncertain)"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="176"><defs><pattern id="uncertain" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M-1 1L1-1M0 6L6 0M5 7L7 5" stroke="#a1a1aa" stroke-opacity=".18" stroke-width="1"/></pattern></defs>${cells.join('')}</svg>`;
  return { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, months };
}
let font: Promise<Buffer> | undefined;
export async function renderPreview(preview: Preview, avatar?: string) {
  font ??= readFile(
    join(
      process.cwd(),
      'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff',
    ),
  );
  const data = await font;
  const mono = { fontFamily: 'Plex' };
  const label = preview.label.startsWith('npub1')
    ? `${preview.label.slice(0, 16)}...${preview.label.slice(-8)}`
    : preview.label.length > 42
      ? `${preview.label.slice(0, 39)}...`
      : preview.label;
  const platforms = (['github', 'nostr', 'ngit'] as const).filter((p) =>
    preview.sources.some((s) => sourcePlatform(s) === p),
  );
  const totals = platforms.map((platform) => ({
    platform,
    count: preview.days.filter((d) => d.platform === platform).reduce((n, d) => n + d.count, 0),
  }));
  const incomplete = preview.unavailable || preview.cachedMonths < preview.expectedMonths;
  const relayUncertainty = preview.sources.some((s) => sourcePlatform(s) !== 'github');
  const discoveryUncertainty = preview.windows.some((row) =>
    row.windows?.some((w) => w.discoveryLimited),
  );
  const uncertainty = relayUncertainty || discoveryUncertainty;
  const coverageLabel = relayUncertainty
    ? 'Relay coverage uncertain'
    : 'Activity discovery uncertain';
  const partial = preview.windows.some(
    (row) => !row.windows?.length || row.windows.some((w) => !w.exhaustive),
  );
  const status = preview.unavailable
    ? 'Some sources unavailable'
    : !preview.cachedMonths
      ? 'Activity has not been cached yet'
      : incomplete || partial
        ? 'History partially cached'
        : uncertainty
          ? coverageLabel
          : 'Cached public activity';
  const chart = heatmap(preview);
  const card = h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        padding: '42px 56px',
        background: '#09090b',
        color: '#e4e4e7',
        fontFamily: 'Plex',
      },
    },
    h(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      h(
        'div',
        { style: { display: 'flex', fontSize: 28 } },
        h('span', { style: { color: '#fafafa', marginRight: 16 } }, '>_'),
        'heartbeat',
        h('span', { style: { color: '#71717a' } }, '/pow'),
      ),
      h('div', { style: { fontSize: 18, color: '#71717a' } }, 'by OpenSats'),
    ),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', marginTop: 34, gap: 24 } },
      avatar
        ? h('img', {
            src: avatar,
            width: 84,
            height: 84,
            style: { borderRadius: 42, objectFit: 'cover' },
          })
        : h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 84,
                height: 84,
                borderRadius: 42,
                background: '#18181b',
                color: '#a78bfa',
                fontSize: 36,
              },
            },
            label.slice(0, 1).toUpperCase(),
          ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h(
          'div',
          {
            style: {
              fontSize: label.length > 30 ? 30 : label.length > 22 ? 38 : 48,
              color: '#fafafa',
            },
          },
          label,
        ),
        h(
          'div',
          { style: { fontSize: 17, color: '#71717a' } },
          preview.year === null
            ? 'Public activity / last 365 days'
            : `Public activity / ${preview.year}`,
        ),
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', gap: 38, marginTop: 30, height: 70 } },
      ...totals.map(({ platform, count }) =>
        h(
          'div',
          { key: platform, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h(
            'div',
            { style: { fontSize: 28, color: palette[platform][3] } },
            count.toLocaleString('en'),
          ),
          h('div', { style: { fontSize: 15, color: '#a1a1aa' } }, labels[platform]),
        ),
      ),
      !totals.length
        ? h('div', { style: { fontSize: 22, color: '#a1a1aa' } }, 'GitHub / Nostr / ngit')
        : null,
    ),
    h(
      'div',
      { style: { display: 'flex', position: 'relative', width: 1080, height: 176, marginTop: 20 } },
      h('img', { src: chart.src, width: 1080, height: 176 }),
      ...chart.months.map(({ x, label }) =>
        h(
          'span',
          {
            key: x,
            style: { position: 'absolute', left: x, top: 0, color: '#71717a', fontSize: 13 },
          },
          label,
        ),
      ),
    ),
    h(
      'div',
      {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          borderTop: '1px solid #27272a',
          paddingTop: 18,
          marginTop: 22,
          fontSize: 14,
          color: '#71717a',
          ...mono,
        },
      },
      h(
        'span',
        null,
        `${status}${uncertainty && status !== coverageLabel ? ` · ${coverageLabel.toLowerCase()}` : ''}`,
      ),
      h('span', null, `${preview.range.from} / ${preview.range.to}`),
    ),
  );
  return new ImageResponse(card, {
    width: 1200,
    height: 630,
    fonts: [
      {
        name: 'Plex',
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        weight: 400,
        style: 'normal',
      },
    ],
  });
}
