import type { CostLine } from '../lib/claude.ts';
import type { RunRecord } from '../lib/runLog.ts';

export interface MonthSummary {
  month: string;
  totalUsd: number;
  byJob: { job: string; usd: number }[];
}

const TIME_ZONE = 'Asia/Taipei';
export const taipeiTime = (iso: string) =>
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

export const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const BASE_CSS = `:root { color-scheme: light dark; --bg: #fafaf9; --text: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #2563eb; --bad: #b91c1c; --bad-bg: #fee2e2; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --text: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #60a5fa; --bad: #fca5a5; --bad-bg: #450a0a; }
}
body { margin: 0 auto; max-width: 64rem; padding: 1rem; background: var(--bg); color: var(--text); font-family: system-ui, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; line-height: 1.5; }
h1 { font-size: 1.25rem; }
h2 { font-size: 1.05rem; margin-top: 2rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
caption { text-align: left; color: var(--muted); padding-bottom: 0.5rem; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
a { color: var(--accent); }
nav a { display: inline-block; padding: 0.4rem 0.5rem; }
nav strong { display: inline-block; padding: 0.4rem 0.5rem; }
th[scope="row"] { white-space: nowrap; }
td a { white-space: nowrap; }
input, button { min-height: 2rem; font: inherit; }
.hint { display: none; }
@media (max-width: 40rem) { .hint { display: inline; } }`;

const dollars = (usd: number) => `$${usd.toFixed(2)}`;

function duration(run: RunRecord): string {
  const seconds = Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function runRow(run: RunRecord): string {
  const failed = run.status === 'failed';
  const note =
    run.url && /^https?:\/\//.test(run.url) ? `<a href="${escapeHtml(run.url)}">筆記</a>` : '—';
  const detail = failed
    ? `\n<tr class="failed"><td colspan="7" class="error">${escapeHtml(run.error || '無錯誤訊息')}</td></tr>`
    : '';
  return `<tr${failed ? ' class="failed"' : ''}>
<td>${escapeHtml(run.job)}</td>
<td>${taipeiTime(run.startedAt)}</td>
<td>${duration(run)}</td>
<td>${failed ? '失敗' : '成功'}</td>
<td>${warningsCell(run.warnings)}</td>
<td>${dollars(run.costUsd)}</td>
<td>${note}</td>
</tr>${detail}`;
}

interface PageInput {
  summary: MonthSummary;
  runs: RunRecord[];
  budgetUsd: number;
  now: Date;
  maxAgeHours: Record<string, number>;
}

function freshnessItem(job: string, limitHours: number, runs: RunRecord[], now: Date): string {
  const lastSuccess = runs.find((run) => run.job === job && run.status === 'ok');
  const lastFailure = runs.find(
    (run) =>
      run.job === job &&
      run.status === 'failed' &&
      (!lastSuccess || Date.parse(run.startedAt) > Date.parse(lastSuccess.startedAt)),
  );
  const reason = lastFailure
    ? `，最近一次：${taipeiTime(lastFailure.startedAt)} 失敗：${escapeHtml(lastFailure.error || '無錯誤訊息')}`
    : '';
  const overdue = `，已逾時（上限 ${limitHours} 小時）`;
  if (!lastSuccess)
    return `<li class="stale">${escapeHtml(job)} 尚無成功紀錄${overdue}${reason}</li>`;
  const hours = Math.floor((now.getTime() - Date.parse(lastSuccess.startedAt)) / 3_600_000);
  const text = `${escapeHtml(job)} 上次成功：${hours} 小時前（${taipeiTime(lastSuccess.startedAt)}）`;
  return hours > limitHours
    ? `<li class="stale">${text}${overdue}${reason}</li>`
    : `<li>${text}${reason}</li>`;
}

function warningsCell(warnings: string[]): string {
  if (!warnings.length) return '—';
  const items = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  return `<details><summary>警告 ${warnings.length}</summary><ul>${items}</ul></details>`;
}

function budgetLine(totalUsd: number, budgetUsd: number): string {
  const ratio = (totalUsd / budgetUsd) * 100;
  const percent = totalUsd > 0 && ratio < 1 ? '&lt;1' : String(Math.round(ratio));
  const text = `${dollars(totalUsd)} / $${budgetUsd}（${percent}%）`;
  return totalUsd > budgetUsd ? `<p class="over">${text}，已超支</p>` : `<p>${text}</p>`;
}

export function renderPage({ summary, runs, budgetUsd, now, maxAgeHours }: PageInput): string {
  const freshness = Object.entries(maxAgeHours)
    .map(([job, limitHours]) => freshnessItem(job, limitHours, runs, now))
    .join('\n');
  const jobRows = summary.byJob
    .map((entry) => `<tr><td>${escapeHtml(entry.job)}</td><td>${dollars(entry.usd)}</td></tr>`)
    .join('\n');
  const runTable = runs.length
    ? `<div class="scroll"><table>
<caption>最近 ${runs.length} 次執行<span class="hint">（可左右捲動）</span></caption>
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
${BASE_CSS}
progress { width: 100%; height: 0.75rem; accent-color: var(--accent); }
tr.failed { background: var(--bad-bg); color: var(--bad); }
tr.failed a { color: inherit; text-decoration: underline; }
.freshness { list-style: none; padding: 0; }
.freshness li { padding: 0.4rem 0.6rem; }
.freshness li.stale { background: var(--bad-bg); color: var(--bad); font-weight: 600; }
.error { word-break: break-word; }
.over { color: var(--bad); font-weight: 600; }
</style>
</head>
<body>
<main>
<h1>radar 狀態</h1>
<nav aria-label="頁面"><a href="/prs">PR 趨勢</a></nav>
<ul class="freshness">
${freshness}
</ul>
<h2>${summary.month} 花費</h2>
${budgetLine(summary.totalUsd, budgetUsd)}
<progress value="${summary.totalUsd.toFixed(2)}" max="${budgetUsd}" aria-label="本月花費佔額度"></progress>
<table>
<caption>各 job 本月花費</caption>
<thead><tr><th scope="col">Job</th><th scope="col">花費</th></tr></thead>
<tbody>
${jobRows}
</tbody>
</table>
<h2>執行紀錄</h2>
${runTable}
</main>
</body>
</html>
`;
}
