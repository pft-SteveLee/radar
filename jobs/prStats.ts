import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { type RunResult, recordRun } from '../lib/runLog.ts';
import { save } from '../lib/state.ts';

const JOB = 'pr_stats';
const DAY_MS = 86_400_000;
const PAGE_SIZE = 100;
const SEARCH_RESULT_LIMIT = 1000;
const REQUEST_SPACING_MS = 2100;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

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

async function search(url: string, token: string, deps: Deps) {
  for (let attempt = 1; ; attempt++) {
    const response = await deps.fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'radar',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok)
      return (await response.json()) as {
        total_count: number;
        items: { user: { login: string } | null }[];
      };
    const wait =
      response.status === 403 || response.status === 429
        ? waitMilliseconds(response, deps.now())
        : null;
    if (wait === null || attempt >= MAX_ATTEMPTS) throw new Error(`HTTP ${response.status}`);
    await deps.sleep(wait);
  }
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

export async function run(
  options: { from: string; to: string; config: Config },
  deps: Deps,
): Promise<RunResult> {
  const weeks = weeksBetween(options.from, options.to);
  const warnings: string[] = [];
  const errors: string[] = [];
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
      };
      save(`prStats/${week}`, file, process.env.OUTPUT_DIR ?? 'output');
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
