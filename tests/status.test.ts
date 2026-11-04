import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CostLine } from '../lib/claude.ts';
import type { RunRecord } from '../lib/runLog.ts';
import { renderPage, summarizeMonth } from '../web/status.ts';

const costLine = (ts: string, job: string, usd: number): CostLine => ({
  ts,
  job,
  model: 'm',
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  usd,
});

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  job: 'reddit_digest',
  startedAt: '2026-11-03T23:30:00.000Z',
  finishedAt: '2026-11-03T23:31:30.000Z',
  status: 'ok',
  error: null,
  warnings: [],
  costUsd: 0.05,
  url: 'https://codimd.test/radar-reddit-2026-11-04',
  ...overrides,
});

const page = (runs: RunRecord[], totalUsd = 12.4, now = '2026-11-04T05:00:00Z') =>
  renderPage({
    summary: { month: '2026-11', totalUsd, byJob: [{ job: 'reddit_digest', usd: totalUsd }] },
    runs,
    budgetUsd: 100,
    now: new Date(now),
    maxAgeHours: { reddit_digest: 26 },
  });

test('summarizeMonth counts only this month in Taipei time, per job, biggest first', () => {
  const lines = [
    costLine('2026-10-31T15:59:00Z', 'a', 50),
    costLine('2026-10-31T16:30:00Z', 'a', 1),
    costLine('2026-11-04T01:00:00Z', 'b', 3),
    costLine('2026-11-04T02:00:00Z', 'a', 1),
  ];

  const summary = summarizeMonth(lines, new Date('2026-11-04T03:00:00Z'));

  assert.equal(summary.month, '2026-11');
  assert.equal(summary.totalUsd, 5);
  assert.deepEqual(summary.byJob, [
    { job: 'b', usd: 3 },
    { job: 'a', usd: 2 },
  ]);
});

test('summarizeMonth has no jobs and a zero total without any cost line', () => {
  assert.deepEqual(summarizeMonth([], new Date('2026-11-04T03:00:00Z')), {
    month: '2026-11',
    totalUsd: 0,
    byJob: [],
  });
});

test('renderPage shows the month cost against the budget with a progress bar', () => {
  const html = page([]);

  assert.match(html, /\$12\.40 \/ \$100（12%）/);
  assert.match(html, /<progress value="12\.40" max="100"/);
});

test('renderPage lists the cost of every job this month', () => {
  assert.match(page([]), /reddit_digest[\s\S]*\$12\.40/);
});

test('renderPage shows a run with Taipei start time, duration, cost and a link to the note', () => {
  const html = page([run()]);

  assert.match(html, /2026-11-04 07:30/);
  assert.match(html, /1 分 30 秒/);
  assert.match(html, /\$0\.05/);
  assert.match(html, /<a href="https:\/\/codimd\.test\/radar-reddit-2026-11-04"/);
});

test('renderPage marks a failed run and shows its error', () => {
  const html = page([run({ status: 'failed', error: 'CodiMD down', url: null })]);

  assert.match(html, /class="failed"/);
  assert.match(html, /CodiMD down/);
});

test('renderPage puts the error of a failed run in its own full-width row', () => {
  const html = page([run({ status: 'failed', error: 'CodiMD login failed', url: null })]);

  assert.match(html, /<td>失敗<\/td>/);
  assert.match(
    html,
    /<tr class="failed"><td colspan="7" class="error">CodiMD login failed<\/td><\/tr>/,
  );
});

test('renderPage tells narrow screens that the run table scrolls sideways', () => {
  const html = page([run()]);

  assert.match(html, /<caption>最近 1 次執行<span class="hint">（可左右捲動）<\/span><\/caption>/);
  assert.match(html, /@media \(max-width: 40rem\) \{ \.hint \{ display: inline; \} \}/);
});

test('renderPage shows the number of warnings of a run', () => {
  assert.match(page([run({ warnings: ['a', 'b'] })]), /警告 2/);
});

test('renderPage escapes HTML coming from error messages', () => {
  const html = page([run({ status: 'failed', error: '<script>alert(1)</script>', url: null })]);

  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('renderPage does not turn a non-http url into a link', () => {
  const html = page([run({ url: 'javascript:alert(1)' })]);

  assert.doesNotMatch(html, /href="javascript:/);
});

test('renderPage says so when there are no runs yet', () => {
  assert.match(page([]), /尚無執行紀錄/);
});

test('renderPage shows how long ago a job last succeeded, not stale within its limit', () => {
  const html = page([run()]);

  assert.match(html, /reddit_digest 上次成功：5 小時前（2026-11-04 07:30）/);
  assert.doesNotMatch(html, /class="stale"/);
});

test('renderPage flags a job whose last success is older than its limit', () => {
  const html = page([run()], 12.4, '2026-11-05T09:00:00Z');

  assert.match(html, /class="stale"[^>]*>reddit_digest 上次成功：33 小時前/);
  assert.match(html, /已逾時/);
});

test('renderPage ignores a failed run when measuring the last success', () => {
  const html = page([
    run({ status: 'failed', error: 'x', url: null, startedAt: '2026-11-04T04:00:00.000Z' }),
    run(),
  ]);

  assert.match(html, /reddit_digest 上次成功：5 小時前/);
});

test('renderPage flags a job that has never succeeded', () => {
  const html = page([run({ status: 'failed', error: 'x', url: null })]);

  assert.match(html, /class="stale"[^>]*>reddit_digest 尚無成功紀錄/);
});

test('renderPage declares light and dark form controls, landmarks and roomy links', () => {
  const html = page([run()]);

  assert.match(html, /color-scheme: light dark/);
  assert.match(html, /<main>[\s\S]*<h1>radar 狀態<\/h1>[\s\S]*<\/main>/);
  assert.match(html, /<nav aria-label="頁面"><a href="\/prs">PR 趨勢<\/a><\/nav>/);
  assert.match(html, /nav a \{ display: inline-block; padding: 0\.4rem 0\.5rem; \}/);
  assert.match(html, /nav strong \{ display: inline-block; padding: 0\.4rem 0\.5rem; \}/);
  assert.match(html, /th\[scope="row"\] \{ white-space: nowrap; \}/);
});

test('renderPage keeps a link in a failed row readable on the red wash', () => {
  assert.match(page([run()]), /tr\.failed a \{ color: inherit; text-decoration: underline; \}/);
});

test('renderPage gives the latest failure and the limit next to an overdue job', () => {
  const html = page(
    [
      run({
        status: 'failed',
        error: 'CodiMD login failed: HTTP 502',
        url: null,
        startedAt: '2026-11-04T23:30:00.000Z',
      }),
      run(),
    ],
    12.4,
    '2026-11-05T09:00:00Z',
  );

  assert.match(
    html,
    /class="stale"[^>]*>reddit_digest 上次成功：33 小時前（2026-11-04 07:30），已逾時（上限 26 小時），最近一次：2026-11-05 07:30 失敗：CodiMD login failed: HTTP 502/,
  );
});

test('renderPage names the failure of a job that has never succeeded', () => {
  const html = page([run({ status: 'failed', error: 'boom', url: null })]);

  assert.match(html, /尚無成功紀錄，已逾時（上限 26 小時），最近一次：.*失敗：boom/);
});

test('renderPage shows no failure next to a job whose latest run succeeded', () => {
  const html = page([
    run(),
    run({ status: 'failed', error: 'old', url: null, startedAt: '2026-11-02T00:00:00.000Z' }),
  ]);

  assert.doesNotMatch(html, /最近一次/);
});

test('renderPage lets the warnings of a run be opened and escapes them', () => {
  const html = page([run({ warnings: ['feed <a> failed', 'second'] })]);

  assert.match(html, /<details><summary>警告 2<\/summary><ul><li>feed &lt;a&gt; failed<\/li>/);
});

test('renderPage shows a spend under one percent as less than one percent, not 0', () => {
  assert.match(page([], 0.23), /\$0\.23 \/ \$100（&lt;1%）/);
  assert.match(page([], 0), /\$0\.00 \/ \$100（0%）/);
});

test('renderPage marks a spend above the budget in the correction color with words', () => {
  assert.match(page([], 120), /class="over"[^>]*>\$120\.00 \/ \$100（120%），已超支 \$20\.00/);
  assert.doesNotMatch(page([], 12.4), /class="over"/);
});

const pageWith = (runs: RunRecord[], byJob: { job: string; usd: number }[]) =>
  renderPage({
    summary: {
      month: '2026-11',
      totalUsd: byJob.reduce((total, entry) => total + entry.usd, 0),
      byJob,
    },
    runs,
    budgetUsd: 100,
    now: new Date('2026-11-04T05:00:00Z'),
    maxAgeHours: { reddit_digest: 26 },
  });

test('renderPage lists a job that has runs or cost but no freshness limit, without the error color', () => {
  const html = pageWith(
    [run(), run({ job: 'changelog_watch' })],
    [
      { job: 'reddit_digest', usd: 1 },
      { job: 'dev_weekly', usd: 2 },
    ],
  );

  assert.match(html, /<li class="unmonitored">changelog_watch 未設定新鮮度上限<\/li>/);
  assert.match(html, /<li class="unmonitored">dev_weekly 未設定新鮮度上限<\/li>/);
  assert.doesNotMatch(html, /reddit_digest 未設定/);
  assert.doesNotMatch(html, /\.unmonitored \{[^}]*var\(--bad\)/);
});

test('renderPage keeps a long error out of the freshness line and in the run row', () => {
  const error = 'x'.repeat(200);
  const failed = run({
    status: 'failed',
    error,
    url: null,
    startedAt: '2026-11-04T23:30:00.000Z',
  });
  const html = page([failed, run()], 12.4, '2026-11-05T09:00:00Z');

  assert.match(html, /<li class="stale">[^<]*失敗：x{80}…<\/li>/);
  assert.match(html, /<td colspan="7" class="error">x{200}<\/td>/);
});

test('renderPage puts the cost table in a scroll container and says when nothing was spent', () => {
  assert.match(page([run()]), /<div class="scroll"><table>\s*<caption>各 job 本月花費/);
  assert.match(pageWith([], []), /本月尚無花費/);
  assert.doesNotMatch(pageWith([], []), /各 job 本月花費/);
});

test('renderPage lets long text wrap, keeps targets roomy and aligns numbers', () => {
  const html = page([run()]);

  assert.match(html, /\.freshness li \{ padding: 0\.4rem 0\.6rem; overflow-wrap: anywhere; \}/);
  assert.match(html, /td a \{ display: inline-block; min-height: 1\.5rem; white-space: nowrap; \}/);
  assert.match(
    html,
    /summary \{ display: list-item; min-height: 1\.5rem; white-space: nowrap; cursor: pointer; \}/,
  );
  assert.match(html, /td \{ font-variant-numeric: tabular-nums; \}/);
});
