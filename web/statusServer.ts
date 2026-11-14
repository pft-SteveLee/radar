import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { weeksBetween } from '../jobs/prStats.ts';
import { readCostLines } from '../lib/claude.ts';
import { readRuns } from '../lib/runLog.ts';
import { parseMetric, parseRange, readWeeks, renderPrPage } from './prStats.ts';
import { renderPage, summarizeMonth } from './status.ts';

const MONTHLY_BUDGET_USD = 100;
const MAX_AGE_HOURS = {
  pr_stats: 26,
  reddit_digest: 26,
  changelog_watch: 8 * 24,
  dev_weekly: 8 * 24,
  daily_report: 4 * 24,
};

function prMembers(): string[] {
  try {
    const config = parseYaml(
      readFileSync(join(process.env.CONFIG_DIR ?? 'config', 'prStats.yaml'), 'utf8'),
    ) as { members?: unknown } | null;
    if (!Array.isArray(config?.members)) return [];
    const firstSpelling = new Map<string, string>();
    for (const member of config.members.map(String))
      if (!firstSpelling.has(member.toLowerCase())) firstSpelling.set(member.toLowerCase(), member);
    return [...firstSpelling.values()];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function statusPage(): string {
  return renderPage({
    summary: summarizeMonth(readCostLines(), new Date()),
    runs: readRuns(Number.POSITIVE_INFINITY),
    budgetUsd: MONTHLY_BUDGET_USD,
    now: new Date(),
    maxAgeHours: MAX_AGE_HOURS,
  });
}

function prPage(query: URLSearchParams): string {
  const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Taipei' });
  const range = parseRange(query, today);
  const metric = parseMetric(query);
  const lastSuccess = readRuns(Number.POSITIVE_INFINITY).find(
    (run) => run.job === 'pr_stats' && run.status === 'ok',
  );
  return renderPrPage({
    weeks: readWeeks(weeksBetween(range.from, range.to), metric),
    members: prMembers(),
    range,
    today,
    now: new Date(),
    maxAgeHours: MAX_AGE_HOURS.pr_stats,
    updatedAt: lastSuccess?.startedAt ?? null,
    metric,
  });
}

const PAGES: Record<string, (query: URLSearchParams) => string> = {
  '/': statusPage,
  '/prs': prPage,
};

export function createStatusServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const page = PAGES[url.pathname];
    if (request.method !== 'GET' || !page) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    try {
      const html = page(url.searchParams);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    } catch (error) {
      console.error(error);
      response
        .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Internal error');
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  createStatusServer().listen(port, () => console.log(`status page on :${port}`));
}
