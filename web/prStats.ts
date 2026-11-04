import { isoWeek, type WeekFile } from '../jobs/prStats.ts';
import { load } from '../lib/state.ts';
import { BASE_CSS, escapeHtml, taipeiTime } from './status.ts';

export interface WeekCounts {
  week: string;
  counts: Record<string, number> | null;
}

export interface Range {
  from: string;
  to: string;
  weeks: number | null;
  invalid: boolean;
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
const GAP_LABEL_MIN_WIDTH = 80;

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
    return { from, to, weeks: null, invalid: false };
  const requested = Number(query.get('weeks'));
  const weeksAreValid = WEEK_CHOICES.includes(requested);
  const weeks = weeksAreValid ? requested : DEFAULT_WEEKS;
  const invalid = query.has('from') || query.has('to') || (query.has('weeks') && !weeksAreValid);
  return { from: daysBefore(today, (weeks - 1) * 7), to: today, weeks, invalid };
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

const teamAverage = (week: WeekCounts, members: string[]) => {
  const total = teamTotal(week, members);
  return total === null ? null : Math.round((total / members.length) * 10) / 10;
};

function unfetchedRuns(weeks: WeekCounts[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const [index, week] of weeks.entries()) {
    if (week.counts !== null) continue;
    const last = runs.at(-1);
    if (last && last[1] === index - 1) last[1] = index;
    else runs.push([index, index]);
  }
  return runs;
}

function chart(
  weeks: WeekCounts[],
  series: Series[],
  label: string,
  currentWeek: string | null,
): string {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const step = plotWidth / Math.max(weeks.length - 1, 1);
  const highest = Math.max(1, ...series.flatMap((line) => line.values.map((value) => value ?? 0)));
  const x = (index: number) => CHART.left + index * step;
  const y = (count: number) => CHART.top + (1 - count / highest) * plotHeight;
  const pendingIndex = weeks.findIndex((week) => week.week === currentWeek);
  const bands = unfetchedRuns(weeks).map(([first, last]) => {
    const left = Math.max(CHART.left, x(first) - step / 2);
    const right = Math.min(CHART.width - CHART.right, x(last) + step / 2);
    const text =
      right - left >= GAP_LABEL_MIN_WIDTH
        ? `<text x="${((left + right) / 2).toFixed(1)}" y="${CHART.top + plotHeight / 2}" text-anchor="middle">未抓取</text>`
        : '';
    return `<rect x="${left.toFixed(1)}" y="${CHART.top}" width="${(right - left).toFixed(1)}" height="${plotHeight}" class="gap"><title>未抓取</title></rect>${text}`;
  });
  const lines = series.map((line, lineIndex) => {
    const color = COLORS[lineIndex % COLORS.length];
    const name = escapeHtml(line.name);
    let penDown = false;
    let path = '';
    const dots: string[] = [];
    for (const [index, value] of line.values.entries()) {
      if (value === null || index === pendingIndex) {
        penDown = false;
        continue;
      }
      path += `${penDown ? 'L' : 'M'}${x(index).toFixed(1)} ${y(value).toFixed(1)} `;
      penDown = true;
      dots.push(
        `<circle cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="2.5" fill="${color}"><title>${name} ${weeks[index].week}: ${value}</title></circle>`,
      );
    }
    let pending = '';
    const pendingValue = line.values[pendingIndex];
    if (pendingIndex >= 0 && pendingValue !== null && pendingValue !== undefined) {
      const before = line.values[pendingIndex - 1];
      if (before !== null && before !== undefined)
        pending += `<path data-pending="${name}" d="M${x(pendingIndex - 1).toFixed(1)} ${y(before).toFixed(1)} L${x(pendingIndex).toFixed(1)} ${y(pendingValue).toFixed(1)}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="4 4"/>`;
      pending += `<circle data-pending="${name}" cx="${x(pendingIndex).toFixed(1)}" cy="${y(pendingValue).toFixed(1)}" r="3" fill="var(--bg)" stroke="${color}" stroke-width="2"><title>${name} ${weeks[pendingIndex].week}（進行中）: ${pendingValue}</title></circle>`;
    }
    return `<path data-member="${name}" d="${path.trim()}" fill="none" stroke="${color}" stroke-width="2"/>\n${dots.join('')}${pending}`;
  });
  const firstWeek = weeks[0]?.week ?? '';
  const lastWeek = weeks.at(-1)?.week ?? '';
  return `<svg viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-label="${label}，${firstWeek} 到 ${lastWeek}">
${bands.join('\n')}
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

function teamChart(weeks: WeekCounts[], members: string[], currentWeek: string): string {
  return chart(
    weeks,
    [{ name: '合計', values: weeks.map((week) => teamTotal(week, members)) }],
    '團隊每週 merged PR 合計',
    currentWeek,
  );
}

function memberChart(weeks: WeekCounts[], members: string[], currentWeek: string): string {
  return chart(
    weeks,
    members.map((member) => ({ name: member, values: weeks.map((week) => countOf(week, member)) })),
    '每位成員每週 merged PR 數',
    currentWeek,
  );
}

function table(weeks: WeekCounts[], members: string[], currentWeek: string): string {
  const header = members.map((member) => `<th scope="col">${escapeHtml(member)}</th>`).join('');
  const rows = [...weeks]
    .reverse()
    .map((week) => {
      const cells = members.map((member) => `<td>${countOf(week, member) ?? '—'}</td>`).join('');
      const label = week.week === currentWeek ? `${week.week}（進行中）` : week.week;
      return `<tr><th scope="row">${label}</th>${cells}<td>${teamTotal(week, members) ?? '—'}</td><td>${teamAverage(week, members) ?? '—'}</td></tr>`;
    })
    .join('\n');
  return `<div class="scroll"><table>
<caption>每週 merged PR 數，新的在上（— 表示該週尚未抓取）</caption>
<thead><tr><th scope="col">週</th>${header}<th scope="col">合計</th><th scope="col">人均</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

export function renderPrPage({
  weeks,
  members,
  range,
  today,
  updatedAt,
}: {
  weeks: WeekCounts[];
  members: string[];
  range: Range;
  today: string;
  updatedAt: string | null;
}): string {
  const currentWeek = isoWeek(today);
  const choices = WEEK_CHOICES.map((choice) =>
    choice === range.weeks
      ? `<strong>${choice} 週</strong>`
      : `<a href="/prs?weeks=${choice}">${choice} 週</a>`,
  ).join(' · ');
  const content = members.length
    ? `<h2>團隊</h2>\n${teamChart(weeks, members, currentWeek)}\n<h2>個人</h2>\n${memberChart(weeks, members, currentWeek)}\n${table(weeks, members, currentWeek)}`
    : '<p>請在 config/prStats.yaml 填 members（GitHub 帳號）</p>';
  const updated = updatedAt
    ? `<p>資料更新於 ${taipeiTime(updatedAt)}</p>`
    : '<p class="stale">尚無 pr_stats 成功紀錄</p>';
  const notice = range.invalid
    ? `<p class="notice" role="status">日期區間無效，已改顯示近 ${range.weeks ?? DEFAULT_WEEKS} 週</p>`
    : '';
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
svg .gap { fill: var(--line); opacity: 0.5; }
form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.5rem 0 1rem; }
.legend { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
.legend span { display: inline-block; width: 0.8rem; height: 0.8rem; margin-right: 0.3rem; vertical-align: middle; }
.stale { background: var(--bad-bg); color: var(--bad); font-weight: 600; padding: 0.4rem 0.6rem; }
.notice { color: var(--bad); }
</style>
</head>
<body>
<h1>每週 merged PR 數</h1>
<p><a href="/">← 狀態</a></p>
${updated}
<p>統計已合併（merged）的 PR，依合併時間，台北時間週一到週日。PR 數只反映數量，不代表貢獻大小，建議只看趨勢。</p>
<p>${choices}</p>
${notice}
<form method="get" action="/prs">
<label>從 <input type="date" name="from" value="${range.from}" max="${today}"></label>
<label>到 <input type="date" name="to" value="${range.to}" max="${today}"></label>
<button type="submit">顯示</button>
</form>
${content}
</body>
</html>
`;
}
