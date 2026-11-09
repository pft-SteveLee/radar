import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { type Deps, previousWeek, type RawWeek, readMembers, run } from '../jobs/devWeekly.ts';
import { MODELS } from '../lib/claude.ts';
import { load, save } from '../lib/state.ts';

const WEEK = '2026-W45';
const NOW = new Date('2026-11-09T01:00:00Z');

interface Node {
  number: number;
  title: string;
  body: string;
  additions: number;
  deletions: number;
  author: { login: string };
}

const prNode = (number: number, overrides: Partial<Node> = {}) => ({
  number,
  title: `pr ${number}`,
  url: `https://github.com/x/pull/${number}`,
  body: 'a short description',
  additions: 5,
  deletions: 1,
  changedFiles: 1,
  headRefName: 'feature/x',
  baseRefName: 'amp/master',
  isDraft: false,
  createdAt: '2026-11-02T01:00:00Z',
  updatedAt: '2026-11-02T01:00:00Z',
  mergedAt: '2026-11-03T01:00:00Z',
  author: { login: 'alice' },
  ...overrides,
});

const largePr = (number: number, overrides: Partial<Node> = {}) =>
  prNode(number, { body: '', additions: 1000 - number, ...overrides });

interface Scenario {
  merged: Record<string, object[]>;
  failing: Set<string>;
  failingDiff: Set<number>;
}

function setup(scenario: Partial<Scenario> = {}) {
  const state: Scenario = { merged: {}, failing: new Set(), failingDiff: new Set(), ...scenario };
  const counts = { graphql: 0, diffs: 0, opus: 0, sonnet: 0 };
  const published: { alias: string; text: string }[] = [];
  const opusUsers: string[] = [];
  const sonnetUsers: string[] = [];
  const deps: Deps = {
    fetch: (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/graphql')) {
        counts.graphql++;
        const { q } = JSON.parse(init?.body as string).variables as { q: string };
        const repo = /repo:(\S+)/.exec(q)?.[1] as string;
        if (state.failing.has(repo))
          return new Response(JSON.stringify({ errors: [{ message: 'Not found' }] }), {
            status: 200,
          });
        const nodes = q.includes('is:merged') ? (state.merged[repo] ?? []) : [];
        return new Response(
          JSON.stringify({
            data: {
              search: {
                issueCount: nodes.length,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes,
              },
            },
          }),
          { status: 200 },
        );
      }
      counts.diffs++;
      const number = Number(String(url).split('/').at(-1));
      if (state.failingDiff.has(number)) return new Response('nope', { status: 404 });
      return new Response(`diff --git a/src/a.ts b/src/a.ts\n+change ${number}\n`, { status: 200 });
    }) as typeof fetch,
    sleep: async () => {},
    now: () => NOW,
    call: (async (options: { model: string; user: string }) => {
      if (options.model === MODELS.opus) {
        counts.opus++;
        opusUsers.push(options.user);
        if (options.user.includes('boom')) throw new Error('model overloaded');
        return '加入權限檢查  ';
      }
      counts.sonnet++;
      sonnetUsers.push(options.user);
      const ids = (JSON.parse(options.user) as { id: number }[]).map((pr) => pr.id);
      return { features: [{ name: '功能', summary: '摘要', prs: ids, overlap: '' }] };
    }) as never,
    publish: (async (alias: string, text: string) => {
      published.push({ alias, text });
      return { url: `https://codimd.test/${alias}`, status: 'updated' };
    }) as never,
  };
  return { deps, counts, published, opusUsers, sonnetUsers, state };
}

const config = (repos: string[]) => ({ repos, token: 'token', members: [] as string[] });
const options = (repos = ['o/a'], upload = true) => ({ week: WEEK, upload, config: config(repos) });

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'devweekly-'));
  for (const name of ['state', 'output', 'config', 'prompts']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'prompts', 'devWeeklyGroup.md'), 'group prompt');
  writeFileSync(join(root, 'prompts', 'devWeeklyDiff.md'), 'diff prompt');
  writeFileSync(join(root, 'config', 'devWeeklyContext.md'), '成員：alice');
  process.env.STATE_DIR = join(root, 'state');
  process.env.OUTPUT_DIR = join(root, 'output');
  process.env.CONFIG_DIR = join(root, 'config');
  process.env.PROMPTS_DIR = join(root, 'prompts');
});

const OLD = '2026-10-01T01:00:00Z';
const item = (number: number, author: string, title: string) => ({
  repo: 'o/a',
  number,
  title,
  url: `https://github.com/o/a/pull/${number}`,
  author,
  createdAt: OLD,
  updatedAt: OLD,
});
const mergedItem = (number: number, author: string, title: string, body = '') => ({
  ...item(number, author, title),
  body,
  additions: 500,
  deletions: 1,
  changedFiles: 1,
  headRefName: 'feature/x',
  baseRefName: 'amp/master',
  mergedAt: '2026-11-03T01:00:00Z',
});
const openItem = (number: number, author: string, title: string, isDraft: boolean) => ({
  ...item(number, author, title),
  body: '',
  headRefName: 'feature/x',
  isDraft,
});
const seedRaw = (): RawWeek => {
  const raw = {
    week: WEEK,
    fetchedAt: '2026-11-09T00:30:00Z',
    merged: [
      mergedItem(1, 'alice', 'team-merged'),
      mergedItem(2, 'outsider', 'outsider-merged', 'fixes #50'),
    ],
    openPrs: [
      openItem(3, 'alice', 'team-stuck', false),
      openItem(4, 'outsider', 'outsider-stuck', false),
      openItem(5, 'outsider', 'outsider-draft', true),
    ],
    openIssues: [
      item(6, 'alice', 'team-issue'),
      item(7, 'outsider', 'outsider-issue'),
      item(50, 'alice', 'mentioned-by-outsider'),
    ],
  };
  save(`devWeekly/raw/${WEEK}`, raw);
  return raw;
};
const teamOptions = (members: string[]) => ({
  week: WEEK,
  upload: true,
  config: { ...config(['o/a']), members },
});

test('only listed members reach the models and every section of the note', async () => {
  const raw = seedRaw();
  const { deps, published, opusUsers, sonnetUsers } = setup();
  await run(teamOptions(['alice']), deps);
  const text = published[0].text;
  assert.doesNotMatch(text, /outsider-(merged|stuck|draft|issue)/);
  assert.match(text, /team-merged/);
  assert.match(text, /team-stuck/);
  assert.match(text, /team-issue/);
  assert.match(text, /上週合併 1 個 PR，1 位作者/);
  assert.equal(opusUsers.length, 1);
  assert.doesNotMatch(opusUsers[0], /outsider/);
  assert.equal((JSON.parse(sonnetUsers[0]) as unknown[]).length, 1);
  assert.deepEqual(load<RawWeek | null>(`devWeekly/raw/${WEEK}`, null), raw);
});

test('an issue mentioned only by an outsider PR is not reported as unattended', async () => {
  seedRaw();
  const { deps, published } = setup();
  await run(teamOptions(['alice']), deps);
  assert.doesNotMatch(published[0].text, /mentioned-by-outsider/);
});

test('an empty member list filters nothing and warns', async () => {
  seedRaw();
  const { deps, published } = setup();
  const result = await run(teamOptions([]), deps);
  assert.match(published[0].text, /outsider-merged/);
  assert.ok(result.warnings.some((warning) => warning.includes('prStats.yaml')));
});

test('readMembers returns the logins, or an empty list without a usable file', () => {
  assert.deepEqual(readMembers(), []);
  const path = join(process.env.CONFIG_DIR as string, 'prStats.yaml');
  writeFileSync(path, 'members: []\n');
  assert.deepEqual(readMembers(), []);
  writeFileSync(path, 'members:\n  - alice\n  - bob\n');
  assert.deepEqual(readMembers(), ['alice', 'bob']);
});

test('a run over two repos writes the note, saves the raw file and publishes once', async () => {
  const { deps, published } = setup({
    merged: { 'o/a': [prNode(1)], 'o/b': [prNode(2, { author: { login: 'bob' } })] },
  });
  const result = await run(options(['o/a', 'o/b']), deps);
  assert.equal(published.length, 1);
  assert.equal(published[0].alias, `radar-dev-weekly-${WEEK}`);
  assert.match(published[0].text, /# \[開發週報\] 2026-W45/);
  assert.match(published[0].text, /上週合併 2 個 PR，2 位作者，2 個 repo/);
  assert.equal(result.url, `https://codimd.test/radar-dev-weekly-${WEEK}`);
  assert.equal(existsSync(join(process.env.OUTPUT_DIR as string, 'devWeekly', `${WEEK}.md`)), true);
  assert.equal(load<RawWeek | null>(`devWeekly/raw/${WEEK}`, null)?.merged.length, 2);
});

test('with upload off nothing is published but the raw file and the Opus cache are kept', async () => {
  const { deps, published } = setup({ merged: { 'o/a': [largePr(1)] } });
  const result = await run(options(['o/a'], false), deps);
  assert.equal(published.length, 0);
  assert.equal(result.url, null);
  assert.ok(load(`devWeekly/raw/${WEEK}`, null));
  assert.deepEqual(load(`devWeekly/opus/${WEEK}`, {}), { 'o/a#1': '加入權限檢查' });
  assert.equal(existsSync(join(process.env.OUTPUT_DIR as string, 'devWeekly', `${WEEK}.md`)), true);
});

test('a rerun reuses the raw file and the Opus cache instead of fetching and paying again', async () => {
  const first = setup({ merged: { 'o/a': [largePr(1)] } });
  await run(options(['o/a'], false), first.deps);
  const second = setup({ merged: { 'o/a': [largePr(1)] } });
  await run(options(['o/a'], false), second.deps);
  assert.equal(second.counts.graphql, 0);
  assert.equal(second.counts.diffs, 0);
  assert.equal(second.counts.opus, 0);
  assert.equal(second.counts.sonnet, 1);
});

test('at most 10 large PRs go to Opus and the others are named in a warning', async () => {
  const merged = Array.from({ length: 12 }, (_, index) => largePr(index + 1));
  const { deps, counts } = setup({ merged: { 'o/a': merged } });
  const result = await run(options(), deps);
  assert.equal(counts.opus, 10);
  assert.equal(
    result.warnings.filter((warning) => /a#11/.test(warning) && /a#12/.test(warning)).length,
    1,
  );
});

test('a failing Opus call becomes a warning and the run still publishes', async () => {
  const { deps, published } = setup({
    merged: { 'o/a': [largePr(1, { title: 'boom' }), largePr(2)] },
  });
  const result = await run(options(), deps);
  assert.equal(published.length, 1);
  assert.ok(
    result.warnings.some((warning) => /a#1\b/.test(warning) && /model overloaded/.test(warning)),
  );
  assert.deepEqual(load(`devWeekly/opus/${WEEK}`, {}), { 'o/a#2': '加入權限檢查' });
});

test('a diff that cannot be fetched becomes a warning for that PR only', async () => {
  const { deps, counts } = setup({
    merged: { 'o/a': [largePr(1), largePr(2)] },
    failingDiff: new Set([1]),
  });
  const result = await run(options(['o/a'], false), deps);
  assert.ok(result.warnings.some((warning) => /a#1\b/.test(warning)));
  assert.equal(counts.opus, 1);
});

test('a failing repo is a warning that names it; the other repo is still reported', async () => {
  const { deps, published } = setup({
    merged: { 'o/b': [prNode(2)] },
    failing: new Set(['o/a']),
  });
  const result = await run(options(['o/a', 'o/b']), deps);
  assert.ok(result.warnings.some((warning) => warning.includes('o/a')));
  assert.equal(published.length, 1);
});

test('every repo failing fails the run', async () => {
  const { deps } = setup({ failing: new Set(['o/a', 'o/b']) });
  await assert.rejects(run(options(['o/a', 'o/b']), deps), /o\/a/);
});

test('a week with no merged PRs makes no model call', async () => {
  const { deps, counts, published } = setup();
  await run(options(), deps);
  assert.equal(counts.sonnet + counts.opus, 0);
  assert.match(published[0].text, /本週無合併的 PR/);
});

test('a missing context file is a warning, not a failure', async () => {
  const { deps } = setup({ merged: { 'o/a': [prNode(1)] } });
  writeFileSync(join(process.env.CONFIG_DIR as string, 'devWeeklyContext.md'), '');
  const withContext = await run(options(['o/a'], false), deps);
  assert.ok(!withContext.warnings.some((warning) => warning.includes('devWeeklyContext')));
  const root = mkdtempSync(join(tmpdir(), 'devweekly-empty-'));
  process.env.CONFIG_DIR = root;
  process.env.STATE_DIR = join(root, 'state');
  const withoutContext = await run(
    options(['o/a'], false),
    setup({ merged: { 'o/a': [prNode(1)] } }).deps,
  );
  assert.ok(withoutContext.warnings.some((warning) => warning.includes('devWeeklyContext')));
});

test('a week that ended long ago and has no raw file warns that open PRs show the current state', async () => {
  const { deps } = setup();
  const result = await run({ ...options(), week: '2026-W40' }, deps);
  assert.ok(result.warnings.some((warning) => warning.includes('目前')));
});

test('previousWeek is the ISO week that ended before today', () => {
  assert.equal(previousWeek('2026-11-09'), '2026-W45');
  assert.equal(previousWeek('2026-11-05'), '2026-W44');
});

test('the note file is the published text', async () => {
  const { deps, published } = setup({ merged: { 'o/a': [prNode(1)] } });
  await run(options(), deps);
  const file = readFileSync(
    join(process.env.OUTPUT_DIR as string, 'devWeekly', `${WEEK}.md`),
    'utf8',
  );
  assert.equal(file, published[0].text);
});

test('a run with a failing repo does not keep the raw file, so a rerun fetches that repo again', async () => {
  const first = setup({ merged: { 'o/b': [prNode(2)] }, failing: new Set(['o/a']) });
  await run(options(['o/a', 'o/b'], false), first.deps);
  assert.equal(load(`devWeekly/raw/${WEEK}`, null), null);
  const second = setup({ merged: { 'o/a': [prNode(1)], 'o/b': [prNode(2)] } });
  const result = await run(options(['o/a', 'o/b'], false), second.deps);
  assert.ok(second.counts.graphql > 0);
  assert.equal(load<RawWeek | null>(`devWeekly/raw/${WEEK}`, null)?.merged.length, 2);
  assert.ok(!result.warnings.some((warning) => warning.includes('o/a')));
});

test('a raw file saved before the week ended is fetched again once the week is over', async () => {
  const during = setup({ merged: { 'o/a': [prNode(1)] } });
  during.deps.now = () => new Date('2026-11-06T01:00:00Z');
  await run(options(['o/a'], false), during.deps);
  const after = setup({ merged: { 'o/a': [prNode(1), prNode(2)] } });
  await run(options(['o/a'], false), after.deps);
  assert.ok(after.counts.graphql > 0);
  assert.equal(load<RawWeek | null>(`devWeekly/raw/${WEEK}`, null)?.merged.length, 2);
});
