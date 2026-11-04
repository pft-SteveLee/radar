import { createServer } from 'node:http';
import { readCostLines } from '../lib/claude.ts';
import { readRuns } from '../lib/runLog.ts';
import { renderPage, summarizeMonth } from './status.ts';

const MONTHLY_BUDGET_USD = 100;
const RUNS_SHOWN = 30;
const MAX_AGE_HOURS = { reddit_digest: 26 };

export function createStatusServer() {
  return createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    try {
      const html = renderPage({
        summary: summarizeMonth(readCostLines(), new Date()),
        runs: readRuns(RUNS_SHOWN),
        budgetUsd: MONTHLY_BUDGET_USD,
        now: new Date(),
        maxAgeHours: MAX_AGE_HOURS,
      });
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
