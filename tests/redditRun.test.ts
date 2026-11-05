import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { type Deps, type Post, run, scorePosts } from '../jobs/redditDigest.ts';
import { MODELS } from '../lib/claude.ts';
import { load, save } from '../lib/state.ts';

const feedXml = readFileSync(new URL('./fixtures/claudeai.rss', import.meta.url), 'utf8');
const config = { userAgent: 'radar-test/0.1', feeds: ['https://reddit.test/a.rss'] };
const date = '2026-11-04';

interface CallOptions {
  model: string;
  user: string;
  schema?: object;
}

let outputDir: string;
let calls: CallOptions[];
let published: { alias: string; markdown: string }[];
let fetchCount: number;

const commentFeed = `<feed xmlns="http://www.w3.org/2005/Atom">${Array.from(
  { length: 5 },
  (_, index) =>
    `<entry><author><name>/u/user${index}</name></author><content type="html">&lt;p&gt;comment ${index}&lt;/p&gt;</content><id>t1_c${index}</id><link href="https://reddit.test/c${index}"/><published>2026-11-04T00:00:00+00:00</published><title>c</title></entry>`,
).join('')}</feed>`;

type Scorer = (posts: { id: string }[], attempt: number) => unknown;
const scoreAll =
  (score: number): Scorer =>
  (posts) => ({ items: posts.map((post) => ({ id: post.id, score, topic: 'claude-code' })) });

function makeDeps(
  options: { scorer?: Scorer; publishStatus?: string; publishFails?: boolean } = {},
) {
  const scorer = options.scorer ?? scoreAll(4);
  let scoringAttempts = 0;
  const deps: Deps = {
    fetch: (async (url: string) => {
      fetchCount++;
      if (url.includes('/comments/')) return new Response(commentFeed);
      return new Response(feedXml);
    }) as unknown as typeof fetch,
    sleep: async () => {},
    now: () => new Date('2026-11-04T02:00:00Z'),
    call: (async (callOptions: CallOptions) => {
      calls.push(callOptions);
      if (callOptions.model === MODELS.haiku) {
        const posts = JSON.parse(callOptions.user) as { id: string }[];
        return scorer(posts, ++scoringAttempts);
      }
      const ids = [...callOptions.user.matchAll(/"id":"(t3_\w+)"/g)].map((match) => match[1]);
      return { items: ids.map((id) => ({ id, highlight: '重點', commentSummary: '留言' })) };
    }) as never,
    publish: (async (alias: string, markdown: string) => {
      if (options.publishFails) throw new Error('CodiMD down');
      published.push({ alias, markdown });
      return { url: `https://codimd.test/${alias}`, status: options.publishStatus ?? 'written' };
    }) as never,
  };
  return deps;
}

const post = (id: string): Post => ({
  id,
  title: `title ${id}`,
  author: '/u/a',
  subreddit: 'r/ClaudeAI',
  url: `https://reddit.test/${id}`,
  text: 'body',
  published: '2026-11-04T00:00:00+00:00',
});

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), 'radar-output-'));
  process.env.OUTPUT_DIR = outputDir;
  process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'radar-state-'));
  calls = [];
  published = [];
  fetchCount = 0;
});

test('scorePosts sends the posts to Haiku 50 at a time', async () => {
  const posts = Array.from({ length: 120 }, (_, index) => post(`t3_${index}`));

  const { scores, warnings } = await scorePosts(posts, makeDeps());

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((callOptions) => JSON.parse(callOptions.user).length),
    [50, 50, 20],
  );
  assert.equal(scores.size, 120);
  assert.deepEqual(warnings, []);
});

test('scorePosts asks again once when the answer is not valid, then uses the second answer', async () => {
  const deps = makeDeps({
    scorer: (posts, attempt) => (attempt === 1 ? 'not json' : scoreAll(5)(posts, attempt)),
  });
  deps.call = (async (callOptions: CallOptions) => {
    calls.push(callOptions);
    if (calls.length === 1) throw new SyntaxError('Unexpected token');
    return scoreAll(5)(JSON.parse(callOptions.user), 2);
  }) as never;

  const { scores, warnings } = await scorePosts([post('t3_a')], deps);

  assert.equal(calls.length, 2);
  assert.equal(scores.get('t3_a')?.score, 5);
  assert.deepEqual(warnings, []);
});

test('scorePosts gives the batch score 0 and a warning after two invalid answers', async () => {
  const deps = makeDeps({ scorer: () => ({ unexpected: true }) });

  const { scores, warnings } = await scorePosts([post('t3_a')], deps);

  assert.equal(calls.length, 2);
  assert.equal(scores.get('t3_a')?.score, 0);
  assert.equal(warnings.length, 1);
});

test('scorePosts scores a post missing from the answer as 0 and keeps scores within 0 to 5', async () => {
  const deps = makeDeps({
    scorer: () => ({ items: [{ id: 't3_a', score: 9, topic: 'seo' }] }),
  });

  const { scores } = await scorePosts([post('t3_a'), post('t3_b')], deps);

  assert.equal(scores.get('t3_a')?.score, 5);
  assert.equal(scores.get('t3_b')?.score, 0);
});

test('run writes the note, publishes it under a per-day alias and marks the posts as seen', async () => {
  await run({ date, upload: true, config }, makeDeps());

  const note = readFileSync(join(outputDir, 'reddit', `${date}.md`), 'utf8');
  assert.ok(note.startsWith('# [Reddit 摘要] 2026-11-04\n'));
  assert.match(note, /## Claude Code/);
  assert.match(note, /本次花費 \$/);
  assert.deepEqual(published, [{ alias: 'radar-reddit-2026-11-04', markdown: note }]);
  assert.deepEqual(Object.keys(load('reddit_seen', {})).sort(), [
    't3_1xna6ug',
    't3_1xna9cb',
    't3_1xnad7d',
  ]);
  assert.deepEqual(load('last_run', {}), { reddit_digest: date });
});

test('run does not call Sonnet when no post scores 3 or more', async () => {
  await run({ date, upload: true, config }, makeDeps({ scorer: scoreAll(1) }));

  assert.ok(calls.every((callOptions) => callOptions.model === MODELS.haiku));
  assert.match(published[0].markdown, /今日無值得一看的貼文/);
});

test('run leaves the posts unseen when the upload fails, so the next run picks them up again', async () => {
  await assert.rejects(
    run({ date, upload: true, config }, makeDeps({ publishFails: true })),
    /CodiMD down/,
  );

  assert.deepEqual(load('reddit_seen', {}), {});
});

test('run reuses the saved raw posts of that date instead of fetching again', async () => {
  const deps = makeDeps();
  await run({ date, upload: true, config }, deps);
  const fetchesAfterFirstRun = fetchCount;

  await run({ date, upload: true, config }, deps);

  assert.equal(fetchCount, fetchesAfterFirstRun);
  assert.equal(published.length, 2);
});

test('run with upload off writes the note but neither publishes nor marks posts as seen', async () => {
  await run({ date, upload: false, config }, makeDeps());

  assert.ok(existsSync(join(outputDir, 'reddit', `${date}.md`)));
  assert.deepEqual(published, []);
  assert.deepEqual(load('reddit_seen', {}), {});
});

test('run still marks posts as seen when the note was edited on the web and was not overwritten', async () => {
  await run({ date, upload: true, config }, makeDeps({ publishStatus: 'editedOnWeb' }));

  assert.equal(Object.keys(load('reddit_seen', {})).length, 3);
});

test('run warns at the top of the note when the previous run was more than a day ago', async () => {
  save('last_run', { reddit_digest: '2026-10-30' });

  await run({ date, upload: true, config }, makeDeps());

  assert.match(published[0].markdown, /> ⚠️ 上次執行是 5 天前/);
});

test('run gives Sonnet the notes of the previous three days to avoid repeating them', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(outputDir, 'reddit'), { recursive: true });
  writeFileSync(join(outputDir, 'reddit', '2026-11-03.md'), 'YESTERDAY-NOTE');
  writeFileSync(join(outputDir, 'reddit', '2026-10-31.md'), 'TOO-OLD-NOTE');

  await run({ date, upload: true, config }, makeDeps());

  const sonnetCall = calls.find((callOptions) => callOptions.model === MODELS.sonnet);
  assert.match(sonnetCall?.user ?? '', /YESTERDAY-NOTE/);
  assert.doesNotMatch(sonnetCall?.user ?? '', /TOO-OLD-NOTE/);
});

test('run returns the note url and the warnings of the run', async () => {
  save('last_run', { reddit_digest: '2026-10-30' });

  const result = await run({ date, upload: true, config }, makeDeps());

  assert.equal(result.url, 'https://codimd.test/radar-reddit-2026-11-04');
  assert.deepEqual(result.warnings, ['上次執行是 5 天前']);
});

test('run returns no url when nothing was published', async () => {
  const result = await run({ date, upload: false, config }, makeDeps());

  assert.equal(result.url, null);
});
