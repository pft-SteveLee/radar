import { XMLParser } from 'fast-xml-parser';

export interface Post {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  url: string;
  text: string;
  published: string;
}

interface CollectDeps {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
}

const FEED_SPACING_MS = 2000;
const FEED_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const MAX_POST_AGE_MS = 48 * 60 * 60 * 1000;
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
      for (const post of parseFeed(await fetchFeed(url, userAgent, deps)))
        postsById.set(post.id, post);
    } catch (error) {
      warnings.push(`${url}: ${(error as Error).message}`);
    }
  }
  const oldestAllowed = deps.now().getTime() - MAX_POST_AGE_MS;
  const posts = [...postsById.values()].filter(
    (post) => !(post.id in seen) && new Date(post.published).getTime() >= oldestAllowed,
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
