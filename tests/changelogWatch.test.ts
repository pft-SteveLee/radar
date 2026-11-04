import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangeItem } from '../jobs/changelogSources.ts';
import { type Deps, triageItem } from '../jobs/changelogWatch.ts';
import { MODELS } from '../lib/claude.ts';

const item: ChangeItem = {
  source: 'orca',
  title: 'stablyai/orca v1.4.248',
  url: 'https://github.com/stablyai/orca/releases/tag/v1.4.248',
  version: 'v1.4.248',
  text: '- Faster terminals\n- Deprecates the legacy chat API',
};

interface CallOptions {
  job: string;
  model: string;
  system: string;
  user: string;
  schema?: object;
}

function triageDeps(answers: (() => unknown)[]) {
  const calls: CallOptions[] = [];
  const deps = {
    call: (async (options: CallOptions) => {
      calls.push(options);
      return answers[calls.length - 1]();
    }) as never,
  } as unknown as Deps;
  return { deps, calls };
}

const validAnswer = {
  changes: [
    { text: 'Faster terminals', category: '新功能', importance: 2 },
    { text: 'Legacy chat API deprecated', category: '棄用', importance: 3 },
  ],
};

test('triageItem sends the item to Haiku with the schema and copies source, version and url from the item', async () => {
  const { deps, calls } = triageDeps([() => validAnswer]);
  const changes = await triageItem(item, deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, MODELS.haiku);
  assert.equal(calls[0].job, 'changelog_watch');
  assert.ok(calls[0].schema);
  assert.ok(calls[0].system.length > 0);
  assert.match(calls[0].user, /Faster terminals/);
  assert.deepEqual(changes, [
    {
      source: 'orca',
      version: 'v1.4.248',
      url: item.url,
      text: 'Faster terminals',
      category: '新功能',
      importance: 2,
    },
    {
      source: 'orca',
      version: 'v1.4.248',
      url: item.url,
      text: 'Legacy chat API deprecated',
      category: '棄用',
      importance: 3,
    },
  ]);
});

test('unknown category becomes 其他 and importance is clamped to 0-3', async () => {
  const { deps } = triageDeps([
    () => ({
      changes: [
        { text: 'a', category: 'security', importance: 7 },
        { text: 'b', category: '修正', importance: -2 },
        { text: 'c', category: '修正', importance: 1.6 },
      ],
    }),
  ]);
  const changes = await triageItem(item, deps);
  assert.deepEqual(
    changes?.map(({ category, importance }) => [category, importance]),
    [
      ['其他', 3],
      ['修正', 0],
      ['修正', 2],
    ],
  );
});

test('two invalid answers return null', async () => {
  const { deps, calls } = triageDeps([() => ({ items: [] }), () => 'not an object']);
  assert.equal(await triageItem(item, deps), null);
  assert.equal(calls.length, 2);
});

test('first invalid then valid answer returns the changes', async () => {
  const { deps, calls } = triageDeps([() => ({ changes: 'oops' }), () => validAnswer]);
  const changes = await triageItem(item, deps);
  assert.equal(changes?.length, 2);
  assert.equal(calls.length, 2);
});

test('an error that is not a SyntaxError is rethrown', async () => {
  const { deps } = triageDeps([
    () => {
      throw new Error('API down');
    },
  ]);
  await assert.rejects(triageItem(item, deps), new Error('API down'));
});
