import type { MergedPr, OpenIssue, OpenPr } from './devWeeklyRules.ts';
import { waitMilliseconds, weekStart } from './prStats.ts';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const SEARCH_RESULT_LIMIT = 1000;
const DAY_MS = 86_400_000;

export interface GithubDeps {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface RepoData {
  merged: MergedPr[];
  openPrs: OpenPr[];
  openIssues: OpenIssue[];
  warnings: string[];
}

const QUERY = `query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $endCursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url body additions deletions changedFiles headRefName baseRefName
        isDraft createdAt updatedAt mergedAt author { login }
      }
      ... on Issue { number title url createdAt updatedAt author { login } }
    }
  }
}`;

interface Node {
  number: number;
  title: string;
  url: string;
  body?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  author: { login: string } | null;
}

async function send(url: string, init: RequestInit, repo: string, deps: GithubDeps) {
  for (let attempt = 1; ; attempt++) {
    const response = await deps.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) return response;
    const wait =
      response.status === 403 || response.status === 429
        ? waitMilliseconds(response, new Date())
        : null;
    if (wait === null || attempt >= MAX_ATTEMPTS)
      throw new Error(`${repo}: HTTP ${response.status}`);
    await deps.sleep(wait);
  }
}

const headers = (token: string, accept: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: accept,
  'User-Agent': 'radar',
});

async function search(query: string, repo: string, token: string, deps: GithubDeps) {
  const nodes: Node[] = [];
  const warnings: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await send(
      GRAPHQL_URL,
      {
        method: 'POST',
        headers: { ...headers(token, 'application/json'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { q: query, endCursor: cursor } }),
      },
      repo,
      deps,
    );
    const body = (await response.json()) as {
      data?: {
        search: {
          issueCount: number;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Node[];
        };
      };
      errors?: { message: string }[];
    };
    if (body.errors?.length || !body.data)
      throw new Error(
        `${repo}: ${body.errors?.map((error) => error.message).join('; ') ?? 'no data'}`,
      );
    const { issueCount, pageInfo, nodes: pageNodes } = body.data.search;
    nodes.push(...pageNodes);
    if (issueCount > SEARCH_RESULT_LIMIT && nodes.length === pageNodes.length)
      warnings.push(`${repo}: ${issueCount} 筆結果，GitHub 搜尋只回傳前 ${SEARCH_RESULT_LIMIT} 筆`);
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
  return { nodes, warnings };
}

const login = (node: Node) => node.author?.login ?? 'ghost';

export async function collectRepo(
  repo: string,
  week: string,
  token: string,
  deps: GithubDeps,
): Promise<RepoData> {
  const monday = weekStart(week);
  const sunday = new Date(new Date(`${monday}T00:00:00Z`).getTime() + 6 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const merged = await search(
    `repo:${repo} is:pr is:merged merged:${monday}T00:00:00+08:00..${sunday}T23:59:59+08:00`,
    repo,
    token,
    deps,
  );
  const open = await search(`repo:${repo} is:pr is:open`, repo, token, deps);
  const issues = await search(`repo:${repo} is:issue is:open`, repo, token, deps);
  return {
    merged: merged.nodes.map((node) => ({
      repo,
      number: node.number,
      title: node.title,
      url: node.url,
      body: node.body ?? '',
      additions: node.additions ?? 0,
      deletions: node.deletions ?? 0,
      changedFiles: node.changedFiles ?? 0,
      headRefName: node.headRefName ?? '',
      baseRefName: node.baseRefName ?? '',
      createdAt: node.createdAt,
      mergedAt: node.mergedAt ?? '',
      author: login(node),
    })),
    openPrs: open.nodes.map((node) => ({
      repo,
      number: node.number,
      title: node.title,
      url: node.url,
      body: node.body ?? '',
      headRefName: node.headRefName ?? '',
      author: login(node),
      isDraft: node.isDraft ?? false,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    })),
    openIssues: issues.nodes.map((node) => ({
      repo,
      number: node.number,
      title: node.title,
      url: node.url,
      author: login(node),
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    })),
    warnings: [...merged.warnings, ...open.warnings, ...issues.warnings],
  };
}

export async function fetchDiff(
  pr: { repo: string; number: number },
  token: string,
  deps: GithubDeps,
): Promise<string> {
  const response = await send(
    `https://api.github.com/repos/${pr.repo}/pulls/${pr.number}`,
    { headers: headers(token, 'application/vnd.github.diff') },
    `${pr.repo}#${pr.number}`,
    deps,
  );
  return response.text();
}
