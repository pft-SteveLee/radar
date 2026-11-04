import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import type { ChangeItem } from '../jobs/changelogSources.ts';
import { type Config, type Deps, run, triageItem } from '../jobs/changelogWatch.ts';
import { MODELS } from '../lib/claude.ts';
import { load, save } from '../lib/state.ts';

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

const longItem: ChangeItem = {
  ...item,
  text: Array.from(
    { length: 40 },
    (_, index) => `${String(index).padStart(2, '0')}${'x'.repeat(997)}\n`,
  ).join(''),
};
const oneChange = (text: string) => ({ changes: [{ text, category: '修正', importance: 1 }] });

test('a long item is split into chunks of at most 15000 characters, one Haiku call each, changes merged in order', async () => {
  const { deps, calls } = triageDeps([
    () => oneChange('first'),
    () => oneChange('second'),
    () => oneChange('third'),
  ]);
  const changes = await triageItem(longItem, deps);
  assert.equal(calls.length, 3);
  const texts = calls.map((callOptions) => (JSON.parse(callOptions.user) as { text: string }).text);
  assert.ok(texts.every((text) => text.length <= 15_000));
  assert.equal(texts.join(''), longItem.text);
  assert.deepEqual(
    changes?.map((change) => change.text),
    ['first', 'second', 'third'],
  );
});

test('a chunk with two invalid answers makes the whole item null', async () => {
  const { deps, calls } = triageDeps([() => oneChange('first'), () => ({}), () => ({})]);
  assert.equal(await triageItem(longItem, deps), null);
  assert.equal(calls.length, 3);
});

const config: Config = {
  token: 'test-token',
  sources: [
    { id: 'tool', kind: 'githubReleases', repo: 'acme/tool' },
    { id: 'docs', kind: 'markdown', url: 'https://docs.test/a.md' },
  ],
};
const WEEK = '2026-W45';
const ALIAS = `radar-changelog-${WEEK}`;
const SEEDED_TOOL = { lastPublishedAt: '2026-11-01T00:00:00Z' };
const SEEDED_DOCS = { text: '# Docs\n' };

const newRelease = {
  tag_name: 'v9',
  html_url: 'https://github.com/acme/tool/releases/tag/v9',
  body: 'big news',
  published_at: '2026-11-05T00:00:00Z',
  draft: false,
  prerelease: false,
};

let stateDir: string;
let outputDir: string;
let configDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'changelog-state-'));
  outputDir = mkdtempSync(join(tmpdir(), 'changelog-output-'));
  configDir = mkdtempSync(join(tmpdir(), 'changelog-config-'));
  process.env.STATE_DIR = stateDir;
  process.env.OUTPUT_DIR = outputDir;
  process.env.CONFIG_DIR = configDir;
});

const seedState = (sources: ('tool' | 'docs')[] = ['tool', 'docs']) => {
  if (sources.includes('tool')) save('changelog/tool', SEEDED_TOOL);
  if (sources.includes('docs')) save('changelog/docs', SEEDED_DOCS);
};

type Payload = { source: string; text: string };

function makeWorld() {
  const world = {
    releases: [] as object[],
    releasesStatus: 200,
    docsText: '# Docs\n',
    docsStatus: 200,
    publishFails: false,
    triage: ((payload: Payload) => ({
      changes: [{ text: payload.text, category: '新功能', importance: 2 }],
    })) as (payload: Payload) => unknown,
  };
  const calls: CallOptions[] = [];
  const published: { alias: string; markdown: string }[] = [];
  const deps = {
    fetch: (async (url: string) =>
      url.includes('/releases')
        ? new Response(JSON.stringify(world.releases), { status: world.releasesStatus })
        : new Response(world.docsText, { status: world.docsStatus })) as unknown as typeof fetch,
    now: () => new Date('2026-11-06T01:00:00Z'),
    call: (async (options: CallOptions) => {
      calls.push(options);
      return options.model === MODELS.haiku
        ? world.triage(JSON.parse(options.user))
        : '## 摘要\n\n- 重點';
    }) as never,
    publish: (async (alias: string, markdown: string) => {
      if (world.publishFails) throw new Error('CodiMD down');
      published.push({ alias, markdown });
      return { url: `https://codimd.test/${alias}`, status: 'written' };
    }) as never,
  } as unknown as Deps;
  return { world, deps, calls, published };
}

const sonnetCalls = (calls: CallOptions[]) =>
  calls.filter((callOptions) => callOptions.model === MODELS.sonnet);

test('nothing changed: no model call, the note says 本週無重大更新 and lists the sources checked', async () => {
  seedState();
  const { deps, calls, published } = makeWorld();
  const result = await run({ upload: true, config }, deps);
  assert.equal(calls.length, 0);
  assert.equal(published.length, 1);
  assert.equal(published[0].alias, ALIAS);
  assert.equal(result.url, `https://codimd.test/${ALIAS}`);
  assert.match(published[0].markdown, /本週無重大更新/);
  assert.match(published[0].markdown, /## 已檢查的來源\n\n- tool\n- docs/);
});

test('Sonnet gets only changes with importance >= 1, urgent ones (棄用/價格) apart from the others', async () => {
  seedState();
  const { world, deps, calls, published } = makeWorld();
  world.releases = [newRelease];
  world.triage = () => ({
    changes: [
      { text: 'price change', category: '價格', importance: 3 },
      { text: 'small feature', category: '新功能', importance: 1 },
      { text: 'tiny fix', category: '修正', importance: 0 },
    ],
  });
  await run({ upload: true, config }, deps);
  const sonnet = sonnetCalls(calls);
  assert.equal(sonnet.length, 1);
  const payload = JSON.parse(sonnet[0].user) as {
    urgent: { text: string }[];
    others: { text: string }[];
  };
  assert.deepEqual(
    payload.urgent.map((change) => change.text),
    ['price change'],
  );
  assert.deepEqual(
    payload.others.map((change) => change.text),
    ['small feature'],
  );
  assert.match(published[0].markdown, /## 摘要/);
});

test('all changes importance 0: no Sonnet call, the note says 本週無重大更新', async () => {
  seedState();
  const { world, deps, calls, published } = makeWorld();
  world.releases = [newRelease];
  world.triage = () => ({ changes: [{ text: 'tiny fix', category: '修正', importance: 0 }] });
  await run({ upload: true, config }, deps);
  assert.equal(sonnetCalls(calls).length, 0);
  assert.match(published[0].markdown, /本週無重大更新/);
});

test('a failed source: warning at the top, other sources still run, its state is not advanced', async () => {
  seedState(['tool']);
  const { world, deps, published } = makeWorld();
  world.releases = [newRelease];
  world.docsStatus = 500;
  const result = await run({ upload: true, config }, deps);
  assert.match(published[0].markdown, /> ⚠️ docs: HTTP 500/);
  assert.ok(result.warnings.includes('docs: HTTP 500'));
  assert.deepEqual(load('changelog/tool', null), { lastPublishedAt: newRelease.published_at });
  assert.equal(load('changelog/docs', null), null);
});

test('all sources failed: run rejects', async () => {
  const { world, deps } = makeWorld();
  world.releasesStatus = 403;
  world.docsStatus = 500;
  await assert.rejects(run({ upload: true, config }, deps), new Error('tool: HTTP 403'));
});

test('baselined sources are listed under 已建立基準 and their state is saved', async () => {
  seedState(['tool']);
  const { deps, published } = makeWorld();
  await run({ upload: true, config }, deps);
  assert.match(published[0].markdown, /## 已建立基準\n\n- docs/);
  assert.deepEqual(load('changelog/docs', null), SEEDED_DOCS);
});

test('upload false: nothing published, state not advanced, the note file is still written', async () => {
  seedState();
  const { world, deps, published } = makeWorld();
  world.releases = [newRelease];
  const result = await run({ upload: false, config }, deps);
  assert.equal(published.length, 0);
  assert.equal(result.url, null);
  assert.ok(existsSync(join(outputDir, 'changelog', `${WEEK}.md`)));
  assert.deepEqual(load('changelog/tool', null), SEEDED_TOOL);
  assert.equal(load(`changelog/weeks/${WEEK}`, null), null);
});

test('publish fails: nothing is saved, so the next run collects the same items again', async () => {
  seedState();
  const { world, deps } = makeWorld();
  world.releases = [newRelease];
  world.publishFails = true;
  await assert.rejects(run({ upload: true, config }, deps), new Error('CodiMD down'));
  assert.deepEqual(load('changelog/tool', null), SEEDED_TOOL);
  assert.equal(load(`changelog/weeks/${WEEK}`, null), null);
});

test('rerun in the same week with nothing new: the note is rebuilt from the saved changes, not 本週無重大更新', async () => {
  seedState();
  const { world, deps, calls, published } = makeWorld();
  world.releases = [newRelease];
  await run({ upload: true, config }, deps);
  await run({ upload: true, config }, deps);
  assert.equal(published.length, 2);
  assert.equal(published[1].markdown, published[0].markdown);
  assert.doesNotMatch(published[1].markdown, /本週無重大更新/);
  assert.equal(calls.filter((callOptions) => callOptions.model === MODELS.haiku).length, 1);
});

test('triage returns null for a source: warning, that source is retried next time, other sources still advance', async () => {
  seedState();
  const { world, deps, published } = makeWorld();
  world.releases = [newRelease];
  world.docsText = '# Docs\nnew line\n';
  world.triage = (payload) =>
    payload.source === 'tool'
      ? {}
      : { changes: [{ text: 'docs changed', category: '其他', importance: 1 }] };
  const result = await run({ upload: true, config }, deps);
  assert.match(result.warnings.join('\n'), /tool/);
  assert.match(published[0].markdown, /> ⚠️ tool/);
  assert.deepEqual(load('changelog/tool', null), SEEDED_TOOL);
  assert.deepEqual(load('changelog/docs', null), { text: '# Docs\nnew line\n' });
});

test('the team context file is added to the Sonnet system prompt', async () => {
  seedState();
  writeFileSync(join(configDir, 'changelogContext.md'), '團隊使用 Orca ADE');
  const { world, deps, calls } = makeWorld();
  world.releases = [newRelease];
  await run({ upload: true, config }, deps);
  assert.match(sonnetCalls(calls)[0].system, /團隊使用 Orca ADE/);
});

test('a missing team context file adds a warning instead of failing', async () => {
  seedState();
  const { world, deps } = makeWorld();
  world.releases = [newRelease];
  const result = await run({ upload: true, config }, deps);
  assert.match(result.warnings.join('\n'), /changelogContext\.md/);
  assert.ok(readFileSync(join(outputDir, 'changelog', `${WEEK}.md`), 'utf8').length > 0);
});

test('a triage error for one source is a warning for that source, the others still run', async () => {
  seedState();
  const { world, deps, published } = makeWorld();
  world.releases = [newRelease];
  world.docsText = '# Docs\nnew line\n';
  world.triage = (payload) => {
    if (payload.source === 'tool') throw new Error('400 prompt is too long');
    return { changes: [{ text: 'docs changed', category: '其他', importance: 1 }] };
  };
  const result = await run({ upload: true, config }, deps);
  assert.match(result.warnings.join('\n'), /tool.*400 prompt is too long/);
  assert.equal(published.length, 1);
  assert.deepEqual(load('changelog/tool', null), SEEDED_TOOL);
  assert.deepEqual(load('changelog/docs', null), { text: '# Docs\nnew line\n' });
});

test('a triage error for every source that needed triage fails the run', async () => {
  seedState();
  const { world, deps, published } = makeWorld();
  world.releases = [newRelease];
  world.docsText = '# Docs\nnew line\n';
  world.triage = () => {
    throw new Error('credit balance too low');
  };
  await assert.rejects(run({ upload: true, config }, deps), new Error('credit balance too low'));
  assert.equal(published.length, 0);
});

test('more than 40 important changes: Sonnet gets the 40 most important, 棄用/價格 first, and a warning counts the rest', async () => {
  seedState();
  const { world, deps, calls } = makeWorld();
  world.releases = [newRelease];
  world.triage = () => ({
    changes: [
      ...Array.from({ length: 45 }, (_, index) => ({
        text: `feature ${index}`,
        category: '新功能',
        importance: 1,
      })),
      { text: 'deprecation', category: '棄用', importance: 2 },
      ...Array.from({ length: 4 }, (_, index) => ({
        text: `big ${index}`,
        category: '新功能',
        importance: 3,
      })),
    ],
  });
  const result = await run({ upload: true, config }, deps);
  const payload = JSON.parse(sonnetCalls(calls)[0].user) as {
    urgent: { text: string }[];
    others: { text: string }[];
  };
  assert.equal(payload.urgent.length + payload.others.length, 40);
  assert.deepEqual(
    payload.urgent.map((change) => change.text),
    ['deprecation'],
  );
  const otherTexts = payload.others.map((change) => change.text);
  assert.deepEqual(otherTexts.slice(0, 4), ['big 0', 'big 1', 'big 2', 'big 3']);
  assert.ok(!otherTexts.includes('feature 44'));
  assert.match(result.warnings.join('\n'), /10/);
});
