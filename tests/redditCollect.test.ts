import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, parseFeed, pruneSeen } from '../jobs/redditDigest.ts';

const feedXml = readFileSync(new URL('./fixtures/claudeai.rss', import.meta.url), 'utf8');
const userAgent = 'radar-test/0.1';
const feeds = ['https://reddit.test/a.rss', 'https://reddit.test/b.rss'];

interface Harness {
  sleeps: number[];
  requests: { url: string; userAgent: string | null }[];
  deps: Parameters<typeof collect>[3];
}

function harness(
  respond: (url: string, attempt: number) => Response,
  now = '2026-11-04T02:00:00Z',
): Harness {
  const sleeps: number[] = [];
  const requests: Harness['requests'] = [];
  const attempts = new Map<string, number>();
  const deps = {
    fetch: (async (url: string, init: RequestInit) => {
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      requests.push({ url, userAgent: new Headers(init.headers).get('user-agent') });
      return respond(url, attempt);
    }) as unknown as typeof fetch,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
    },
    now: () => new Date(now),
  };
  return { sleeps, requests, deps };
}

test('parseFeed turns Atom entries into plain-text posts', () => {
  const posts = parseFeed(feedXml);

  assert.equal(posts.length, 3);
  assert.equal(posts[0].id, 't3_1xnad7d');
  assert.equal(posts[0].subreddit, 'r/ClaudeAI');
  assert.equal(posts[0].author, '/u/Hardicecream17');
  assert.match(posts[0].url, /^https:\/\/www\.reddit\.com\/r\/ClaudeAI\/comments\/1xnad7d\//);
  assert.equal(posts[0].published, '2026-11-04T00:44:02+00:00');
  assert.ok(posts[0].text.length > 0 && posts[0].text.length <= 500);
  assert.doesNotMatch(posts[0].text, /<|&#39;|&quot;/);
});

test('collect sends the custom User-Agent and merges the same post found in two feeds', async () => {
  const { deps, requests } = harness(() => new Response(feedXml));

  const { posts, warnings } = await collect(feeds, userAgent, {}, deps);

  assert.equal(posts.length, 3);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    requests.map((request) => request.userAgent),
    [userAgent, userAgent],
  );
});

test('collect waits between feeds', async () => {
  const { deps, sleeps } = harness(() => new Response(feedXml));

  await collect(feeds, userAgent, {}, deps);

  assert.deepEqual(sleeps, [2000]);
});

test('collect skips posts that were already seen', async () => {
  const { deps } = harness(() => new Response(feedXml));

  const { posts } = await collect(feeds, userAgent, { t3_1xnad7d: '2026-11-03' }, deps);

  assert.deepEqual(
    posts.map((post) => post.id),
    ['t3_1xna9cb', 't3_1xna6ug'],
  );
});

test('collect keeps posts up to 48 hours old and drops older ones', async () => {
  const recent = harness(() => new Response(feedXml), '2026-11-06T00:00:00Z');
  const stale = harness(() => new Response(feedXml), '2026-11-06T01:00:00Z');

  assert.equal((await collect(feeds, userAgent, {}, recent.deps)).posts.length, 3);
  assert.equal((await collect(feeds, userAgent, {}, stale.deps)).posts.length, 0);
});

test('collect reports a failing feed as a warning and still returns the other feed', async () => {
  const { deps } = harness((url) =>
    url.endsWith('a.rss') ? new Response('', { status: 403 }) : new Response(feedXml),
  );

  const { posts, warnings } = await collect(feeds, userAgent, {}, deps);

  assert.equal(posts.length, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /a\.rss/);
  assert.match(warnings[0], /403/);
});

test('collect waits for x-ratelimit-reset plus one second after a 429, then retries', async () => {
  const { deps, sleeps } = harness((_url, attempt) =>
    attempt === 1
      ? new Response('', { status: 429, headers: { 'x-ratelimit-reset': '8' } })
      : new Response(feedXml),
  );

  const { posts, warnings } = await collect([feeds[0]], userAgent, {}, deps);

  assert.equal(posts.length, 3);
  assert.deepEqual(warnings, []);
  assert.deepEqual(sleeps, [9000]);
});

test('collect gives up with a warning when a feed keeps returning 429', async () => {
  const { deps } = harness(() => new Response('', { status: 429 }));

  const { posts, warnings } = await collect([feeds[0]], userAgent, {}, deps);

  assert.equal(posts.length, 0);
  assert.match(warnings[0], /429/);
});

test('pruneSeen drops ids seen more than 30 days before today', () => {
  const seen = { old: '2026-10-04', recent: '2026-10-05', today: '2026-11-04' };

  assert.deepEqual(pruneSeen(seen, '2026-11-04', 30), {
    recent: '2026-10-05',
    today: '2026-11-04',
  });
});
