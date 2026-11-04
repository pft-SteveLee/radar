import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRange, renderPrPage } from '../web/prStats.ts';

const TODAY = '2026-11-04';
const range = (query: string) => parseRange(new URLSearchParams(query), TODAY);

test('parseRange shows the last 26 weeks by default', () => {
  assert.deepEqual(range(''), { from: '2026-05-13', to: TODAY, weeks: 26 });
});

test('parseRange accepts 12, 26 or 52 weeks', () => {
  assert.deepEqual(range('weeks=52'), { from: '2025-11-12', to: TODAY, weeks: 52 });
  assert.deepEqual(range('weeks=12'), { from: '2026-08-19', to: TODAY, weeks: 12 });
});

test('parseRange accepts a custom from and to', () => {
  assert.deepEqual(range('from=2025-01-01&to=2025-06-30'), {
    from: '2025-01-01',
    to: '2025-06-30',
    weeks: null,
  });
});

test('parseRange falls back to 26 weeks for anything invalid', () => {
  for (const query of [
    'weeks=7',
    'from=2025-01-01',
    'from=2025-06-30&to=2025-01-01',
    'from=<script>&to=2025-01-01',
    'from=2020-01-01&to=2026-11-04',
  ])
    assert.deepEqual(range(query), { from: '2026-05-13', to: TODAY, weeks: 26 }, query);
});

const page = (members: string[]) =>
  renderPrPage({
    weeks: [
      { week: '2026-W43', counts: { alice: 3, bob: 1, renovate: 9 } },
      { week: '2026-W44', counts: null },
      { week: '2026-W45', counts: { alice: 5 } },
    ],
    members,
    range: { from: '2026-10-19', to: TODAY, weeks: null },
  });

test('renderPrPage shows the weekly count of every member, 0 when a fetched week has none', () => {
  const html = page(['alice', 'bob']);

  assert.match(html, /<tr><th scope="row">2026-W43<\/th><td>3<\/td><td>1<\/td><\/tr>/);
  assert.match(html, /<tr><th scope="row">2026-W45<\/th><td>5<\/td><td>0<\/td><\/tr>/);
});

test('renderPrPage marks a week that was never fetched with a dash, not 0', () => {
  assert.match(
    page(['alice', 'bob']),
    /<tr><th scope="row">2026-W44<\/th><td>—<\/td><td>—<\/td><\/tr>/,
  );
});

test('renderPrPage leaves out authors who are not members', () => {
  assert.doesNotMatch(page(['alice', 'bob']), /renovate/);
});

test('renderPrPage draws one line per member and breaks it at a missing week', () => {
  const html = page(['alice', 'bob']);

  assert.match(html, /<svg[^>]*role="img"/);
  const alicePath = html.match(/<path[^>]*data-member="alice"[^>]*d="([^"]+)"/)?.[1] ?? '';
  assert.equal((alicePath.match(/M/g) ?? []).length, 2);
  assert.match(html, /data-member="bob"/);
});

test('renderPrPage escapes member names', () => {
  const html = page(['<b>x</b>']);

  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

test('renderPrPage asks for the member list when it is empty', () => {
  assert.match(page([]), /請在 config\/prStats\.yaml 填 members/);
});

test('renderPrPage keeps the chosen range in the form', () => {
  const html = page(['alice']);

  assert.match(html, /name="from" value="2026-10-19"/);
  assert.match(html, /name="to" value="2026-11-04"/);
});
