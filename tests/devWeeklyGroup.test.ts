import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupPrs, normalizeGroups } from '../jobs/devWeekly.ts';
import type { MergedPr } from '../jobs/devWeeklyRules.ts';
import { MODELS } from '../lib/claude.ts';

const mergedPr = (number: number, overrides: Partial<MergedPr> = {}): MergedPr => ({
  repo: 'o/r',
  number,
  title: `pr ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  body: 'body',
  additions: 10,
  deletions: 1,
  changedFiles: 1,
  headRefName: 'feature/x',
  baseRefName: 'amp/workspaces/edm/master',
  createdAt: '2026-11-02T01:00:00Z',
  mergedAt: '2026-11-03T01:00:00Z',
  author: 'alice',
  ...overrides,
});

const merged = [mergedPr(1), mergedPr(2), mergedPr(3), mergedPr(4)];
const numbers = (prs: MergedPr[]) => prs.map((pr) => pr.number);

test('normalizeGroups resolves ids to PRs and keeps the summary and overlap', () => {
  const features = normalizeGroups(
    {
      features: [
        { name: '折扣碼', summary: '購物車支援折扣碼', prs: [0, 1], overlap: '兩人同時改' },
        { name: '監控', summary: '新增權限', prs: [2, 3] },
      ],
    },
    merged,
  );
  assert.deepEqual(
    features.map((feature) => [feature.name, numbers(feature.prs), feature.overlap]),
    [
      ['折扣碼', [1, 2], '兩人同時改'],
      ['監控', [3, 4], undefined],
    ],
  );
});

test('normalizeGroups keeps an id that is listed twice only in its first feature', () => {
  const features = normalizeGroups(
    {
      features: [
        { name: 'a', summary: '', prs: [0, 1] },
        { name: 'b', summary: '', prs: [1, 2, 3] },
      ],
    },
    merged,
  );
  assert.deepEqual(numbers(features[0].prs), [1, 2]);
  assert.deepEqual(numbers(features[1].prs), [3, 4]);
});

test('normalizeGroups drops ids that are out of range, fractional or strings', () => {
  const features = normalizeGroups(
    { features: [{ name: 'a', summary: '', prs: [0, 99, -1, 1.5, '2', 3] }] },
    merged,
  );
  assert.deepEqual(numbers(features[0].prs), [1, 4]);
});

test('normalizeGroups puts PRs the model left out into a final 其他 feature in input order', () => {
  const features = normalizeGroups({ features: [{ name: 'a', summary: 's', prs: [1] }] }, merged);
  assert.deepEqual(
    features.map((feature) => [feature.name, numbers(feature.prs)]),
    [
      ['a', [2]],
      ['其他', [1, 3, 4]],
    ],
  );
});

test('normalizeGroups removes a feature that ends up with no PRs', () => {
  const features = normalizeGroups(
    {
      features: [
        { name: 'empty', summary: '', prs: [] },
        { name: 'all', summary: '', prs: [0, 1, 2, 3] },
      ],
    },
    merged,
  );
  assert.deepEqual(
    features.map((feature) => feature.name),
    ['all'],
  );
});

test('normalizeGroups throws a SyntaxError when there is no features array', () => {
  assert.throws(() => normalizeGroups({ nope: 1 }, merged), SyntaxError);
  assert.throws(() => normalizeGroups(null, merged), SyntaxError);
});

const validAnswer = { features: [{ name: 'a', summary: 's', prs: [0, 1, 2, 3] }] };

function fakeCall(answers: unknown[]) {
  const calls: {
    job: string;
    model: string;
    system: string;
    user: string;
    schema?: object;
    maxTokens?: number;
  }[] = [];
  const call = (async (options: (typeof calls)[number]) => {
    calls.push(options);
    return answers[calls.length - 1];
  }) as never;
  return { calls, deps: { call } };
}

test('groupPrs allows an answer long enough for a week with hundreds of PRs', async () => {
  const { calls, deps } = fakeCall([validAnswer]);
  await groupPrs(merged, {}, null, deps);
  assert.equal(calls[0].maxTokens, 64000);
});

test('groupPrs asks Sonnet with the schema, the context and a compact PR list', async () => {
  const { calls, deps } = fakeCall([validAnswer]);
  const longBody = mergedPr(1, { body: 'x'.repeat(2000) });
  await groupPrs(
    [longBody, ...merged.slice(1)],
    { 'o/r#2': '加入權限檢查' },
    '成員：alice 負責 edm',
    deps,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, MODELS.sonnet);
  assert.equal(calls[0].job, 'dev_weekly');
  assert.ok(calls[0].schema);
  assert.match(calls[0].system, /成員：alice 負責 edm/);
  const sent = JSON.parse(calls[0].user) as {
    id: number;
    repo: string;
    base: string;
    body: string;
    description?: string;
  }[];
  assert.equal(sent[0].id, 0);
  assert.equal(sent[0].repo, 'r');
  assert.equal(sent[0].base, 'amp/workspaces/edm/master');
  assert.equal(sent[0].body.length, 600);
  assert.equal(sent[1].description, '加入權限檢查');
});

test('groupPrs retries once after an invalid answer', async () => {
  const { calls, deps } = fakeCall([{ nope: 1 }, validAnswer]);
  const features = await groupPrs(merged, {}, null, deps);
  assert.equal(calls.length, 2);
  assert.equal(features.length, 1);
});

test('groupPrs fails with a plain Error after two invalid answers', async () => {
  const { deps } = fakeCall([{ nope: 1 }, { nope: 2 }]);
  await assert.rejects(groupPrs(merged, {}, null, deps), (error: Error) => {
    assert.ok(!(error instanceof SyntaxError));
    assert.match(error.message, /兩次/);
    return true;
  });
});

test('groupPrs retries when the call itself throws a SyntaxError for unparseable model output', async () => {
  let attempts = 0;
  const deps = {
    call: (async () => {
      attempts++;
      if (attempts === 1) throw new SyntaxError('Unexpected end of JSON input');
      return validAnswer;
    }) as never,
  };
  const features = await groupPrs(merged, {}, null, deps);
  assert.equal(attempts, 2);
  assert.equal(features.length, 1);
});
