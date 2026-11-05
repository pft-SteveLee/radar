import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRange, renderPrPage } from '../web/prStats.ts';

const TODAY = '2026-11-04';
const NOW = new Date('2026-11-04T05:00:00Z');
const range = (query: string) => parseRange(new URLSearchParams(query), TODAY);
const DEFAULT_RANGE = { from: '2026-05-13', to: TODAY, weeks: 26, reason: null };

test('parseRange shows the last 26 weeks by default', () => {
  assert.deepEqual(range(''), DEFAULT_RANGE);
});

test('parseRange accepts 12, 26 or 52 weeks', () => {
  assert.deepEqual(range('weeks=52'), {
    from: '2025-11-12',
    to: TODAY,
    weeks: 52,
    reason: null,
  });
  assert.deepEqual(range('weeks=12'), {
    from: '2026-08-19',
    to: TODAY,
    weeks: 12,
    reason: null,
  });
});

test('parseRange accepts a custom from and to', () => {
  assert.deepEqual(range('from=2025-01-01&to=2025-06-30'), {
    from: '2025-01-01',
    to: '2025-06-30',
    weeks: null,
    reason: null,
  });
});

test('parseRange falls back to 26 weeks and names the reason for anything invalid', () => {
  const cases: [string, string][] = [
    ['weeks=7', 'weeks 只接受 12、26、52'],
    ['from=2025-01-01', '日期格式錯誤'],
    ['from=<script>&to=2025-01-01', '日期格式錯誤'],
    ['from=2026-02-31&to=2026-03-10', '日期格式錯誤'],
    ['from=2025-06-30&to=2025-01-01', '起日晚於迄日'],
    ['from=2024-01-01&to=2026-11-04', '最長 2 年'],
  ];
  for (const [query, reason] of cases)
    assert.deepEqual(range(query), { ...DEFAULT_RANGE, reason }, query);
});

test('parseRange treats a to date after today as today', () => {
  assert.deepEqual(range('from=2026-10-01&to=2027-01-01'), {
    from: '2026-10-01',
    to: TODAY,
    weeks: null,
    reason: null,
  });
});

const page = (members: string[], overrides: { updatedAt?: string | null; reason?: string } = {}) =>
  renderPrPage({
    weeks: [
      { week: '2026-W43', counts: { alice: 3, bob: 1, renovate: 9 } },
      { week: '2026-W44', counts: null },
      { week: '2026-W45', counts: { alice: 5 } },
    ],
    members,
    range: {
      from: '2026-10-19',
      to: TODAY,
      weeks: overrides.reason ? DEFAULT_RANGE.weeks : null,
      reason: overrides.reason ?? null,
    },
    today: TODAY,
    now: NOW,
    maxAgeHours: 26,
    updatedAt: overrides.updatedAt === undefined ? '2026-11-03T22:30:00.000Z' : overrides.updatedAt,
  });

test('renderPrPage shows the weekly count, total and average, 0 when a fetched week has none', () => {
  const html = page(['alice', 'bob']);

  assert.match(
    html,
    /<tr><th scope="row">2026-W43<\/th><td>4<\/td><td>2<\/td><td>3<\/td><td>1<\/td><\/tr>/,
  );
  assert.match(
    html,
    /<tr><th scope="row">2026-W45（進行中）<\/th><td>5<\/td><td>2\.5<\/td><td>5<\/td><td>0<\/td><\/tr>/,
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

test('renderPrPage tells why the range was invalid and that the default was used', () => {
  const html = page(['alice'], { reason: '起日晚於迄日' });

  assert.match(html, /起日晚於迄日，已改顯示近 26 週/);
  assert.doesNotMatch(page(['alice']), /已改顯示/);
});

test('renderPrPage shows when the numbers were last updated, or that they never were', () => {
  assert.match(page(['alice']), /資料更新於 2026-11-04 06:30/);
  assert.match(page(['alice'], { updatedAt: null }), /class="stale"[^>]*>尚無 pr_stats 成功紀錄/);
});

test('renderPrPage flags numbers that are older than the limit of the pr_stats job', () => {
  const html = page(['alice'], { updatedAt: '2026-11-02T22:30:00.000Z' });

  assert.match(html, /class="stale"[^>]*>資料更新於 2026-11-03 06:30，已逾時（上限 26 小時）/);
  assert.doesNotMatch(page(['alice']), /已逾時/);
});

test('renderPrPage marks a week the search cut short in the table, the chart and the caption', () => {
  const html = renderPrPage({
    weeks: [
      { week: '2026-W43', counts: { alice: 1000 }, truncated: true },
      { week: '2026-W44', counts: { alice: 3 } },
    ],
    members: ['alice'],
    range: { from: '2026-10-19', to: TODAY, weeks: null, reason: null },
    today: TODAY,
    now: NOW,
    maxAgeHours: 26,
    updatedAt: '2026-11-04T01:00:00.000Z',
  });

  assert.match(html, /<th scope="row">2026-W43（已截斷，數字偏低）<\/th>/);
  assert.match(html, /<title>alice 2026-W43（已截斷，數字偏低）: 1000<\/title>/);
  assert.doesNotMatch(html, /2026-W44（已截斷/);
});

test('renderPrPage keeps the series apart beyond eight members by moving the shape on every round', () => {
  const names = Array.from({ length: 10 }, (_, index) => `m${index + 1}`);
  const html = page(names);
  const shapeOf = (name: string) =>
    html.match(new RegExp(`<li><svg[^>]*>.*?data-shape="(\\w+)".*?</svg>${name}</li>`))?.[1];

  assert.equal(shapeOf('m1'), 'circle');
  assert.equal(shapeOf('m9'), 'square');
  assert.equal(shapeOf('m2'), 'square');
  assert.equal(shapeOf('m10'), 'diamond');
});

test('renderPrPage makes room on the left of the chart for a four digit maximum', () => {
  const axisStart = (html: string) => Number(html.match(/<line x1="(\d+)"[^>]*class="axis"/)?.[1]);
  const wide = renderPrPage({
    weeks: [{ week: '2026-W44', counts: { alice: 1240 } }],
    members: ['alice'],
    range: { from: '2026-10-26', to: TODAY, weeks: null, reason: null },
    today: TODAY,
    now: NOW,
    maxAgeHours: 26,
    updatedAt: null,
  });

  assert.ok(axisStart(wide) > axisStart(page(['alice'])));
});

test('renderPrPage words the invalid range notice without the error color, and keeps gap labels readable', () => {
  const html = page(['alice'], { reason: '日期格式錯誤' });

  assert.match(html, /\.notice \{ font-weight: 600; \}/);
  assert.doesNotMatch(html, /\.notice \{[^}]*var\(--bad\)/);
  assert.match(html, /<text[^>]*class="gap-label"[^>]*>未抓取<\/text>/);
  assert.match(html, /svg\.chart \.gap-label \{ fill: var\(--text\); \}/);
});

test('renderPrPage has landmarks and marks the chosen range as current', () => {
  const html = renderPrPage({
    weeks: [{ week: '2026-W45', counts: { alice: 1 } }],
    members: ['alice'],
    range: { from: '2026-05-13', to: TODAY, weeks: 26, reason: null },
    today: TODAY,
    now: NOW,
    maxAgeHours: 26,
    updatedAt: null,
  });

  assert.match(html, /<main>[\s\S]*<h1>每週 merged PR 數<\/h1>[\s\S]*<\/main>/);
  assert.match(html, /<nav aria-label="頁面"><a href="\/">← 狀態<\/a><\/nav>/);
  assert.match(html, /<nav aria-label="顯示範圍"><a href="\/prs\?weeks=12">12 週<\/a>/);
  assert.match(html, /<strong aria-current="true">26 週<\/strong>/);
});

test('renderPrPage takes series colors from variables that have a dark version', () => {
  const html = page(['alice', 'bob']);

  assert.match(html, /--s1: #2563eb;/);
  assert.match(html, /--s8: #4d7c0f;/);
  assert.match(html, /@media \(prefers-color-scheme: dark\) \{ :root \{ --s1: #60a5fa;/);
  assert.match(html, /stroke:var\(--s1\)/);
  assert.match(html, /stroke:var\(--s2\)/);
  assert.doesNotMatch(html, /stroke="#/);
});

test('renderPrPage tells series apart by marker shape as well as by color', () => {
  const html = page(['alice', 'bob']);

  assert.match(html, /data-shape="circle"/);
  assert.match(html, /data-shape="square"/);
  assert.match(
    html,
    /<li><svg class="swatch"[^>]*aria-hidden="true">.*data-shape="circle".*<\/svg>alice<\/li>/,
  );
});

test('renderPrPage draws the axis line darker and gives controls room to tap', () => {
  const html = page(['alice']);

  assert.match(html, /svg\.chart \.axis \{ stroke: var\(--muted\); \}/);
  assert.match(html, /input, button \{ min-height: 2rem; font: inherit; \}/);
});

test('renderPrPage keeps chart text readable on a phone and hints that the table scrolls', () => {
  const html = page(['alice']);

  assert.match(html, /@media \(max-width: 40rem\) \{ svg\.chart text \{ font-size: 28px; \} \}/);
  assert.match(html, /（— 表示該週尚未抓取）<span class="hint">（可左右捲動）<\/span>/);
});

test('renderPrPage says what is counted and that the count is no measure of contribution', () => {
  const html = page(['alice']);

  assert.match(html, /已合併（merged）的 PR/);
  assert.match(html, /只反映數量，不代表貢獻大小/);
});

test('renderPrPage says a week could not be read, not that it was never fetched', () => {
  const html = renderPrPage({
    weeks: [
      { week: '2026-W43', counts: { alice: 3 } },
      { week: '2026-W44', counts: null, corrupt: true },
      { week: '2026-W45', counts: { alice: 5 } },
    ],
    members: ['alice'],
    range: { from: '2026-10-19', to: TODAY, weeks: null, reason: null },
    today: TODAY,
    now: NOW,
    maxAgeHours: 26,
    updatedAt: '2026-11-03T22:30:00.000Z',
  });

  assert.match(html, /<th scope="row">2026-W44（讀取失敗）<\/th><td>—<\/td>/);
  assert.match(html, /<title>讀取失敗<\/title>/);
  assert.doesNotMatch(html, /<title>未抓取<\/title>/);
});

test('renderPrPage matches member names to author names without regard to case', () => {
  const html = renderPrPage({
    weeks: [{ week: '2026-W45', counts: { alice: 5 } }],
    members: ['Alice'],
    range: { from: '2026-11-02', to: TODAY, weeks: null, reason: null },
    today: TODAY,
    now: NOW,
    maxAgeHours: 26,
    updatedAt: '2026-11-03T22:30:00.000Z',
  });

  assert.match(html, /<th scope="row">2026-W45（進行中）<\/th><td>5<\/td><td>5<\/td>/);
});

const pageOf = (weeks: Parameters<typeof renderPrPage>[0]['weeks']) =>
  renderPrPage({
    weeks,
    members: ['alice'],
    range: { from: '2026-10-19', to: TODAY, weeks: null, reason: null },
    today: TODAY,
    now: NOW,
    maxAgeHours: 26,
    updatedAt: '2026-11-03T22:30:00.000Z',
  });

test('parseRange accepts just under two years and refuses more', () => {
  assert.equal(range('from=2024-11-05&to=2026-11-04').reason, null);
  assert.equal(range('from=2024-11-01&to=2026-11-04').reason, '最長 2 年');
});

test('renderPrPage points to the table from the chart label and a visible line', () => {
  const html = page(['alice']);

  assert.match(
    html,
    /aria-label="團隊每週 merged PR 合計，2026-W43 到 2026-W45（數據見下方表格）"/,
  );
  assert.match(html, /<p class="chart-note">數值見下方表格/);
  assert.match(html, /\.chart-note \{ color: var\(--muted\);/);
});

test('renderPrPage draws grid lines at round values and ends the axis on the top one', () => {
  const html = page(['alice', 'bob']);
  const team = html.slice(0, html.indexOf('</svg>'));

  assert.equal((team.match(/class="grid"/g) ?? []).length, 3);
  for (const label of ['0', '2', '4', '6'])
    assert.match(team, new RegExp(`text-anchor="end"[^>]*>${label}</text>`));
  assert.match(html, /svg\.chart \.grid \{ stroke: var\(--line\); \}/);
});

test('renderPrPage labels five evenly spaced weeks along the bottom', () => {
  const weeks = Array.from({ length: 9 }, (_, index) => ({
    week: `2026-W${String(37 + index).padStart(2, '0')}`,
    counts: { alice: index },
  }));
  const html = pageOf(weeks);
  const team = html.slice(0, html.indexOf('</svg>'));
  const labels = [...team.matchAll(/y="2\d\d(?:\.\d)?"[^>]*>(2026-W\d\d)<\/text>/g)].map(
    (m) => m[1],
  );

  assert.deepEqual(labels, ['2026-W37', '2026-W39', '2026-W41', '2026-W43', '2026-W45']);
});

test('renderPrPage draws a lone week in the middle with one label', () => {
  const html = pageOf([{ week: '2026-W44', counts: { alice: 5 } }]);
  const team = html.slice(0, html.indexOf('</svg>'));

  assert.match(team, /<circle cx="420\.0"/);
  assert.equal((team.match(/>2026-W44<\/text>/g) ?? []).length, 1);
});

test('renderPrPage draws a truncated week as an open point with no line to its neighbours', () => {
  const html = pageOf([
    { week: '2026-W42', counts: { alice: 3 } },
    { week: '2026-W43', counts: { alice: 1000 }, truncated: true },
    { week: '2026-W44', counts: { alice: 4 } },
  ]);
  const path = html.match(/<path[^>]*data-member="alice"[^>]*d="([^"]+)"/)?.[1] ?? '';

  assert.match(html, /data-truncated="true"[^>]*style="fill:var\(--bg\)/);
  assert.equal((path.match(/M/g) ?? []).length, 2);
  assert.doesNotMatch(path, /L/);
  assert.match(html, /空心點＝進行中或已截斷/);
});

test('renderPrPage explains the open points only when the range has such a week', () => {
  assert.doesNotMatch(pageOf([{ week: '2026-W43', counts: { alice: 3 } }]), /空心點/);
  assert.match(page(['alice']), /空心點＝進行中或已截斷/);
});

const pageWithRange = (weeks: number | null) =>
  renderPrPage({
    weeks: [{ week: '2026-W45', counts: { alice: 1 } }],
    members: ['alice'],
    range: { from: '2026-10-19', to: TODAY, weeks, reason: null },
    today: TODAY,
    now: NOW,
    maxAgeHours: 26,
    updatedAt: null,
  });

test('renderPrPage puts the team total and average right after the week column', () => {
  assert.match(
    page(['alice', 'bob']),
    /<th scope="col">週<\/th><th scope="col">合計<\/th><th scope="col">人均<\/th><th scope="col">alice<\/th><th scope="col">bob<\/th>/,
  );
});

test('renderPrPage lets the table scroll by keyboard and keeps the week column in view', () => {
  const html = page(['alice']);

  assert.match(
    html,
    /<div class="scroll" tabindex="0" role="region" aria-label="每週 merged PR 數"><table>/,
  );
  assert.match(
    html,
    /th\[scope="row"\] \{ white-space: nowrap; position: sticky; left: 0; background: var\(--bg\); \}/,
  );
});

test('renderPrPage marks a custom range as the current choice and leaves the presets as links', () => {
  const custom = pageWithRange(null);

  assert.match(custom, /<strong aria-current="true">自訂 2026-10-19 – 2026-11-04<\/strong>/);
  assert.match(custom, /<a href="\/prs\?weeks=26">26 週<\/a>/);
  assert.doesNotMatch(pageWithRange(26), /自訂 2026/);
});

test('renderPrPage says the average uses the current member list', () => {
  assert.match(page(['alice']), /<caption>[^<]*人均以目前成員名單計算/);
});

test('renderPrPage puts the note about what is counted right under the title, before the update line', () => {
  const html = page(['alice']);
  const note = html.indexOf('只反映數量');

  assert.match(html, /<small class="caveat">統計已合併/);
  assert.ok(html.indexOf('</h1>') < note && note < html.indexOf('資料更新於'));
});

test('renderPrPage says when the page was made', () => {
  assert.match(page(['alice']), /<\/main>\s*<footer>頁面產生於 2026-11-04 13:00<\/footer>/);
});
