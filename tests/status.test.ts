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

const page = (runs: RunRecord[], totalUsd = 12.4) =>
  renderPage({
    summary: { month: '2026-11', totalUsd, byJob: [{ job: 'reddit_digest', usd: totalUsd }] },
    runs,
    budgetUsd: 100,
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
  assert.match(html, /<progress value="12\.4" max="100"/);
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
