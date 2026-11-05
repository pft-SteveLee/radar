import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIFF_MAX_CHARS,
  isUndescribedLarge,
  type MergedPr,
  type OpenIssue,
  type OpenPr,
  referencedIssues,
  selectForOpus,
  shortRepo,
  staleDrafts,
  staleIssues,
  stuckPrs,
  trimDiff,
  wordCount,
} from '../jobs/devWeeklyRules.ts';

const NOW = new Date('2026-11-09T01:00:00Z');
const MINUTE = 60_000;
const DAY = 86_400_000;
const ago = (milliseconds: number) => new Date(NOW.getTime() - milliseconds).toISOString();

const mergedPr = (overrides: Partial<MergedPr> = {}): MergedPr => ({
  repo: 'o/r',
  number: 1,
  title: 'feat: something',
  url: 'https://github.com/o/r/pull/1',
  body: '',
  additions: 100,
  deletions: 1,
  changedFiles: 3,
  headRefName: 'feature/x',
  baseRefName: 'amp/master',
  createdAt: ago(2 * DAY),
  mergedAt: ago(DAY),
  author: 'alice',
  ...overrides,
});

const openPr = (overrides: Partial<OpenPr> = {}): OpenPr => ({
  repo: 'o/r',
  number: 2,
  title: 'wip',
  url: 'https://github.com/o/r/pull/2',
  body: '',
  headRefName: 'feature/y',
  author: 'bob',
  isDraft: false,
  createdAt: ago(DAY),
  updatedAt: ago(DAY),
  ...overrides,
});

const issue = (overrides: Partial<OpenIssue> = {}): OpenIssue => ({
  repo: 'o/r',
  number: 12,
  title: 'bug',
  url: 'https://github.com/o/r/issues/12',
  author: 'carol',
  createdAt: ago(30 * DAY),
  updatedAt: ago(15 * DAY),
  ...overrides,
});

test('wordCount splits on any whitespace and counts nothing in an empty text', () => {
  assert.equal(wordCount('a  b\nc'), 3);
  assert.equal(wordCount(''), 0);
});

test('isUndescribedLarge needs fewer than 50 words and more than 100 changed lines', () => {
  const words = (count: number) => Array.from({ length: count }, () => 'w').join(' ');
  assert.equal(
    isUndescribedLarge(mergedPr({ body: words(49), additions: 100, deletions: 1 })),
    true,
  );
  assert.equal(
    isUndescribedLarge(mergedPr({ body: words(50), additions: 100, deletions: 1 })),
    false,
  );
  assert.equal(
    isUndescribedLarge(mergedPr({ body: words(49), additions: 99, deletions: 1 })),
    false,
  );
});

test('selectForOpus keeps the 10 largest eligible PRs and reports the rest as skipped', () => {
  const eligible = Array.from({ length: 12 }, (_, index) =>
    mergedPr({ number: index + 1, additions: 200 + index, deletions: 0 }),
  );
  const small = mergedPr({ number: 99, additions: 5, deletions: 0 });
  const { selected, skipped } = selectForOpus([small, ...eligible]);
  assert.equal(selected.length, 10);
  assert.deepEqual(
    selected.map((pr) => pr.number),
    [12, 11, 10, 9, 8, 7, 6, 5, 4, 3],
  );
  assert.deepEqual(
    skipped.map((pr) => pr.number).sort((a, b) => a - b),
    [1, 2],
  );
});

const section = (path: string, body = '+x\n') =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;

test('trimDiff drops lockfiles and generated output but keeps source files', () => {
  const diff = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'public/app.min.js',
    'dist/app.js',
    'build/out.js',
    'src/__snapshots__/a.snap',
    'src/a.ts',
  ]
    .map((path) => section(path))
    .join('');
  const { text, truncated } = trimDiff(diff);
  assert.equal(truncated, false);
  assert.match(text, /src\/a\.ts/);
  for (const dropped of [
    'package-lock',
    'pnpm-lock',
    'yarn.lock',
    '.min.js',
    'dist/',
    'build/',
    '__snapshots__',
  ])
    assert.doesNotMatch(text, new RegExp(dropped.replace('.', '\\.')));
});

test('trimDiff cuts a long diff at the limit and says so', () => {
  const { text, truncated } = trimDiff(section('src/a.ts', `${'x'.repeat(40_000)}\n`));
  assert.equal(truncated, true);
  assert.equal(text.length, DIFF_MAX_CHARS);
});

test('stuckPrs lists non-draft PRs open for more than 3 days, with whole days', () => {
  const stuck = stuckPrs(
    [
      openPr({ number: 1, createdAt: ago(3 * DAY + MINUTE) }),
      openPr({ number: 2, createdAt: ago(3 * DAY) }),
      openPr({ number: 3, createdAt: ago(10 * DAY), isDraft: true }),
    ],
    NOW,
  );
  assert.deepEqual(
    stuck.map(({ pr, days }) => [pr.number, days]),
    [[1, 3]],
  );
});

test('staleDrafts lists drafts without an update for more than 14 days', () => {
  const stale = staleDrafts(
    [
      openPr({ number: 1, isDraft: true, updatedAt: ago(14 * DAY + MINUTE) }),
      openPr({ number: 2, isDraft: true, updatedAt: ago(14 * DAY) }),
      openPr({ number: 3, isDraft: false, updatedAt: ago(30 * DAY) }),
    ],
    NOW,
  );
  assert.deepEqual(
    stale.map(({ pr, days }) => [pr.number, days]),
    [[1, 14]],
  );
});

test('referencedIssues reads #n from titles, bodies and branch names, and owner/repo#n across repos', () => {
  const keys = referencedIssues([
    { repo: 'o/r', title: 'fix: crash (#12)', body: '', headRefName: 'x' },
    { repo: 'o/r', title: 't', body: 'fixes #7', headRefName: 'x' },
    { repo: 'o/r', title: 't', body: '', headRefName: 'issue/#5-login' },
    { repo: 'o/r', title: 't', body: 'see o/other#9', headRefName: 'x' },
  ]);
  assert.deepEqual([...keys].sort(), ['o/other#9', 'o/r#12', 'o/r#5', 'o/r#7']);
});

test('staleIssues lists issues untouched for more than 14 days that no PR mentions', () => {
  const unreferenced = staleIssues([issue()], new Set(), NOW);
  assert.deepEqual(
    unreferenced.map((entry) => [entry.issue.number, entry.days]),
    [[12, 15]],
  );
  assert.equal(staleIssues([issue()], new Set(['o/r#12']), NOW).length, 0);
  assert.equal(staleIssues([issue({ updatedAt: ago(14 * DAY) })], new Set(), NOW).length, 0);
});

test('shortRepo drops the owner', () => {
  assert.equal(shortRepo('perfect-corp/ymk-web-utils'), 'ymk-web-utils');
});
