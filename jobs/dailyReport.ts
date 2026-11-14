import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { publish } from '../lib/codimd.ts';
import { withIndex } from '../lib/noteIndex.ts';
import { escapeMarkdown, note } from '../lib/render.ts';
import { type RunResult, recordRun } from '../lib/runLog.ts';
import {
  allPages,
  branchCommits,
  type Deps as GithubDeps,
  graphql,
  orgRepositories,
  PAGE_INFO,
  type Page,
} from './prStats.ts';

const JOB = 'daily_report';
const DAY_MS = 86_400_000;

export interface Range {
  from: string;
  to: string;
}

export interface Config {
  login: string;
  orgs: string[];
  token: string;
}

export interface Commit {
  repo: string;
  headline: string;
  url: string;
}

const shiftDay = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const startOf = (day: string) => `${day}T00:00:00+08:00`;

export const isDay = (day: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toJSON()?.slice(0, 10) === day;

export function reportRange(today: string): Range {
  const isMonday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1;
  return { from: shiftDay(today, isMonday ? -3 : -1), to: shiftDay(today, -1) };
}

const ME_QUERY = `query Me($login: String!, $after: String) {
  user(login: $login) {
    id
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
      nodes { nameWithOwner } ${PAGE_INFO}
    }
  }
}`;
const MY_HISTORY_QUERY = `query MyHistory($id: ID!, $author: ID!, $since: GitTimestamp!, $until: GitTimestamp!, $after: String) {
  node(id: $id) { ... on Ref { target { ... on Commit {
    history(since: $since, until: $until, author: { id: $author }, first: 100, after: $after) {
      nodes { oid messageHeadline url parents { totalCount } } ${PAGE_INFO}
    }
  } } } }
}`;

interface HistoryCommit {
  oid: string;
  messageHeadline: string;
  url: string;
  parents: { totalCount: number };
}

export async function fetchMyCommits(
  range: Range,
  config: Config,
  deps: GithubDeps,
): Promise<{ commits: Commit[]; warnings: string[] }> {
  const since = startOf(range.from);
  const until = startOf(shiftDay(range.to, 1));
  const warnings: string[] = [];
  const repos: string[] = [];
  for (const org of config.orgs) {
    try {
      const names = await orgRepositories(org, config.token, deps);
      repos.push(...names.map((name) => `${org}/${name}`));
    } catch (error) {
      warnings.push(`commits ${org}: ${(error as Error).message}`);
    }
  }
  let author = '';
  const own = await allPages((after) =>
    graphql<{ user: { id: string; repositories: Page<{ nameWithOwner: string }> } | null }>(
      ME_QUERY,
      { login: config.login, after },
      config.token,
      deps,
    ).then((data) => {
      if (!data.user) throw new Error(`user ${config.login} cannot be read`);
      author = data.user.id;
      return data.user.repositories;
    }),
  );
  repos.push(...own.map(({ nameWithOwner }) => nameWithOwner));

  const commits: Commit[] = [];
  for (const repo of new Set(repos)) {
    const [owner, name] = repo.split('/');
    try {
      const found = await branchCommits<HistoryCommit>(
        { owner, name },
        since,
        MY_HISTORY_QUERY,
        { author, since, until },
        config.token,
        deps,
      );
      commits.push(
        ...found
          .filter((commit) => commit.parents.totalCount <= 1)
          .map((commit) => ({ repo, headline: commit.messageHeadline, url: commit.url })),
      );
    } catch (error) {
      warnings.push(`commits ${repo}: ${(error as Error).message}`);
    }
  }
  return { commits, warnings };
}

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
}

const SEARCH_RESULT_LIMIT = 1000;
const SEARCH_QUERY = `query Search($q: String!, $login: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount ${PAGE_INFO}
    nodes { ... on PullRequest {
      number title url repository { nameWithOwner }
      reviews(author: $login, last: 100) { nodes { submittedAt } }
    } }
  }
}`;

interface SearchNode {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  reviews: { nodes: { submittedAt: string | null }[] };
}

export async function fetchPullRequests(
  range: Range,
  config: Config,
  deps: GithubDeps,
): Promise<{
  opened: PullRequest[];
  merged: PullRequest[];
  reviewed: PullRequest[];
  warnings: string[];
}> {
  const { login } = config;
  const since = Date.parse(startOf(range.from));
  const until = Date.parse(startOf(shiftDay(range.to, 1)));
  const days = `${startOf(range.from)}..${range.to}T23:59:59+08:00`;
  const warnings: string[] = [];
  const search = async (q: string) => {
    let count = 0;
    const nodes = await allPages((after) =>
      graphql<{ search: Page<SearchNode> & { issueCount: number } }>(
        SEARCH_QUERY,
        { q, login, after },
        config.token,
        deps,
      ).then((data) => {
        count = data.search.issueCount;
        return data.search;
      }),
    );
    if (count > SEARCH_RESULT_LIMIT)
      warnings.push(`「${q}」有 ${count} 筆，GitHub 搜尋只回傳前 ${SEARCH_RESULT_LIMIT} 筆`);
    return nodes;
  };
  const toPullRequest = (node: SearchNode): PullRequest => ({
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
  });
  const opened = await search(`is:pr author:${login} created:${days}`);
  const merged = await search(`is:pr author:${login} merged:${days}`);
  const reviewed = await search(
    `is:pr reviewed-by:${login} -author:${login} updated:>=${startOf(range.from)}`,
  );
  return {
    opened: opened.map(toPullRequest),
    merged: merged.map(toPullRequest),
    reviewed: reviewed
      .filter((node) =>
        node.reviews.nodes.some(({ submittedAt }) => {
          const time = Date.parse(submittedAt ?? '');
          return time >= since && time < until;
        }),
      )
      .map(toPullRequest),
    warnings,
  };
}

export interface Activity {
  opened: PullRequest[];
  merged: PullRequest[];
  reviewed: PullRequest[];
  commits: Commit[];
}

export function renderReport(activity: Activity): string {
  const { opened, merged, reviewed, commits } = activity;
  if (opened.length + merged.length + reviewed.length + commits.length === 0) return '無活動';
  const labelled = [
    ...opened.map((pr) => ({ pr, label: '開啟' })),
    ...merged.map((pr) => ({ pr, label: '合併' })),
    ...reviewed.map((pr) => ({ pr, label: 'review' })),
  ];
  const repos = [...new Set([...labelled.map(({ pr }) => pr.repo), ...commits.map((c) => c.repo)])];
  const sections = repos.sort().map((repo) => {
    const byUrl = Map.groupBy(
      labelled.filter(({ pr }) => pr.repo === repo),
      ({ pr }) => pr.url,
    );
    const pullRequests = [...byUrl.values()].map(
      (entries) =>
        `- [#${entries[0].pr.number}](${entries[0].pr.url}) ${escapeMarkdown(entries[0].pr.title)} — ${entries.map(({ label }) => label).join('、')}`,
    );
    const commitLines = commits
      .filter((commit) => commit.repo === repo)
      .map((commit) => `- [${escapeMarkdown(commit.headline)}](${commit.url})`);
    return [
      `## ${repo}`,
      pullRequests.join('\n'),
      commitLines.length ? `Commit：\n\n${commitLines.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  });
  const summary = `開啟 ${opened.length} 個 PR、合併 ${merged.length} 個、review ${reviewed.length} 個、commit ${commits.length} 個`;
  return [summary, ...sections].join('\n\n');
}

export interface Deps extends GithubDeps {
  publish: typeof publish;
}

export interface Options {
  date: string;
  range: Range;
  upload: boolean;
  config: Config;
}

export async function run(options: Options, deps: Deps): Promise<RunResult> {
  const { date, range, config } = options;
  const pullRequests = await fetchPullRequests(range, config, deps);
  const commits = await fetchMyCommits(range, config, deps);
  const warnings = [...pullRequests.warnings, ...commits.warnings];
  const covered = range.from === range.to ? range.to : `${range.from} 至 ${range.to}`;
  const text = note({
    title: `個人日報 ${date}（${covered}）`,
    body: renderReport({ ...pullRequests, commits: commits.commits }),
    warnings,
    costUsd: 0,
  });
  const path = join(process.env.OUTPUT_DIR ?? 'output', 'daily', `${date}.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  if (!options.upload) return { url: null, warnings };

  const { url, status } = await deps.publish(`radar-daily-${date}`, text);
  console.log(`${url} (${status})`);
  if (status === 'editedOnWeb')
    return { url, warnings: [...warnings, `radar-daily-${date} 在網頁上被改過，這次沒有更新`] };
  return { url, warnings };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'no-upload': { type: 'boolean' },
    },
  });
  const date = values.date ?? new Date().toLocaleDateString('sv', { timeZone: 'Asia/Taipei' });
  if (!isDay(date)) throw new Error(`--date must be a day like 2026-11-17, got ${date}`);
  const usual = reportRange(date);
  const range = { from: values.from ?? usual.from, to: values.to ?? usual.to };
  for (const day of [range.from, range.to])
    if (!isDay(day)) throw new Error(`--from/--to must be a day like 2026-11-17, got ${day}`);
  if (range.from > range.to) throw new Error(`--from ${range.from} is after --to ${range.to}`);
  await recordRun(
    JOB,
    withIndex(
      JOB,
      () => {
        const token = process.env.GITHUB_TOKEN;
        if (!token) throw new Error('GITHUB_TOKEN is not set');
        const configDir = process.env.CONFIG_DIR ?? 'config';
        const read = (file: string) => parseYaml(readFileSync(join(configDir, file), 'utf8'));
        const { login } = read('daily.yaml') as { login: string };
        const { orgs } = read('prStats.yaml') as { orgs: string[] };
        return run(
          { date, range, upload: !values['no-upload'], config: { login, orgs, token } },
          {
            fetch,
            sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
            now: () => new Date(),
            publish,
          },
        );
      },
      publish,
    ),
  );
}
