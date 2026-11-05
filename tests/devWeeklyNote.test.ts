import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Feature, type ReportInput, renderReport } from '../jobs/devWeekly.ts';
import type { MergedPr, OpenIssue, OpenPr } from '../jobs/devWeeklyRules.ts';

const mergedPr = (number: number, overrides: Partial<MergedPr> = {}): MergedPr => ({
  repo: 'perfect-corp/ymk-web-utils',
  number,
  title: `pr ${number}`,
  url: `https://github.com/perfect-corp/ymk-web-utils/pull/${number}`,
  body: '',
  additions: 10,
  deletions: 1,
  changedFiles: 1,
  headRefName: 'feature/x',
  baseRefName: 'amp/master',
  createdAt: '2026-11-02T01:00:00Z',
  mergedAt: '2026-11-03T01:00:00Z',
  author: 'alice',
  ...overrides,
});

const openPr = (number: number, overrides: Partial<OpenPr> = {}): OpenPr => ({
  repo: 'perfect-corp/smb-api',
  number,
  title: 'stuck work',
  url: `https://github.com/perfect-corp/smb-api/pull/${number}`,
  body: '',
  headRefName: 'x',
  author: 'bob',
  isDraft: false,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ...overrides,
});

const feature = (prs: MergedPr[], overrides: Partial<Feature> = {}): Feature => ({
  name: '折扣碼',
  summary: '購物車支援折扣碼',
  prs,
  ...overrides,
});

const input = (overrides: Partial<ReportInput> = {}): ReportInput => ({
  mergedCount: 2,
  features: [feature([mergedPr(1), mergedPr(2, { author: 'carol' })])],
  stuck: [],
  staleDrafts: [],
  undescribed: [],
  staleIssues: [],
  repos: ['perfect-corp/ymk-web-utils', 'perfect-corp/smb-api'],
  fetchedAt: '2026-11-09T01:00:00Z',
  ...overrides,
});

test('a feature lists at most 5 PR links, then 另 N 個, and all of its authors', () => {
  const prs = Array.from({ length: 7 }, (_, index) =>
    mergedPr(index + 1, { author: index === 6 ? 'zed' : 'alice' }),
  );
  const text = renderReport(input({ mergedCount: 7, features: [feature(prs)] }));
  assert.match(
    text,
    /\[ymk-web-utils#5\]\(https:\/\/github\.com\/perfect-corp\/ymk-web-utils\/pull\/5\)/,
  );
  assert.doesNotMatch(text, /ymk-web-utils#6\]/);
  assert.match(text, /另 2 個/);
  assert.match(text, /作者：alice、zed/);
  assert.match(text, /上週合併 7 個 PR，2 位作者，1 個 repo/);
});

test('titles with brackets, pipes and backticks cannot break the Markdown', () => {
  const text = renderReport(
    input({ features: [feature([mergedPr(1, { title: 'a [b] | c `d`' })])], mergedCount: 1 }),
  );
  assert.ok(text.includes('a \\[b\\] \\| c \\`d\\`'));
  assert.doesNotMatch(text, /[^\\]\[b\]/);
});

test('empty stuck and anomaly sections print 無', () => {
  const text = renderReport(input());
  assert.match(text, /## 進行中／卡住\n\n無/);
  assert.match(text, /## 異常\n\n無/);
});

test('stuck PRs, stale drafts, undescribed PRs, stale issues and overlap each appear with a link', () => {
  const issue: OpenIssue = {
    repo: 'perfect-corp/smb-api',
    number: 12,
    title: 'login bug',
    url: 'https://github.com/perfect-corp/smb-api/issues/12',
    author: 'dave',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
  };
  const text = renderReport(
    input({
      stuck: [{ pr: openPr(30), days: 8 }],
      staleDrafts: [{ pr: openPr(31, { isDraft: true, title: 'old draft' }), days: 20 }],
      undescribed: [mergedPr(40, { title: 'big change', additions: 500 })],
      staleIssues: [{ issue, days: 20 }],
      features: [feature([mergedPr(1), mergedPr(2)], { overlap: '兩人同時改權限' })],
    }),
  );
  const progress = text.split('## 異常')[0];
  assert.match(progress, /\[smb-api#30\]\(.*\/pull\/30\) stuck work — bob，8 天/);
  assert.match(progress, /\[smb-api#31\]\(.*\/pull\/31\) old draft — bob，.*20 天/);
  const anomalies = text.split('## 異常')[1];
  assert.match(anomalies, /\[ymk-web-utils#40\]\(.*\/pull\/40\) big change/);
  assert.match(anomalies, /\[smb-api#12\]\(.*\/issues\/12\) login bug — dave，20 天/);
  assert.match(anomalies, /折扣碼.*兩人同時改權限/);
  assert.match(anomalies, /ymk-web-utils#1/);
});

test('zero merged PRs prints one line and no totals', () => {
  const text = renderReport(input({ mergedCount: 0, features: [] }));
  assert.match(text, /## 本週完成\n\n本週無合併的 PR/);
  assert.doesNotMatch(text, /上週合併/);
});

test('the footer gives the snapshot time in Asia/Taipei and lists the repos', () => {
  const text = renderReport(input());
  assert.match(text, /2026-11-09 09:00/);
  assert.match(text, /## 已涵蓋的 repo\n\nymk-web-utils、smb-api/);
});
