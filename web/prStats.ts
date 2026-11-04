import type { WeekFile } from '../jobs/prStats.ts';
import { load } from '../lib/state.ts';
import { BASE_CSS, escapeHtml } from './status.ts';

export interface WeekCounts {
  week: string;
  counts: Record<string, number> | null;
}

export interface Range {
  from: string;
  to: string;
  weeks: number | null;
}

const DAY_MS = 86_400_000;
const WEEK_CHOICES = [12, 26, 52];
const DEFAULT_WEEKS = 26;
const MAX_RANGE_DAYS = 3 * 366;
const COLORS = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
];
const CHART = { width: 800, height: 260, left: 32, right: 8, top: 8, bottom: 24 };

const isDay = (value: string | null): value is string =>
  value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const daysBefore = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

export function parseRange(query: URLSearchParams, today: string): Range {
  const from = query.get('from');
  const to = query.get('to');
  if (
    isDay(from) &&
    isDay(to) &&
    from <= to &&
    Date.parse(to) - Date.parse(from) <= MAX_RANGE_DAYS * DAY_MS
  )
    return { from, to, weeks: null };
  const requested = Number(query.get('weeks'));
  const weeks = WEEK_CHOICES.includes(requested) ? requested : DEFAULT_WEEKS;
  return { from: daysBefore(today, (weeks - 1) * 7), to: today, weeks };
}

export function readWeeks(weeks: string[]): WeekCounts[] {
  const outputDir = process.env.OUTPUT_DIR ?? 'output';
  return weeks.map((week) => ({
    week,
    counts: load<WeekFile | null>(`prStats/${week}`, null, outputDir)?.counts ?? null,
  }));
}

const countOf = (week: WeekCounts, member: string) =>
  week.counts === null ? null : (week.counts[member] ?? 0);

interface Series {
  name: string;
  values: (number | null)[];
}

const teamTotal = (week: WeekCounts, members: string[]) =>
  week.counts === null
    ? null
    : members.reduce((total, member) => total + (countOf(week, member) ?? 0), 0);

function chart(weeks: WeekCounts[], series: Series[], label: string): string {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const highest = Math.max(1, ...series.flatMap((line) => line.values.map((value) => value ?? 0)));
  const x = (index: number) => CHART.left + (index * plotWidth) / Math.max(weeks.length - 1, 1);
  const y = (count: number) => CHART.top + (1 - count / highest) * plotHeight;
  const lines = series.map((line, lineIndex) => {
    const color = COLORS[lineIndex % COLORS.length];
    let penDown = false;
    let path = '';
    const dots: string[] = [];
    for (const [index, value] of line.values.entries()) {
      if (value === null) {
        penDown = false;
        continue;
      }
      path += `${penDown ? 'L' : 'M'}${x(index).toFixed(1)} ${y(value).toFixed(1)} `;
      penDown = true;
      dots.push(
        `<circle cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="2.5" fill="${color}"><title>${escapeHtml(line.name)} ${weeks[index].week}: ${value}</title></circle>`,
      );
    }
    return `<path data-member="${escapeHtml(line.name)}" d="${path.trim()}" fill="none" stroke="${color}" stroke-width="2"/>\n${dots.join('')}`;
  });
  const firstWeek = weeks[0]?.week ?? '';
  const lastWeek = weeks.at(-1)?.week ?? '';
  return `<svg viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-label="${label}，${firstWeek} 到 ${lastWeek}">
<line x1="${CHART.left}" y1="${CHART.top + plotHeight}" x2="${CHART.width - CHART.right}" y2="${CHART.top + plotHeight}" class="axis"/>
<text x="${CHART.left - 6}" y="${CHART.top + 10}" text-anchor="end">${highest}</text>
<text x="${CHART.left - 6}" y="${CHART.top + plotHeight}" text-anchor="end">0</text>
<text x="${CHART.left}" y="${CHART.height - 6}">${firstWeek}</text>
<text x="${CHART.width - CHART.right}" y="${CHART.height - 6}" text-anchor="end">${lastWeek}</text>
${lines.join('\n')}
</svg>
<ul class="legend">
${series.map((line, index) => `<li><span style="background:${COLORS[index % COLORS.length]}"></span>${escapeHtml(line.name)}</li>`).join('\n')}
</ul>`;
}

function teamChart(weeks: WeekCounts[], members: string[]): string {
  const totals = weeks.map((week) => teamTotal(week, members));
  const averages = totals.map((total) =>
    total === null ? null : Math.round((total / members.length) * 10) / 10,
  );
  return chart(
    weeks,
    [
      { name: '合計', values: totals },
      { name: '人均', values: averages },
    ],
    '團隊每週 merged PR 合計與人均',
  );
}

function memberChart(weeks: WeekCounts[], members: string[]): string {
  return chart(
    weeks,
    members.map((member) => ({ name: member, values: weeks.map((week) => countOf(week, member)) })),
    '每位成員每週 merged PR 數',
  );
}

function table(weeks: WeekCounts[], members: string[]): string {
  const header = members.map((member) => `<th scope="col">${escapeHtml(member)}</th>`).join('');
  const rows = weeks
    .map((week) => {
      const cells = members.map((member) => `<td>${countOf(week, member) ?? '—'}</td>`).join('');
      return `<tr><th scope="row">${week.week}</th>${cells}<td>${teamTotal(week, members) ?? '—'}</td></tr>`;
    })
    .join('\n');
  return `<div class="scroll"><table>
<caption>每週 merged PR 數（— 表示該週尚未抓取）</caption>
<thead><tr><th scope="col">週</th>${header}<th scope="col">合計</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

export function renderPrPage({
  weeks,
  members,
  range,
}: {
  weeks: WeekCounts[];
  members: string[];
  range: Range;
}): string {
  const choices = WEEK_CHOICES.map((choice) =>
    choice === range.weeks
      ? `<strong>${choice} 週</strong>`
      : `<a href="/prs?weeks=${choice}">${choice} 週</a>`,
  ).join(' · ');
  const content = members.length
    ? `<h2>團隊</h2>\n${teamChart(weeks, members)}\n<h2>個人</h2>\n${memberChart(weeks, members)}\n${table(weeks, members)}`
    : '<p>請在 config/prStats.yaml 填 members（GitHub 帳號）</p>';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>radar PR 趨勢</title>
<style>
${BASE_CSS}
svg { width: 100%; height: auto; font-size: 11px; fill: var(--muted); }
svg .axis { stroke: var(--line); }
form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.5rem 0 1rem; }
.legend { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
.legend span { display: inline-block; width: 0.8rem; height: 0.8rem; margin-right: 0.3rem; vertical-align: middle; }
</style>
</head>
<body>
<h1>每週 merged PR 數</h1>
<p><a href="/">← 狀態</a></p>
<p>${choices}</p>
<form method="get" action="/prs">
<label>從 <input type="date" name="from" value="${range.from}"></label>
<label>到 <input type="date" name="to" value="${range.to}"></label>
<button type="submit">顯示</button>
</form>
${content}
</body>
</html>
`;
}
