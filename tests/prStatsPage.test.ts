import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRange, renderPrPage } from '../web/prStats.ts';

const TODAY = '2026-11-04';
const range = (query: string) => parseRange(new URLSearchParams(query), TODAY);
const DEFAULT_RANGE = { from: '2026-05-13', to: TODAY, weeks: 26, invalid: false };

test('parseRange shows the last 26 weeks by default', () => {
  assert.deepEqual(range(''), DEFAULT_RANGE);
});

test('parseRange accepts 12, 26 or 52 weeks', () => {
  assert.deepEqual(range('weeks=52'), {
    from: '2025-11-12',
    to: TODAY,
    weeks: 52,
    invalid: false,
  });
  assert.deepEqual(range('weeks=12'), {
    from: '2026-08-19',
    to: TODAY,
    weeks: 12,
    invalid: false,
  });
});

test('parseRange accepts a custom from and to', () => {
  assert.deepEqual(range('from=2025-01-01&to=2025-06-30'), {
    from: '2025-01-01',
    to: '2025-06-30',
    weeks: null,
    invalid: false,
  });
});

test('parseRange falls back to 26 weeks and says so for anything invalid', () => {
  for (const query of [
    'weeks=7',
    'from=2025-01-01',
    'from=2025-06-30&to=2025-01-01',
    'from=<script>&to=2025-01-01',
    'from=2020-01-01&to=2026-11-04',
  ])
    assert.deepEqual(range(query), { ...DEFAULT_RANGE, invalid: true }, query);
});

const page = (
  members: string[],
  overrides: { updatedAt?: string | null; invalid?: boolean } = {},
) =>
  renderPrPage({
    weeks: [
      { week: '2026-W43', counts: { alice: 3, bob: 1, renovate: 9 } },
      { week: '2026-W44', counts: null },
      { week: '2026-W45', counts: { alice: 5 } },
    ],
    members,
    range: { from: '2026-10-19', to: TODAY, weeks: null, invalid: overrides.invalid ?? false },
    today: TODAY,
    updatedAt: overrides.updatedAt === undefined ? '2026-11-03T22:30:00.000Z' : overrides.updatedAt,
  });

test('renderPrPage shows the weekly count, total and average, 0 when a fetched week has none', () => {
  const html = page(['alice', 'bob']);

  assert.match(
    html,
    /<tr><th scope="row">2026-W43<\/th><td>3<\/td><td>1<\/td><td>4<\/td><td>2<\/td><\/tr>/,
  );
  assert.match(
    html,
    /<tr><th scope="row">2026-W45（進行中）<\/th><td>5<\/td><td>0<\/td><td>5<\/td><td>2\.5<\/td><\/tr>/,
  );
});

test('renderPrPage lists the newest week first in the table', () => {
  const html = page(['alice', 'bob']);

  const newest = html.indexOf('<th scope="row">2026-W45（進行中）');
  const oldest = html.indexOf('<th scope="row">2026-W43<');
  assert.ok(newest > 0 && oldest > newest);
});

test('renderPrPage marks a week that was never fetched with a dash, not 0', () => {
  assert.match(
    page(['alice', 'bob']),
    /<tr><th scope="row">2026-W44<\/th><td>—<\/td><td>—<\/td><td>—<\/td><td>—<\/td><\/tr>/,
  );
});

test('renderPrPage draws the current week as a dashed segment and the unfetched stretch as a labeled band', () => {
  const html = page(['alice', 'bob']);

  assert.match(html, /data-pending="alice"/);
  assert.match(html, /data-pending="合計"/);
  assert.match(html, /<rect[^>]*class="gap"/);
  assert.match(html, />未抓取<\/text>/);
});

test('renderPrPage has no average line, only a total line in the team chart', () => {
  const html = page(['alice', 'bob']);

  assert.match(html, /data-member="合計"/);
  assert.doesNotMatch(html, /data-member="人均"/);
  assert.match(html, /<th scope="col">人均<\/th>/);
});

test('renderPrPage leaves out authors who are not members', () => {
  assert.doesNotMatch(page(['alice', 'bob']), /renovate/);
});

test('renderPrPage draws one line per member and breaks it at a missing week', () => {
  const html = page(['alice', 'bob']);

  assert.match(html, /<svg[^>]*role="img"/);
  const alicePath = html.match(/<path[^>]*data-member="alice"[^>]*d="([^"]+)"/)?.[1] ?? '';
  assert.equal((alicePath.match(/M/g) ?? []).length, 1);
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

test('renderPrPage keeps the chosen range in the form and stops dates after today', () => {
  const html = page(['alice']);

  assert.match(html, /name="from" value="2026-10-19" max="2026-11-04"/);
  assert.match(html, /name="to" value="2026-11-04" max="2026-11-04"/);
});

test('renderPrPage tells when the range was invalid and the default was used', () => {
  assert.match(page(['alice'], { invalid: true }), /日期區間無效，已改顯示近 26 週/);
  assert.doesNotMatch(page(['alice']), /日期區間無效/);
});

test('renderPrPage shows when the numbers were last updated, or that they never were', () => {
  assert.match(page(['alice']), /資料更新於 2026-11-04 06:30/);
  assert.match(page(['alice'], { updatedAt: null }), /class="stale"[^>]*>尚無 pr_stats 成功紀錄/);
});

test('renderPrPage keeps chart text readable on a phone and hints that the table scrolls', () => {
  const html = page(['alice']);

  assert.match(html, /@media \(max-width: 40rem\) \{ svg text \{ font-size: 20px; \} \}/);
  assert.match(html, /（— 表示該週尚未抓取）<span class="hint">（可左右捲動）<\/span>/);
});

test('renderPrPage says what is counted and that the count is no measure of contribution', () => {
  const html = page(['alice']);

  assert.match(html, /已合併（merged）的 PR/);
  assert.match(html, /只反映數量，不代表貢獻大小/);
});
