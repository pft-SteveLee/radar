import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseYaml } from 'yaml';
import { call, MODELS, runCost } from '../lib/claude.ts';
import { publish } from '../lib/codimd.ts';
import { withIndex } from '../lib/noteIndex.ts';
import { note } from '../lib/render.ts';
import { type RunResult, recordRun } from '../lib/runLog.ts';
import { load, save } from '../lib/state.ts';

export interface Post {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  url: string;
  text: string;
  published: string;
  rank?: number;
}

interface CollectDeps {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
}

const FEED_SPACING_MS = 2000;
const FEED_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const MAX_POST_AGE_MS = 96 * 60 * 60 * 1000;
const RANK_LIMIT = 10;
const TEXT_LIMIT = 500;

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function htmlToText(html: string): string {
  return html
    .replace(/<!--.*?-->/gs, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_match, name) => NAMED_ENTITIES[name])
    .replace(/\s+/g, ' ')
    .replace(/ ?submitted by .*$/, '')
    .trim();
}

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export function parseFeed(xml: string): Post[] {
  const feed = xmlParser.parse(xml).feed;
  return asArray(feed?.entry).map((entry) => {
    const content =
      typeof entry.content === 'string' ? entry.content : (entry.content?.['#text'] ?? '');
    return {
      id: String(entry.id),
      title: String(entry.title),
      author: entry.author?.name ?? '',
      subreddit: entry.category?.['@_label'] ?? '',
      url: asArray(entry.link)[0]?.['@_href'] ?? '',
      text: htmlToText(content).slice(0, TEXT_LIMIT),
      published: entry.published ?? entry.updated,
    };
  });
}

async function fetchFeed(url: string, userAgent: string, deps: CollectDeps): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const response = await deps.fetch(url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (response.ok) return response.text();
    if (response.status !== 429 || attempt >= MAX_ATTEMPTS)
      throw new Error(`HTTP ${response.status}`);
    const resetSeconds = Number(response.headers.get('x-ratelimit-reset')) || 10;
    await deps.sleep((resetSeconds + 1) * 1000);
  }
}

export async function collect(
  feeds: string[],
  userAgent: string,
  seen: Record<string, string>,
  deps: CollectDeps,
): Promise<{ posts: Post[]; warnings: string[] }> {
  const postsById = new Map<string, Post>();
  const warnings: string[] = [];
  for (const [index, url] of feeds.entries()) {
    if (index > 0) await deps.sleep(FEED_SPACING_MS);
    try {
      const isTopFeed = url.includes('/top.rss');
      for (const [position, post] of parseFeed(await fetchFeed(url, userAgent, deps)).entries()) {
        const rank = isTopFeed ? position + 1 : postsById.get(post.id)?.rank;
        postsById.set(post.id, rank ? { ...post, rank } : post);
      }
    } catch (error) {
      warnings.push(`${url}: ${(error as Error).message}`);
    }
  }
  const oldestAllowed = deps.now().getTime() - MAX_POST_AGE_MS;
  const posts = [...postsById.values()].filter(
    (post) =>
      !(post.id in seen) &&
      new Date(post.published).getTime() >= oldestAllowed &&
      (post.rank ?? 0) <= RANK_LIMIT,
  );
  return { posts, warnings };
}

export function pruneSeen(
  seen: Record<string, string>,
  today: string,
  days: number,
): Record<string, string> {
  const oldestKept = new Date(new Date(today).getTime() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return Object.fromEntries(Object.entries(seen).filter(([, seenOn]) => seenOn >= oldestKept));
}

export interface Deps extends CollectDeps {
  call: typeof call;
  publish: typeof publish;
}

const JOB = 'reddit_digest';
const TOPICS = ['claude-code', 'ai-coding', 'seo', 'orca', 'other'] as const;
type Topic = (typeof TOPICS)[number];
export interface Score {
  score: number;
  topic: Topic;
}

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          score: { type: 'integer' },
          topic: { type: 'string', enum: [...TOPICS] },
        },
        required: ['id', 'score', 'topic'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const SCORE_BATCH_SIZE = 50;
const SCORE_ATTEMPTS = 2;
const SUMMARY_MIN_SCORE = 3;
const SEEN_RETENTION_DAYS = 30;
const PREVIOUS_NOTE_DAYS = 3;
const CANDIDATE_POSTS = 10;
const MAX_NOTE_POSTS = 7;
const MIN_COMMENT_COUNT = 5;
const COMMENT_FEED_LIMIT = 500;
const MAX_COMMENTS_FOR_SUMMARY = 50;
const MIN_COMMENTS_FOR_SUMMARY = 3;

const TOPIC_HEADINGS: Record<Topic, string> = {
  'claude-code': 'Claude Code',
  'ai-coding': 'AI coding',
  seo: 'SEO',
  orca: 'Orca ADE',
  other: '其他',
};

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          highlight: { type: 'string' },
          commentSummary: { type: 'string' },
        },
        required: ['id', 'highlight', 'commentSummary'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const NOTHING_WORTH_READING = '今日無值得一看的貼文';

const readPrompt = (name: string) =>
  readFileSync(join(process.env.PROMPTS_DIR ?? 'prompts', name), 'utf8');

const outputPath = (date: string) =>
  join(process.env.OUTPUT_DIR ?? 'output', 'reddit', `${date}.md`);

const shiftDate = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);

function parseScores(answer: unknown): { id: string; score: number; topic: string }[] {
  const items = (answer as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new SyntaxError('score answer has no items array');
  return items;
}

async function scoreBatch(batch: Post[], deps: Deps) {
  for (let attempt = 1; attempt <= SCORE_ATTEMPTS; attempt++) {
    try {
      const answer = await deps.call({
        job: JOB,
        model: MODELS.haiku,
        system: readPrompt('redditScore.md'),
        user: JSON.stringify(
          batch.map(({ id, title, subreddit, text }) => ({ id, title, subreddit, text })),
        ),
        schema: SCORE_SCHEMA,
      });
      return parseScores(answer);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

export async function scorePosts(
  posts: Post[],
  deps: Deps,
): Promise<{ scores: Map<string, Score>; warnings: string[] }> {
  const scores = new Map<string, Score>();
  const warnings: string[] = [];
  for (let start = 0; start < posts.length; start += SCORE_BATCH_SIZE) {
    const batch = posts.slice(start, start + SCORE_BATCH_SIZE);
    const items = await scoreBatch(batch, deps);
    if (!items)
      warnings.push(`Haiku 評分連續兩次回傳無效格式，這 ${batch.length} 篇貼文一律給 0 分`);
    const itemsById = new Map((items ?? []).map((item) => [item.id, item]));
    for (const post of batch) {
      const item = itemsById.get(post.id);
      scores.set(
        post.id,
        item
          ? {
              score: Math.min(5, Math.max(0, Math.round(item.score))),
              topic: TOPICS.includes(item.topic as Topic) ? (item.topic as Topic) : 'other',
            }
          : { score: 0, topic: 'other' },
      );
    }
  }
  return { scores, warnings };
}

function previousNotes(date: string): string {
  return Array.from({ length: PREVIOUS_NOTE_DAYS }, (_, index) =>
    outputPath(shiftDate(date, -(index + 1))),
  )
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n\n---\n\n');
}

export function selectPosts<T extends Post & Score>(posts: T[], limit: number): T[] {
  const groups = new Map<string, T[]>();
  for (const post of posts) {
    const key = post.topic === 'orca' ? 'orca' : post.subreddit;
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }
  const queues = [...groups.values()].map((group) =>
    group.toSorted((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)),
  );
  const selected: T[] = [];
  for (let round = 0; selected.length < limit && queues.some((queue) => queue[round]); round++)
    for (const queue of queues)
      if (queue[round] && selected.length < limit) selected.push(queue[round]);
  return selected;
}

interface PostComments {
  count: number;
  comments: string[];
}

function parseComments(xml: string): PostComments {
  const entries = parseFeed(xml).filter((entry) => entry.id.startsWith('t1_'));
  const comments = entries
    .filter(
      ({ author, text }) =>
        author !== '/u/AutoModerator' && text !== '[removed]' && text !== '[deleted]',
    )
    .map(({ text }) => text);
  return {
    count: entries.length >= COMMENT_FEED_LIMIT ? COMMENT_FEED_LIMIT : comments.length,
    comments: comments.slice(0, MAX_COMMENTS_FOR_SUMMARY),
  };
}

async function fetchComments(
  posts: Post[],
  date: string,
  userAgent: string,
  deps: Deps,
): Promise<{ commentsById: Record<string, PostComments>; warnings: string[] }> {
  const stateName = `reddit/comments/${date}`;
  const commentsById = load<Record<string, PostComments>>(stateName, {});
  const warnings: string[] = [];
  for (const post of posts.filter(({ id }) => !(id in commentsById))) {
    await deps.sleep(FEED_SPACING_MS);
    try {
      const url = `${post.url}.rss?limit=${COMMENT_FEED_LIMIT}&sort=top`;
      commentsById[post.id] = parseComments(await fetchFeed(url, userAgent, deps));
    } catch (error) {
      warnings.push(`${post.url} 留言抓取失敗：${(error as Error).message}`);
    }
  }
  save(stateName, commentsById);
  return { commentsById, warnings };
}

const hasEnoughComments = (comments: PostComments | undefined): comments is PostComments =>
  comments !== undefined && comments.comments.length >= MIN_COMMENTS_FOR_SUMMARY;

interface PostSummary {
  id: string;
  highlight: string;
  commentSummary: string;
}

function parseSummaries(answer: unknown): PostSummary[] {
  const items = (answer as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new SyntaxError('summary answer has no items array');
  return items;
}

async function summarize(
  selected: (Post & Score)[],
  commentsById: Record<string, PostComments>,
  date: string,
  deps: Deps,
): Promise<PostSummary[]> {
  const posts = selected.map(({ id, title, subreddit, topic, text }) => ({
    id,
    title,
    subreddit,
    topic,
    text,
    comments: hasEnoughComments(commentsById[id]) ? commentsById[id].comments : [],
  }));
  const user = `## 今天的貼文\n\n${JSON.stringify(posts)}\n\n## 前三天的摘要\n\n${previousNotes(date) || '（沒有）'}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const answer = await deps.call({
        job: JOB,
        model: MODELS.sonnet,
        system: readPrompt('redditDigest.md'),
        user,
        schema: SUMMARY_SCHEMA,
      });
      return parseSummaries(answer);
    } catch (error) {
      if (!(error instanceof SyntaxError) || attempt >= SCORE_ATTEMPTS) throw error;
    }
  }
}

function renderPost(post: Post, comments: PostComments | undefined, summary: PostSummary): string {
  const commentCount =
    comments === undefined
      ? '留言數未知'
      : `💬 ${comments.count >= COMMENT_FEED_LIMIT ? `${COMMENT_FEED_LIMIT}+` : comments.count}`;
  const metrics = [post.subreddit, commentCount, ...(post.rank ? [`本週熱門 #${post.rank}`] : [])];
  const commentLine =
    comments === undefined
      ? '留言抓取失敗'
      : hasEnoughComments(comments)
        ? summary.commentSummary
        : '留言太少，暫無摘要';
  const title = post.title.replace(/[[\]]/g, '\\$&');
  return [
    `### [${title}](${post.url})`,
    metrics.join(' · '),
    `**重點**：${summary.highlight}`,
    `**留言**：${commentLine}`,
  ].join('\n\n');
}

function renderBody(
  selected: (Post & Score)[],
  commentsById: Record<string, PostComments>,
  summaries: PostSummary[],
): string {
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const kept = selected.filter(({ id }) => summaryById.has(id));
  if (!kept.length) return NOTHING_WORTH_READING;
  return TOPICS.flatMap((topic) => {
    const posts = kept.filter((post) => post.topic === topic);
    if (!posts.length) return [];
    const rendered = posts.map((post) =>
      renderPost(post, commentsById[post.id], summaryById.get(post.id) as PostSummary),
    );
    return [`## ${TOPIC_HEADINGS[topic]}`, ...rendered];
  }).join('\n\n');
}

export interface Config {
  userAgent: string;
  feeds: string[];
}

interface RawDay {
  posts: Post[];
  warnings: string[];
}

interface RunOptions {
  date: string;
  upload: boolean;
  config: Config;
}

export async function run({ date, upload, config }: RunOptions, deps: Deps): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const seen = load<Record<string, string>>('reddit_seen', {});
  const rawName = `reddit/raw/${date}`;
  let raw = load<RawDay | null>(rawName, null);
  if (!raw) {
    raw = await collect(config.feeds, config.userAgent, seen, deps);
    save(rawName, raw);
  }

  const warnings = [...raw.warnings];
  const lastRun = load<{ reddit_digest?: string }>('last_run', {}).reddit_digest;
  const daysSinceLastRun = lastRun
    ? Math.round((Date.parse(date) - Date.parse(lastRun)) / 86_400_000)
    : 0;
  if (daysSinceLastRun > 1) warnings.unshift(`上次執行是 ${daysSinceLastRun} 天前`);

  const { scores, warnings: scoreWarnings } = await scorePosts(raw.posts, deps);
  warnings.push(...scoreWarnings);
  const qualified = raw.posts.flatMap((post) => {
    const score = scores.get(post.id);
    return score && score.score >= SUMMARY_MIN_SCORE ? [{ ...post, ...score }] : [];
  });
  const candidates = selectPosts(qualified, CANDIDATE_POSTS);
  let selected: typeof candidates = [];
  let body = NOTHING_WORTH_READING;
  if (candidates.length) {
    const { commentsById, warnings: commentWarnings } = await fetchComments(
      candidates,
      date,
      config.userAgent,
      deps,
    );
    warnings.push(...commentWarnings);
    selected = candidates
      .filter(
        (post) => post.topic === 'orca' || (commentsById[post.id]?.count ?? 0) >= MIN_COMMENT_COUNT,
      )
      .slice(0, MAX_NOTE_POSTS);
    if (selected.length)
      body = renderBody(
        selected,
        commentsById,
        await summarize(selected, commentsById, date, deps),
      );
  }

  const text = note({
    title: `[Reddit 摘要] ${date}`,
    body,
    warnings,
    costUsd: runCost(JOB, startedAt),
  });
  mkdirSync(join(outputPath(date), '..'), { recursive: true });
  writeFileSync(outputPath(date), text);
  if (!upload) return { url: null, warnings };

  const { url, status } = await deps.publish(`radar-reddit-${date}`, text);
  console.log(`${url} (${status})`);
  if (status === 'editedOnWeb')
    console.warn(`${url} was edited on the web, so it was not overwritten`);

  const marked = { ...seen, ...Object.fromEntries(selected.map((post) => [post.id, date])) };
  save('reddit_seen', pruneSeen(marked, date, SEEN_RETENTION_DAYS));
  save('last_run', { ...load('last_run', {}), reddit_digest: date });
  return { url, warnings };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { date: { type: 'string' }, 'no-upload': { type: 'boolean' } },
  });
  const date = values.date ?? new Date().toLocaleDateString('sv', { timeZone: 'Asia/Taipei' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${date}`);
  await recordRun(
    JOB,
    withIndex(
      JOB,
      () => {
        const configFile = parseYaml(
          readFileSync(join(process.env.CONFIG_DIR ?? 'config', 'reddit.yaml'), 'utf8'),
        ) as { userAgent: string; topics: Record<string, string[]> };
        return run(
          {
            date,
            upload: !values['no-upload'],
            config: {
              userAgent: configFile.userAgent,
              feeds: Object.values(configFile.topics).flat(),
            },
          },
          {
            fetch,
            sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
            now: () => new Date(),
            call,
            publish,
          },
        );
      },
      publish,
    ),
  );
}
