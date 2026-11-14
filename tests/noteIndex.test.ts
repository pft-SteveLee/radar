import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { renderIndex, withIndex } from '../lib/noteIndex.ts';
import { type RunRecord, recordRun } from '../lib/runLog.ts';

const run = (job: string, startedAt: string, url: string | null, status = 'ok'): RunRecord => ({
  job,
  startedAt,
  finishedAt: startedAt,
  status: status as RunRecord['status'],
  error: null,
  warnings: [],
  costUsd: 0,
  url,
});

const noteUrl = (alias: string) => `https://codimd.test/${alias}`;

test('renderIndex has one section per job with the newest note first', () => {
  const text = renderIndex([
    run('reddit_digest', '2026-11-03T00:00:00Z', noteUrl('radar-reddit-2026-11-03')),
    run('changelog_watch', '2026-11-04T00:00:00Z', noteUrl('radar-changelog-2026-W45')),
    run('reddit_digest', '2026-11-04T00:00:00Z', noteUrl('radar-reddit-2026-11-04')),
  ]);
  assert.match(text, /## Reddit 摘要/);
  assert.match(text, /## Changelog 週報/);
  assert.ok(text.indexOf('radar-reddit-2026-11-04') < text.indexOf('radar-reddit-2026-11-03'));
  assert.match(
    text,
    /- 2026-11-04 \[radar-changelog-2026-W45\]\(https:\/\/codimd\.test\/radar-changelog-2026-W45\)/,
  );
});

test('renderIndex titles the dev_weekly section 開發週報', () => {
  const text = renderIndex([
    run('dev_weekly', '2026-11-09T01:00:00Z', noteUrl('radar-dev-weekly-2026-W45')),
  ]);
  assert.match(text, /## 開發週報/);
  assert.doesNotMatch(text, /## dev_weekly/);
});

test('renderIndex titles the daily_report section 個人日報', () => {
  const text = renderIndex([
    run('daily_report', '2026-11-16T00:30:00Z', noteUrl('radar-daily-2026-11-16')),
  ]);
  assert.match(text, /## 個人日報/);
});

test('renderIndex groups the notes of a job by Taipei month, newest month first', () => {
  const text = renderIndex([
    run('reddit_digest', '2026-10-30T00:00:00Z', noteUrl('october')),
    run('reddit_digest', '2026-10-31T20:00:00Z', noteUrl('first-of-november')),
    run('reddit_digest', '2026-11-04T00:00:00Z', noteUrl('november')),
  ]);
  assert.equal(
    text,
    [
      '# radar 筆記索引',
      '',
      '## Reddit 摘要',
      '',
      '### 2026-11',
      '',
      '- 2026-11-04 [november](https://codimd.test/november)',
      '- 2026-11-01 [first-of-november](https://codimd.test/first-of-november)',
      '',
      '### 2026-10',
      '',
      '- 2026-10-30 [october](https://codimd.test/october)',
      '',
    ].join('\n'),
  );
});

test('renderIndex keeps the six months up to the newest note, of every job', () => {
  const runs = [4, 5, 6, 7, 8, 9, 10].map((month) =>
    run('reddit_digest', new Date(Date.UTC(2026, month, 10)).toISOString(), noteUrl(`m${month}`)),
  );
  const text = renderIndex([
    ...runs,
    run('dev_weekly', '2026-01-05T00:00:00Z', noteUrl('old-weekly')),
  ]);
  assert.deepEqual(text.match(/^### .*/gm), [
    '### 2026-11',
    '### 2026-10',
    '### 2026-09',
    '### 2026-08',
    '### 2026-07',
    '### 2026-06',
  ]);
  assert.doesNotMatch(text, /old-weekly|開發週報/);
});

test('renderIndex leaves out runs without a note and failed runs', () => {
  const text = renderIndex([
    run('pr_stats', '2026-11-04T00:00:00Z', null),
    run('reddit_digest', '2026-11-04T00:00:00Z', noteUrl('failed-note'), 'failed'),
  ]);
  assert.doesNotMatch(text, /pr_stats/);
  assert.doesNotMatch(text, /failed-note/);
});

test('renderIndex shows a note published twice once, with the latest date', () => {
  const url = noteUrl('radar-changelog-2026-W45');
  const text = renderIndex([
    run('changelog_watch', '2026-11-03T00:00:00Z', url),
    run('changelog_watch', '2026-11-06T00:00:00Z', url),
  ]);
  assert.equal(text.match(/^- /gm)?.length, 1);
  assert.match(text, /- 2026-11-06 /);
});

test('renderIndex dates are in Taipei time', () => {
  const text = renderIndex([run('reddit_digest', '2026-11-04T20:00:00Z', noteUrl('a'))]);
  assert.match(text, /- 2026-11-05 /);
});

test('renderIndex uses the job name for a job without a title', () => {
  const text = renderIndex([run('amp_compare', '2026-11-04T00:00:00Z', noteUrl('a'))]);
  assert.match(text, /## amp_compare/);
});

function makePublish(result: { status: string } | Error = { status: 'written' }) {
  const published: { alias: string; markdown: string }[] = [];
  const publish = (async (alias: string, markdown: string) => {
    if (result instanceof Error) throw result;
    published.push({ alias, markdown });
    return { url: noteUrl(alias), status: result.status };
  }) as never;
  return { publish, published };
}

beforeEach(() => {
  process.env.OUTPUT_DIR = mkdtempSync(join(tmpdir(), 'note-index-'));
});

test('withIndex publishes radar-index with earlier notes and this run, which is not yet in runs.jsonl', async () => {
  await recordRun('reddit_digest', async () => ({ url: noteUrl('earlier-note'), warnings: [] }));
  const { publish, published } = makePublish();
  const result = await withIndex(
    'changelog_watch',
    async () => ({ url: noteUrl('this-note'), warnings: ['w'] }),
    publish,
  )();
  assert.deepEqual(result, { url: noteUrl('this-note'), warnings: ['w'] });
  assert.equal(published.length, 1);
  assert.equal(published[0].alias, 'radar-index');
  assert.match(published[0].markdown, /earlier-note/);
  assert.match(published[0].markdown, /this-note/);
});

test('withIndex publishes nothing when the run produced no note', async () => {
  const { publish, published } = makePublish();
  const result = await withIndex(
    'changelog_watch',
    async () => ({ url: null, warnings: [] }),
    publish,
  )();
  assert.deepEqual(result, { url: null, warnings: [] });
  assert.equal(published.length, 0);
});

test('a failed index publish becomes a warning and keeps the url and warnings of the job', async () => {
  const { publish } = makePublish(new Error('CodiMD down'));
  const result = await withIndex(
    'changelog_watch',
    async () => ({ url: noteUrl('this-note'), warnings: ['w'] }),
    publish,
  )();
  assert.equal(result.url, noteUrl('this-note'));
  assert.equal(result.warnings[0], 'w');
  assert.match(result.warnings[1], /radar-index.*CodiMD down/);
});

test('an index edited on the web adds a warning', async () => {
  const { publish } = makePublish({ status: 'editedOnWeb' });
  const result = await withIndex(
    'changelog_watch',
    async () => ({ url: noteUrl('this-note'), warnings: [] }),
    publish,
  )();
  assert.match(result.warnings[0], /radar-index/);
});

test('an error from the job propagates and publishes nothing', async () => {
  const { publish, published } = makePublish();
  await assert.rejects(
    withIndex(
      'changelog_watch',
      async () => {
        throw new Error('job failed');
      },
      publish,
    )(),
    new Error('job failed'),
  );
  assert.equal(published.length, 0);
});
