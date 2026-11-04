import type { CostLine } from '../lib/claude.ts';
import type { RunRecord } from '../lib/runLog.ts';

export interface MonthSummary {
  month: string;
  totalUsd: number;
  byJob: { job: string; usd: number }[];
}

const TIME_ZONE = 'Asia/Taipei';
const taipeiTime = (iso: string) =>
  new Date(iso).toLocaleString('sv', { timeZone: TIME_ZONE }).slice(0, 16);

export function summarizeMonth(lines: CostLine[], now: Date): MonthSummary {
  const month = taipeiTime(now.toISOString()).slice(0, 7);
  const usdByJob = new Map<string, number>();
  for (const line of lines) {
    if (taipeiTime(line.ts).slice(0, 7) !== month) continue;
    usdByJob.set(line.job, (usdByJob.get(line.job) ?? 0) + line.usd);
  }
  const byJob = [...usdByJob].map(([job, usd]) => ({ job, usd })).sort((a, b) => b.usd - a.usd);
  return { month, totalUsd: byJob.reduce((total, entry) => total + entry.usd, 0), byJob };
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const dollars = (usd: number) => `$${usd.toFixed(2)}`;

function duration(run: RunRecord): string {
  const seconds = Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function runRow(run: RunRecord): string {
  const failed = run.status === 'failed';
  const note =
    run.url && /^https?:\/\//.test(run.url) ? `<a href="${escapeHtml(run.url)}">筆記</a>` : '—';
  const detail = failed ? `<br><span class="error">${escapeHtml(run.error ?? '')}</span>` : '';
  return `<tr${failed ? ' class="failed"' : ''}>
<td>${escapeHtml(run.job)}</td>
<td>${taipeiTime(run.startedAt)}</td>
<td>${duration(run)}</td>
<td>${failed ? '失敗' : '成功'}${detail}</td>
<td>${run.warnings.length ? `警告 ${run.warnings.length}` : '—'}</td>
<td>${dollars(run.costUsd)}</td>
<td>${note}</td>
</tr>`;
}

interface PageInput {
  summary: MonthSummary;
  runs: RunRecord[];
  budgetUsd: number;
}

export function renderPage({ summary, runs, budgetUsd }: PageInput): string {
  const percent = Math.round((summary.totalUsd / budgetUsd) * 100);
  const jobRows = summary.byJob
    .map((entry) => `<tr><td>${escapeHtml(entry.job)}</td><td>${dollars(entry.usd)}</td></tr>`)
    .join('\n');
  const runTable = runs.length
    ? `<div class="scroll"><table>
<caption>最近 ${runs.length} 次執行</caption>
<thead><tr><th scope="col">Job</th><th scope="col">開始時間</th><th scope="col">耗時</th><th scope="col">結果</th><th scope="col">警告</th><th scope="col">花費</th><th scope="col">筆記</th></tr></thead>
<tbody>
${runs.map(runRow).join('\n')}
</tbody>
</table></div>`
    : '<p>尚無執行紀錄</p>';

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>radar 狀態</title>
<style>
:root { --bg: #fafaf9; --text: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #2563eb; --bad: #b91c1c; --bad-bg: #fee2e2; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --text: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #60a5fa; --bad: #fca5a5; --bad-bg: #450a0a; }
}
body { margin: 0 auto; max-width: 64rem; padding: 1rem; background: var(--bg); color: var(--text); font-family: system-ui, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; line-height: 1.5; }
h1 { font-size: 1.25rem; }
h2 { font-size: 1.05rem; margin-top: 2rem; }
progress { width: 100%; height: 0.75rem; accent-color: var(--accent); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
caption { text-align: left; color: var(--muted); padding-bottom: 0.5rem; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
tr.failed { background: var(--bad-bg); color: var(--bad); }
.error { word-break: break-word; }
a { color: var(--accent); }
</style>
</head>
<body>
<h1>radar 狀態</h1>
<h2>${summary.month} 花費</h2>
<p>${dollars(summary.totalUsd)} / $${budgetUsd}（${percent}%）</p>
<progress value="${summary.totalUsd}" max="${budgetUsd}" aria-label="本月花費佔額度"></progress>
<table>
<caption>各 job 本月花費</caption>
<thead><tr><th scope="col">Job</th><th scope="col">花費</th></tr></thead>
<tbody>
${jobRows}
</tbody>
</table>
<h2>執行紀錄</h2>
${runTable}
</body>
</html>
`;
}
