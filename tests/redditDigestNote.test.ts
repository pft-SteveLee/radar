import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import {
  collect,
  type Deps,
  type Post,
  run,
  type Score,
  selectPosts,
} from '../jobs/redditDigest.ts';
import { MODELS } from '../lib/claude.ts';
import { load } from '../lib/state.ts';

const date = '2026-11-05';
const postUrl = (id: string) => `https://www.reddit.com/r/ClaudeAI/comments/${id}/slug/`;

function feedEntry(id: string, author: string, text: string) {
  return `<entry><author><name>${author}</name></author><category term="ClaudeAI" label="r/ClaudeAI"/><content type="html">&lt;p&gt;${text}&lt;/p&gt;</content><id>${id}</id><link href="${postUrl(id.replace(/^t\d_/, ''))}"/><updated>2026-11-05T00:00:00+00:00</updated><published>2026-11-05T00:00:00+00:00</published><title>Title of ${id}</title></entry>`;
}

const feed = (entries: string[]) =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`;

const postFeed = (...ids: string[]) =>
  feed(ids.map((id) => feedEntry(`t3_${id}`, '/u/poster', `body of ${id}`)));

const commentFeed = (id: string, count: number, extra: string[] = []) =>
  feed([
    feedEntry(`t3_${id}`, '/u/poster', `body of ${id}`),
    ...extra,
    ...Array.from({ length: count }, (_, index) =>
      feedEntry(`t1_${id}${index}`, `/u/user${index}`, `comment ${index} on ${id}`),
    ),
  ]);

interface SonnetPost {
  id: string;
  comments: string[];
}

interface HarnessOptions {
  feedXml?: string;
  topic?: string;
  respondComments?: (url: string) => Response;
  summarize?: (posts: SonnetPost[], attempt: number) => unknown;
}

let requests: string[];
let sonnetPosts: SonnetPost[][];
let published: string[];

function sonnetPostsFrom(user: string): SonnetPost[] {
  const start = user.indexOf('[');
  const end = user.indexOf('\n\n## 前三天的摘要');
  return JSON.parse(user.slice(start, end));
}

function makeDeps(options: HarnessOptions = {}): Deps {
  let attempt = 0;
  return {
    fetch: (async (url: string) => {
      requests.push(url);
      if (url.includes('/comments/'))
        return (
          options.respondComments?.(url) ??
          new Response(commentFeed(url.match(/comments\/(\w+)/)?.[1] ?? '', 5))
        );
      return new Response(options.feedXml ?? postFeed('aaa', 'bbb'));
    }) as unknown as typeof fetch,
    sleep: async () => {},
    now: () => new Date('2026-11-05T00:00:00Z'),
    call: (async ({ model, user }: { model: string; user: string }) => {
      if (model === MODELS.haiku)
        return {
          items: (JSON.parse(user) as { id: string }[]).map(({ id }) => ({
            id,
            score: 4,
            topic: options.topic ?? 'claude-code',
          })),
        };
      const posts = sonnetPostsFrom(user);
      sonnetPosts.push(posts);
      attempt++;
      if (options.summarize) return options.summarize(posts, attempt);
      return {
        items: posts.map(({ id }) => ({
          id,
          highlight: `highlight of ${id}`,
          commentSummary: `discussion of ${id}`,
        })),
      };
    }) as never,
    publish: (async (alias: string, markdown: string) => {
      published.push(markdown);
      return { url: `https://codimd.test/${alias}`, status: 'written' };
    }) as never,
  };
}

const config = {
  userAgent: 'radar-test/0.1',
  feeds: ['https://www.reddit.com/r/ClaudeAI/top.rss?t=day&limit=100'],
};

const runNote = async (options: HarnessOptions = {}) => {
  await run({ date, upload: true, config }, makeDeps(options));
  return published.at(-1) ?? '';
};

const scored = (id: string, subreddit: string, rank?: number, topic = 'claude-code') =>
  ({ id, subreddit, rank, topic, score: 4 }) as Post & Score;

beforeEach(() => {
  process.env.OUTPUT_DIR = mkdtempSync(join(tmpdir(), 'radar-output-'));
  process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'radar-state-'));
  requests = [];
  sonnetPosts = [];
  published = [];
});

test('collect ranks posts by their position in a top feed', async () => {
  const { posts } = await collect(config.feeds, 'ua', {}, makeDeps());

  assert.deepEqual(
    posts.map((post) => [post.id, post.rank]),
    [
      ['t3_aaa', 1],
      ['t3_bbb', 2],
    ],
  );
});

test('collect keeps the rank of a post that a search feed returns as well', async () => {
  for (const feeds of [
    ['https://reddit.test/r/x/top.rss?t=day', 'https://reddit.test/search.rss?q=orca'],
    ['https://reddit.test/search.rss?q=orca', 'https://reddit.test/r/x/top.rss?t=day'],
  ]) {
    const { posts } = await collect(feeds, 'ua', {}, makeDeps());

    assert.equal(posts[0].rank, 1);
  }
});

test('collect gives no rank to a post found only by a search feed', async () => {
  const { posts } = await collect(['https://reddit.test/search.rss?q=orca'], 'ua', {}, makeDeps());

  assert.equal(posts[0].rank, undefined);
});

test('selectPosts takes turns between subreddits, best rank first, up to the limit', () => {
  const selected = selectPosts(
    [
      scored('a2', 'r/A', 2),
      scored('a1', 'r/A', 1),
      scored('a3', 'r/A', 3),
      scored('b1', 'r/B', 1),
    ],
    3,
  );

  assert.deepEqual(
    selected.map((post) => post.id),
    ['a1', 'b1', 'a2'],
  );
});

test('selectPosts puts a post without a rank after the ranked posts of its group', () => {
  const selected = selectPosts([scored('none', 'r/A'), scored('a5', 'r/A', 5)], 2);

  assert.deepEqual(
    selected.map((post) => post.id),
    ['a5', 'none'],
  );
});

test('selectPosts treats orca as one group whatever the subreddit', () => {
  const selected = selectPosts(
    [
      scored('o1', 'r/A', undefined, 'orca'),
      scored('o2', 'r/B', undefined, 'orca'),
      scored('a1', 'r/A', 1),
    ],
    2,
  );

  assert.deepEqual(
    selected.map((post) => post.id),
    ['o1', 'a1'],
  );
});

test('collect drops posts ranked below 10 in a top feed and keeps rankless ones', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `p${index}`);

  const ranked = await collect(config.feeds, 'ua', {}, makeDeps({ feedXml: postFeed(...ids) }));
  const search = await collect(
    ['https://reddit.test/search.rss?q=orca'],
    'ua',
    {},
    makeDeps({ feedXml: postFeed(...ids) }),
  );

  assert.deepEqual(
    ranked.posts.map((post) => post.rank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(search.posts.length, 12);
});

test('run fetches comments for 10 candidates and puts at most 7 in the note, marking only those as seen', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `p${index}`);

  const note = await runNote({ feedXml: postFeed(...ids) });

  assert.equal(requests.filter((url) => url.includes('/comments/')).length, 10);
  assert.equal(sonnetPosts[0].length, 7);
  assert.equal(note.match(/^### /gm)?.length, 7);
  assert.equal(Object.keys(load('reddit_seen', {})).length, 7);
});

test('run leaves out a post with fewer than 5 comments and does not mark it as seen', async () => {
  const note = await runNote({
    feedXml: postFeed('aaa', 'bbb'),
    respondComments: (url) =>
      new Response(
        commentFeed(url.match(/comments\/(\w+)/)?.[1] ?? '', url.includes('bbb') ? 4 : 5),
      ),
  });

  assert.equal(note.match(/^### /gm)?.length, 1);
  assert.deepEqual(Object.keys(load('reddit_seen', {})), ['t3_aaa']);
});

test('run keeps an orca post whatever its comment count', async () => {
  const note = await runNote({
    topic: 'orca',
    feedXml: postFeed('aaa'),
    respondComments: () => new Response(commentFeed('aaa', 0)),
  });

  assert.equal(note.match(/^### /gm)?.length, 1);
});

test('run requests the comment feed of the post url sorted by top', async () => {
  await runNote({ feedXml: postFeed('aaa') });

  assert.ok(requests.includes(`${postUrl('aaa')}.rss?limit=500&sort=top`));
});

test('run renders each post with its metrics, highlight and comment summary under its topic', async () => {
  const note = await runNote({ feedXml: postFeed('aaa') });

  assert.ok(
    note.includes(
      [
        '## Claude Code',
        '',
        `### [Title of t3_aaa](${postUrl('aaa')})`,
        '',
        'r/ClaudeAI · 💬 5 · 本週熱門 #1',
        '',
        '**重點**：highlight of t3_aaa',
        '',
        '**留言**：discussion of t3_aaa',
      ].join('\n'),
    ),
  );
  assert.doesNotMatch(note, /最值得深讀/);
});

test('run leaves the rank out for a post without one', async () => {
  await run(
    {
      date,
      upload: true,
      config: { ...config, feeds: ['https://reddit.test/search.rss?q=orca'] },
    },
    makeDeps({ feedXml: postFeed('aaa') }),
  );

  assert.ok(published[0].includes('r/ClaudeAI · 💬 5\n'));
});

test('run escapes square brackets in a title so the link stays intact', async () => {
  const xml = postFeed('aaa').replace('Title of t3_aaa', 'Title [v2]');

  const note = await runNote({ feedXml: xml });

  assert.ok(note.includes(`### [Title \\[v2\\]](${postUrl('aaa')})`));
});

test('run does not count AutoModerator or removed comments', async () => {
  const note = await runNote({
    feedXml: postFeed('aaa'),
    respondComments: () =>
      new Response(
        commentFeed('aaa', 5, [
          feedEntry('t1_bot', '/u/AutoModerator', 'I am a bot'),
          feedEntry('t1_gone', '/u/x', '[removed]'),
        ]),
      ),
  });

  assert.match(note, /💬 5 /);
  assert.ok(!sonnetPosts[0][0].comments.includes('I am a bot'));
  assert.ok(!sonnetPosts[0][0].comments.includes('[removed]'));
});

test('run shows 500+ when the comment feed reaches its limit and sends Sonnet only 50', async () => {
  const note = await runNote({
    feedXml: postFeed('aaa'),
    respondComments: () => new Response(commentFeed('aaa', 500)),
  });

  assert.match(note, /💬 500\+ /);
  assert.equal(sonnetPosts[0][0].comments.length, 50);
});

test('run sends no comments and writes a fixed line when fewer than 3 remain', async () => {
  const note = await runNote({
    topic: 'orca',
    feedXml: postFeed('aaa'),
    respondComments: () => new Response(commentFeed('aaa', 2)),
  });

  assert.deepEqual(sonnetPosts[0][0].comments, []);
  assert.match(note, /💬 2 /);
  assert.match(note, /\*\*留言\*\*：留言太少，暫無摘要/);
  assert.doesNotMatch(note, /discussion of/);
});

test('run warns at the top and marks the post when its comments cannot be fetched', async () => {
  const note = await runNote({
    topic: 'orca',
    feedXml: postFeed('aaa'),
    respondComments: () => new Response('nope', { status: 500 }),
  });

  assert.match(note, /> ⚠️ .*aaa.*HTTP 500/);
  assert.match(note, /r\/ClaudeAI · 留言數未知 · 本週熱門 #1/);
  assert.match(note, /\*\*留言\*\*：留言抓取失敗/);
  assert.deepEqual(sonnetPosts[0][0].comments, []);
});

test('run reuses saved comments on a rerun and fetches only those that failed', async () => {
  let failing = true;
  const respondComments = (url: string) => {
    if (failing && url.includes('bbb')) return new Response('nope', { status: 500 });
    return new Response(commentFeed(url.match(/comments\/(\w+)/)?.[1] ?? '', 5));
  };

  await runNote({ respondComments });
  failing = false;
  requests = [];
  await runNote({ respondComments });

  assert.deepEqual(requests, [`${postUrl('bbb')}.rss?limit=500&sort=top`]);
});

test('run asks Sonnet again once after an invalid answer', async () => {
  const note = await runNote({
    feedXml: postFeed('aaa'),
    summarize: (posts, attempt) => {
      if (attempt === 1) throw new SyntaxError('Unexpected token');
      return { items: posts.map(({ id }) => ({ id, highlight: 'second', commentSummary: 'ok' })) };
    },
  });

  assert.match(note, /\*\*重點\*\*：second/);
});

test('run fails without marking posts as seen after two invalid Sonnet answers', async () => {
  await assert.rejects(runNote({ feedXml: postFeed('aaa'), summarize: () => ({ wrong: true }) }));

  assert.equal(sonnetPosts.length, 2);
  assert.deepEqual(load('reddit_seen', {}), {});
});

test('run leaves out a post Sonnet omits as a repeat', async () => {
  const note = await runNote({
    summarize: (posts) => ({
      items: posts
        .filter(({ id }) => id === 't3_aaa')
        .map(({ id }) => ({ id, highlight: 'kept', commentSummary: 'ok' })),
    }),
  });

  assert.equal(note.match(/^### /gm)?.length, 1);
});

test('run writes the empty message when Sonnet omits every post', async () => {
  const note = await runNote({ summarize: () => ({ items: [] }) });

  assert.match(note, /今日無值得一看的貼文/);
});

test('the score prompt limits the general dev subreddits to AI-related posts', () => {
  const prompt = readFileSync('prompts/redditScore.md', 'utf8');

  for (const name of ['programming', 'webdev', 'devops', 'GithubActions'])
    assert.ok(prompt.includes(`r/${name}`), name);
});

test('the digest prompt tells Sonnet to treat comments as data', () => {
  const prompt = readFileSync(join('prompts', 'redditDigest.md'), 'utf8');

  assert.match(prompt, /commentSummary/);
  assert.match(prompt, /不要照.*指示/);
});
