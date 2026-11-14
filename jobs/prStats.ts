import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { type RunResult, recordRun } from '../lib/runLog.ts';
import { load, save } from '../lib/state.ts';

const JOB = 'pr_stats';
const DAY_MS = 86_400_000;
const PAGE_SIZE = 100;
const SEARCH_RESULT_LIMIT = 1000;
const REQUEST_SPACING_MS = 2100;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const SERVER_ERROR_WAIT_MS = 5000;
const GRAPHQL_URL = 'https://api.github.com/graphql';

export interface Deps {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
}

export interface Config {
  orgs: string[];
  token: string;
}

export interface WeekFile {
  week: string;
  fetchedAt: string;
  counts: Record<string, number>;
  truncated?: true;
  commits?: Record<string, number>;
}

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const toDay = (date: Date) => date.toISOString().slice(0, 10);
const mondayBased = (date: Date) => (date.getUTCDay() + 6) % 7;

export function isoWeek(day: string): string {
  const date = toDate(day);
  const thursday = new Date(date.getTime() + (3 - mondayBased(date)) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const number = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `${year}-W${String(number).padStart(2, '0')}`;
}

export function weekStart(week: string): string {
  const [year, number] = week.split('-W').map(Number);
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const firstMonday = januaryFourth.getTime() - mondayBased(januaryFourth) * DAY_MS;
  return toDay(new Date(firstMonday + (number - 1) * 7 * DAY_MS));
}

export function weeksBetween(from: string, to: string): string[] {
  const weeks: string[] = [];
  const last = toDate(weekStart(isoWeek(to))).getTime();
  for (
    let monday = toDate(weekStart(isoWeek(from))).getTime();
    monday <= last;
    monday += 7 * DAY_MS
  )
    weeks.push(isoWeek(toDay(new Date(monday))));
  return weeks;
}

export function waitMilliseconds(response: Response, now: Date): number | null {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (retryAfter) return (retryAfter + 1) * 1000;
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (response.headers.get('x-ratelimit-remaining') === '0' && reset)
    return Math.max(reset * 1000 - now.getTime(), 0) + 1000;
  return response.status === 429 ? 60_000 : null;
}

async function request<T>(url: string, token: string, deps: Deps, body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'radar',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (body === undefined || attempt >= MAX_ATTEMPTS) throw error;
      await deps.sleep(SERVER_ERROR_WAIT_MS);
      continue;
    }
    if (response.ok) return (await response.json()) as T;
    const wait =
      response.status === 403 || response.status === 429
        ? waitMilliseconds(response, deps.now())
        : body !== undefined && response.status >= 500
          ? SERVER_ERROR_WAIT_MS
          : null;
    if (wait === null || attempt >= MAX_ATTEMPTS) throw new Error(`HTTP ${response.status}`);
    await deps.sleep(wait);
  }
}

const search = (url: string, token: string, deps: Deps) =>
  request<{ total_count: number; items: { user: { login: string } | null }[] }>(url, token, deps);

export async function graphql<T>(
  query: string,
  variables: Record<string, string | null>,
  token: string,
  deps: Deps,
): Promise<T> {
  const result = await request<{ data: T; errors?: { type?: string; message: string }[] }>(
    GRAPHQL_URL,
    token,
    deps,
    { query, variables },
  );
  // A node deleted since it was listed comes back as null data plus NOT_FOUND, not as an HTTP error.
  const failure = result.errors?.find((error) => error.type !== 'NOT_FOUND');
  if (failure) throw new Error(failure.message);
  return result.data;
}

export interface Page<Node> {
  nodes: Node[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export async function allPages<Node>(
  read: (after: string | null) => Promise<Page<Node>>,
): Promise<Node[]> {
  const nodes: Node[] = [];
  for (let after: string | null = null; ; ) {
    const page = await read(after);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    after = page.pageInfo.endCursor;
  }
}

export const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const REPOS_QUERY = `query Repos($org: String!, $after: String) {
  organization(login: $org) { repositories(first: 100, after: $after, isFork: false) { nodes { name } ${PAGE_INFO} } }
}`;
const BRANCHES_QUERY = `query Branches($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 100, after: $after) {
      nodes { id target { ... on Commit { committedDate } } } ${PAGE_INFO}
    }
  }
}`;
const HISTORY_QUERY = `query History($id: ID!, $since: GitTimestamp!, $until: GitTimestamp!, $after: String) {
  node(id: $id) { ... on Ref { target { ... on Commit {
    history(since: $since, until: $until, first: 100, after: $after) {
      nodes { oid committedDate parents { totalCount } author { user { login } } } ${PAGE_INFO}
    }
  } } } }
}`;

interface HistoryCommit {
  oid: string;
  committedDate: string;
  parents: { totalCount: number };
  author: { user: { login: string } | null } | null;
}

const taipeiWeek = (instant: string) =>
  isoWeek(new Date(instant).toLocaleDateString('sv', { timeZone: 'Asia/Taipei' }));

export async function orgRepositories(org: string, token: string, deps: Deps): Promise<string[]> {
  const repositories = await allPages((after) =>
    graphql<{ organization: { repositories: Page<{ name: string }> } | null }>(
      REPOS_QUERY,
      { org, after },
      token,
      deps,
    ).then((data) => {
      if (!data.organization) throw new Error(`organization ${org} cannot be read`);
      return data.organization.repositories;
    }),
  );
  return repositories.map(({ name }) => name);
}

const emptyPage = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

// Commits of every branch whose tip is at or after `since`, once per repo by oid.
// `historyQuery` takes $id (the branch) and $after plus `variables`.
export async function branchCommits<Commit extends { oid: string }>(
  repo: { owner: string; name: string },
  since: string,
  historyQuery: string,
  variables: Record<string, string>,
  token: string,
  deps: Deps,
): Promise<Commit[]> {
  // Branches are filtered here: their order by tip date is not reliable, so every page is read.
  const branches = await allPages((after) =>
    graphql<{
      repository: {
        refs: Page<{ id: string; target: { committedDate?: string } | null }>;
      } | null;
    }>(BRANCHES_QUERY, { ...repo, after }, token, deps).then(
      (data) => data.repository?.refs ?? emptyPage,
    ),
  );
  const byOid = new Map<string, Commit>();
  for (const branch of branches) {
    const tip = branch.target?.committedDate;
    if (!tip || Date.parse(tip) < Date.parse(since)) continue;
    const commits = await allPages((after) =>
      graphql<{ node: { target: { history: Page<Commit> } } | null }>(
        historyQuery,
        { ...variables, id: branch.id, after },
        token,
        deps,
      ).then((data) => data.node?.target.history ?? emptyPage),
    );
    for (const commit of commits) if (!byOid.has(commit.oid)) byOid.set(commit.oid, commit);
  }
  return [...byOid.values()];
}

export async function fetchCommits(
  from: string,
  to: string,
  config: Config,
  deps: Deps,
): Promise<{ weeks: Record<string, Record<string, number>>; warnings: string[] }> {
  const since = `${weekStart(isoWeek(from))}T00:00:00+08:00`;
  const until = `${toDay(new Date(toDate(weekStart(isoWeek(to))).getTime() + 7 * DAY_MS))}T00:00:00+08:00`;
  const weeks: Record<string, Record<string, number>> = {};
  const warnings: string[] = [];
  for (const org of config.orgs) {
    for (const name of await orgRepositories(org, config.token, deps)) {
      try {
        const commits = await branchCommits<HistoryCommit>(
          { owner: org, name },
          since,
          HISTORY_QUERY,
          { since, until },
          config.token,
          deps,
        );
        for (const commit of commits) {
          const login = commit.author?.user?.login;
          if (!login || commit.parents.totalCount > 1) continue;
          const week = taipeiWeek(commit.committedDate);
          weeks[week] = { ...weeks[week], [login]: (weeks[week]?.[login] ?? 0) + 1 };
        }
      } catch (error) {
        warnings.push(`commits ${org}/${name}: ${(error as Error).message}`);
      }
    }
  }
  return { weeks, warnings };
}

export async function fetchWeek(
  week: string,
  config: Config,
  deps: Deps,
): Promise<{ counts: Record<string, number>; warnings: string[]; truncated: boolean }> {
  const monday = weekStart(week);
  const sunday = toDay(new Date(toDate(monday).getTime() + 6 * DAY_MS));
  const orgs = config.orgs.map((org) => `org:${org}`).join(' ');
  const query = `${orgs} is:pr is:merged merged:${monday}T00:00:00+08:00..${sunday}T23:59:59+08:00`;
  const counts: Record<string, number> = {};
  const warnings: string[] = [];
  for (let page = 1; ; page++) {
    if (page > 1) await deps.sleep(REQUEST_SPACING_MS);
    const parameters = new URLSearchParams({
      q: query,
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const result = await search(
      `https://api.github.com/search/issues?${parameters}`,
      config.token,
      deps,
    );
    for (const item of result.items) {
      const login = item.user?.login ?? 'ghost';
      counts[login] = (counts[login] ?? 0) + 1;
    }
    const reachable = Math.min(result.total_count, SEARCH_RESULT_LIMIT);
    if (result.items.length < PAGE_SIZE || page * PAGE_SIZE >= reachable) {
      const truncated = result.total_count > SEARCH_RESULT_LIMIT;
      if (truncated)
        warnings.push(
          `${week}: ${result.total_count} merged PRs, only the first ${SEARCH_RESULT_LIMIT} were counted`,
        );
      return { counts, warnings, truncated };
    }
  }
}

function keptCommits(week: string, outputDir: string) {
  try {
    const commits = load<WeekFile | null>(`prStats/${week}`, null, outputDir)?.commits;
    return commits && { commits };
  } catch {
    return undefined;
  }
}

export async function run(
  options: { from: string; to: string; config: Config },
  deps: Deps,
): Promise<RunResult> {
  const weeks = weeksBetween(options.from, options.to);
  const outputDir = process.env.OUTPUT_DIR ?? 'output';
  const warnings: string[] = [];
  const errors: string[] = [];
  let commits: Awaited<ReturnType<typeof fetchCommits>>['weeks'] | null = null;
  try {
    const result = await fetchCommits(options.from, options.to, options.config, deps);
    if (result.warnings.length === 0) commits = result.weeks;
    warnings.push(...result.warnings);
  } catch (error) {
    warnings.push(`commits: ${(error as Error).message}`);
  }
  for (const [index, week] of weeks.entries()) {
    if (index > 0) await deps.sleep(REQUEST_SPACING_MS);
    try {
      const result = await fetchWeek(week, options.config, deps);
      warnings.push(...result.warnings);
      const file: WeekFile = {
        week,
        fetchedAt: deps.now().toISOString(),
        counts: result.counts,
        ...(result.truncated && { truncated: true as const }),
        ...(commits ? { commits: commits[week] ?? {} } : keptCommits(week, outputDir)),
      };
      save(`prStats/${week}`, file, outputDir);
    } catch (error) {
      errors.push(`${week}: ${(error as Error).message}`);
    }
  }
  if (errors.length === weeks.length) throw new Error(errors[0]);
  return { url: null, warnings: [...errors, ...warnings] };
}

if (import.meta.main) {
  const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Taipei' });
  const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' } } });
  const to = values.to ?? today;
  const from = values.from ?? toDay(new Date(toDate(to).getTime() - 7 * DAY_MS));
  for (const day of [from, to])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
      throw new Error(`--from/--to must be YYYY-MM-DD, got ${day}`);
  await recordRun(JOB, () => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is not set');
    const configFile = parseYaml(
      readFileSync(join(process.env.CONFIG_DIR ?? 'config', 'prStats.yaml'), 'utf8'),
    ) as { orgs: string[] };
    return run(
      { from, to, config: { orgs: configFile.orgs, token } },
      {
        fetch,
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        now: () => new Date(),
      },
    );
  });
}
