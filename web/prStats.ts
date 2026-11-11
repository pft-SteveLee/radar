import { isoWeek, type WeekFile } from '../jobs/prStats.ts';
import { load } from '../lib/state.ts';
import { BASE_CSS, escapeHtml, taipeiTime } from './status.ts';

export interface WeekCounts {
  week: string;
  counts: Record<string, number> | null;
  truncated?: boolean;
  corrupt?: boolean;
}

export type Metric = 'prs' | 'commits';

export interface Range {
  from: string;
  to: string;
  weeks: number | null;
  reason: string | null;
}

const DAY_MS = 86_400_000;
const WEEK_CHOICES = [12, 26, 52];
const DEFAULT_WEEKS = 26;
const MAX_RANGE_DAYS = 2 * 366;
const SERIES_COUNT = 8;
const SHAPES = ['circle', 'square', 'diamond', 'triangle'] as const;
const seriesColor = (index: number) => `var(--s${(index % SERIES_COUNT) + 1})`;

function marker(
  index: number,
  cx: number,
  cy: number,
  options: { hollow: boolean; pending: string | null; title: string; truncated?: boolean },
): string {
  const shape = SHAPES[(index + Math.floor(index / SERIES_COUNT)) % SHAPES.length];
  const color = seriesColor(index);
  const style = options.hollow
    ? `fill:var(--bg);stroke:${color};stroke-width:2`
    : `fill:${color};stroke:none`;
  const pending = options.pending === null ? '' : ` data-pending="${options.pending}"`;
  const truncated = options.truncated ? ' data-truncated="true"' : '';
  const attributes = `data-shape="${shape}"${pending}${truncated} style="${style}"`;
  const [x, y] = [cx.toFixed(1), cy.toFixed(1)];
  const title = `<title>${options.title}</title>`;
  if (shape === 'circle')
    return `<circle cx="${x}" cy="${y}" r="3" ${attributes}>${title}</circle>`;
  if (shape === 'square')
    return `<rect x="${(cx - 3).toFixed(1)}" y="${(cy - 3).toFixed(1)}" width="6" height="6" ${attributes}>${title}</rect>`;
  const points =
    shape === 'diamond'
      ? [
          [cx, cy - 4.5],
          [cx + 4.5, cy],
          [cx, cy + 4.5],
          [cx - 4.5, cy],
        ]
      : [
          [cx, cy - 4.5],
          [cx + 4.5, cy + 3.5],
          [cx - 4.5, cy + 3.5],
        ];
  return `<polygon points="${points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')}" ${attributes}>${title}</polygon>`;
}

const SERIES_CSS = `:root { --s1: #2563eb; --s2: #dc2626; --s3: #16a34a; --s4: #d97706; --s5: #7c3aed; --s6: #0891b2; --s7: #db2777; --s8: #4d7c0f; }
@media (prefers-color-scheme: dark) { :root { --s1: #60a5fa; --s2: #f87171; --s3: #4ade80; --s4: #fbbf24; --s5: #a78bfa; --s6: #22d3ee; --s7: #f472b6; --s8: #a3e635; } }`;
const CHART = { width: 800, height: 272, left: 48, right: 8, top: 14, bottom: 34 };
const X_LABEL_COUNT = 5;
const MAX_GRID_LINES = 4;
const GAP_LABEL_MIN_WIDTH = 80;
const AXIS_LABEL_PADDING = 14;
const AXIS_DIGIT_WIDTH = 18;
const TRUNCATED_NOTE = '（已截斷，數字偏低）';

const isDay = (value: string | null): value is string =>
  value !== null &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const daysBefore = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

export function parseRange(query: URLSearchParams, today: string): Range {
  const from = query.get('from');
  const requestedTo = query.get('to');
  let reason: string | null = null;
  if (query.has('from') || query.has('to')) {
    if (!isDay(from) || !isDay(requestedTo)) reason = '日期格式錯誤';
    else {
      const to = requestedTo > today ? today : requestedTo;
      if (from > to) reason = '起日晚於迄日';
      else if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * DAY_MS) reason = '最長 2 年';
      else return { from, to, weeks: null, reason: null };
    }
  }
  const requested = Number(query.get('weeks'));
  const weeksAreValid = WEEK_CHOICES.includes(requested);
  if (reason === null && query.has('weeks') && !weeksAreValid) reason = 'weeks 只接受 12、26、52';
  const weeks = weeksAreValid ? requested : DEFAULT_WEEKS;
  return { from: daysBefore(today, (weeks - 1) * 7), to: today, weeks, reason };
}

export const parseMetric = (query: URLSearchParams): Metric =>
  query.get('metric') === 'commits' ? 'commits' : 'prs';

const lowercaseKeys = (counts: Record<string, number>) => {
  const merged: Record<string, number> = {};
  for (const [login, count] of Object.entries(counts))
    merged[login.toLowerCase()] = (merged[login.toLowerCase()] ?? 0) + count;
  return merged;
};

export function readWeeks(weeks: string[], metric: Metric = 'prs'): WeekCounts[] {
  const outputDir = process.env.OUTPUT_DIR ?? 'output';
  return weeks.map((week) => {
    try {
      const file = load<WeekFile | null>(`prStats/${week}`, null, outputDir);
      if (file === null) return { week, counts: null };
      const counts = metric === 'commits' ? file.commits : file.counts;
      if (metric === 'commits' && counts === undefined) return { week, counts: null };
      if (typeof counts !== 'object' || counts === null) throw new Error('counts is not an object');
      return {
        week,
        counts: lowercaseKeys(counts),
        truncated: metric === 'prs' && file.truncated === true,
      };
    } catch (error) {
      console.error(`prStats/${week}.json is unreadable`, error);
      return { week, counts: null, corrupt: true };
    }
  });
}

const countOf = (week: WeekCounts, member: string) =>
  week.counts === null ? null : (week.counts[member.toLowerCase()] ?? 0);

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

function unfetchedRuns(weeks: WeekCounts[]): [number, number, boolean][] {
  const runs: [number, number, boolean][] = [];
  for (const [index, week] of weeks.entries()) {
    if (week.counts !== null) continue;
    const corrupt = week.corrupt === true;
    const last = runs.at(-1);
    if (last && last[1] === index - 1 && last[2] === corrupt) last[1] = index;
    else runs.push([index, index, corrupt]);
  }
  return runs;
}

function niceTicks(highest: number): number[] {
  for (let magnitude = 1; ; magnitude *= 10)
    for (const factor of [1, 2, 5]) {
      const step = factor * magnitude;
      const count = Math.ceil(highest / step);
      if (count <= MAX_GRID_LINES) return Array.from({ length: count }, (_, i) => (i + 1) * step);
    }
}

function weekLabelIndexes(weekCount: number): number[] {
  const last = weekCount - 1;
  const indexes = Array.from({ length: X_LABEL_COUNT }, (_, i) =>
    Math.round((i * last) / (X_LABEL_COUNT - 1)),
  );
  return [...new Set(indexes)];
}

function chart(
  weeks: WeekCounts[],
  series: Series[],
  label: string,
  currentWeek: string | null,
): string {
  const highest = Math.max(1, ...series.flatMap((line) => line.values.map((value) => value ?? 0)));
  const ticks = niceTicks(highest);
  const top = ticks.at(-1) ?? highest;
  const axisLeft = Math.max(CHART.left, AXIS_LABEL_PADDING + AXIS_DIGIT_WIDTH * String(top).length);
  const plotWidth = CHART.width - axisLeft - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const step = plotWidth / Math.max(weeks.length - 1, 1);
  const x = (index: number) =>
    weeks.length === 1 ? axisLeft + plotWidth / 2 : axisLeft + index * step;
  const y = (count: number) => CHART.top + (1 - count / top) * plotHeight;
  const pendingIndex = weeks.findIndex((week) => week.week === currentWeek);
  const bands = unfetchedRuns(weeks).map(([first, last, corrupt]) => {
    const left = Math.max(axisLeft, x(first) - step / 2);
    const right = Math.min(CHART.width - CHART.right, x(last) + step / 2);
    const gapLabel = corrupt ? '讀取失敗' : '未抓取';
    const text =
      right - left >= GAP_LABEL_MIN_WIDTH
        ? `<text x="${((left + right) / 2).toFixed(1)}" y="${CHART.top + plotHeight / 2}" text-anchor="middle" class="gap-label">${gapLabel}</text>`
        : '';
    return `<rect x="${left.toFixed(1)}" y="${CHART.top}" width="${(right - left).toFixed(1)}" height="${plotHeight}" class="gap"><title>${gapLabel}</title></rect>${text}`;
  });
  const lines = series.map((line, lineIndex) => {
    const color = seriesColor(lineIndex);
    const name = escapeHtml(line.name);
    let penDown = false;
    let path = '';
    const dots: string[] = [];
    for (const [index, value] of line.values.entries()) {
      if (value === null || index === pendingIndex) {
        penDown = false;
        continue;
      }
      if (weeks[index].truncated) {
        penDown = false;
        dots.push(
          marker(lineIndex, x(index), y(value), {
            hollow: true,
            pending: null,
            truncated: true,
            title: `${name} ${weeks[index].week}${TRUNCATED_NOTE}: ${value}`,
          }),
        );
        continue;
      }
      path += `${penDown ? 'L' : 'M'}${x(index).toFixed(1)} ${y(value).toFixed(1)} `;
      penDown = true;
      dots.push(
        marker(lineIndex, x(index), y(value), {
          hollow: false,
          pending: null,
          title: `${name} ${weeks[index].week}${weeks[index].truncated ? TRUNCATED_NOTE : ''}: ${value}`,
        }),
      );
    }
    let pending = '';
    const pendingValue = line.values[pendingIndex];
    if (pendingIndex >= 0 && pendingValue !== null && pendingValue !== undefined) {
      const before = line.values[pendingIndex - 1];
      if (before !== null && before !== undefined)
        pending += `<path data-pending="${name}" d="M${x(pendingIndex - 1).toFixed(1)} ${y(before).toFixed(1)} L${x(pendingIndex).toFixed(1)} ${y(pendingValue).toFixed(1)}" style="fill:none;stroke:${color};stroke-width:2;stroke-dasharray:4 4"/>`;
      pending += marker(lineIndex, x(pendingIndex), y(pendingValue), {
        hollow: true,
        pending: name,
        title: `${name} ${weeks[pendingIndex].week}（進行中）: ${pendingValue}`,
      });
    }
    return `<path data-member="${name}" d="${path.trim()}" style="fill:none;stroke:${color};stroke-width:2"/>\n${dots.join('')}${pending}`;
  });
  const firstWeek = weeks[0]?.week ?? '';
  const lastWeek = weeks.at(-1)?.week ?? '';
  const baseline = CHART.top + plotHeight;
  const grid = ticks.map(
    (tick) =>
      `<line x1="${axisLeft}" y1="${y(tick).toFixed(1)}" x2="${CHART.width - CHART.right}" y2="${y(tick).toFixed(1)}" class="grid"/>\n<text x="${axisLeft - 6}" y="${y(tick).toFixed(1)}" dy="0.35em" text-anchor="end">${tick}</text>`,
  );
  const weekLabels = weekLabelIndexes(weeks.length).map((index) => {
    const anchor =
      weeks.length === 1 || (index > 0 && index < weeks.length - 1)
        ? 'middle'
        : index === 0
          ? 'start'
          : 'end';
    return `<text x="${x(index).toFixed(1)}" y="${CHART.height - 8}" text-anchor="${anchor}">${weeks[index].week}</text>`;
  });
  const hasOpenPoint = weeks.some(
    (week) => week.counts !== null && (week.truncated || week.week === currentWeek),
  );
  const note = `數值見下方表格${hasOpenPoint ? '；空心點＝進行中或已截斷（數字未定或偏低）' : ''}`;
  return `<svg class="chart" viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-label="${label}，${firstWeek} 到 ${lastWeek}（數據見下方表格）">
${bands.join('\n')}
${grid.join('\n')}
<line x1="${axisLeft}" y1="${baseline}" x2="${CHART.width - CHART.right}" y2="${baseline}" class="axis"/>
<text x="${axisLeft - 6}" y="${baseline}" dy="0.35em" text-anchor="end">0</text>
${weekLabels.join('\n')}
${lines.join('\n')}
</svg>
<ul class="legend">
${series
  .map(
    (line, index) =>
      `<li><svg class="swatch" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">${marker(index, 7, 7, { hollow: false, pending: null, title: escapeHtml(line.name) })}</svg>${escapeHtml(line.name)}</li>`,
  )
  .join('\n')}
</ul>
<p class="chart-note">${note}</p>`;
}

function teamChart(
  weeks: WeekCounts[],
  members: string[],
  currentWeek: string,
  unit: string,
): string {
  return chart(
    weeks,
    [{ name: '合計', values: weeks.map((week) => teamTotal(week, members)) }],
    `團隊每週 ${unit} 合計`,
    currentWeek,
  );
}

function memberChart(
  weeks: WeekCounts[],
  members: string[],
  currentWeek: string,
  unit: string,
): string {
  return chart(
    weeks,
    members.map((member) => ({ name: member, values: weeks.map((week) => countOf(week, member)) })),
    `每位成員每週 ${unit} 數`,
    currentWeek,
  );
}

function table(weeks: WeekCounts[], members: string[], currentWeek: string, unit: string): string {
  const header = members.map((member) => `<th scope="col">${escapeHtml(member)}</th>`).join('');
  const rows = [...weeks]
    .reverse()
    .map((week) => {
      const cells = members.map((member) => `<td>${countOf(week, member) ?? '—'}</td>`).join('');
      const label = `${week.week}${week.week === currentWeek ? '（進行中）' : ''}${week.truncated ? TRUNCATED_NOTE : ''}${week.corrupt ? '（讀取失敗）' : ''}`;
      return `<tr><th scope="row">${label}</th><td>${teamTotal(week, members) ?? '—'}</td><td>${teamAverage(week, members) ?? '—'}</td>${cells}</tr>`;
    })
    .join('\n');
  return `<div class="scroll" tabindex="0" role="region" aria-label="每週 ${unit} 數"><table>
<caption>每週 ${unit} 數，新的在上，人均以目前成員名單計算（— 表示${unit === 'commit' ? '該週沒有 commit 資料' : '該週尚未抓取'}）<span class="hint">（可左右捲動）</span></caption>
<thead><tr><th scope="col">週</th><th scope="col">合計</th><th scope="col">人均</th>${header}</tr></thead>
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
  now,
  maxAgeHours,
  updatedAt,
  metric = 'prs',
}: {
  weeks: WeekCounts[];
  members: string[];
  range: Range;
  today: string;
  now: Date;
  maxAgeHours: number;
  updatedAt: string | null;
  metric?: Metric;
}): string {
  const currentWeek = isoWeek(today);
  const unit = metric === 'commits' ? 'commit' : 'merged PR';
  const metricQuery = metric === 'commits' ? '&amp;metric=commits' : '';
  const choices = WEEK_CHOICES.map((choice) =>
    choice === range.weeks
      ? `<strong aria-current="true">${choice} 週</strong>`
      : `<a href="/prs?weeks=${choice}${metricQuery}">${choice} 週</a>`,
  );
  const rangeQuery =
    range.weeks === null ? `from=${range.from}&amp;to=${range.to}` : `weeks=${range.weeks}`;
  const metricChoice = (choice: Metric, label: string) =>
    choice === metric
      ? `<strong aria-current="true">${label}</strong>`
      : `<a href="/prs?${rangeQuery}${choice === 'commits' ? '&amp;metric=commits' : ''}">${label}</a>`;
  if (range.weeks === null)
    choices.push(`<strong aria-current="true">自訂 ${range.from} – ${range.to}</strong>`);
  const content = members.length
    ? `<h2>團隊</h2>\n${teamChart(weeks, members, currentWeek, unit)}\n<h2>個人</h2>\n${memberChart(weeks, members, currentWeek, unit)}\n${table(weeks, members, currentWeek, unit)}`
    : '<p>請在 config/prStats.yaml 填 members（GitHub 帳號）</p>';
  const caveat =
    metric === 'commits'
      ? '統計所有 branch 上的 commit，依 commit 時間，台北時間週一到週日。含 squash 產生的 commit，不含 merge commit 與已刪除的 branch（舊週數字偏低）。commit 數只反映數量，不代表貢獻大小，建議只看趨勢。'
      : '統計已合併（merged）的 PR，依合併時間，台北時間週一到週日。PR 數只反映數量，不代表貢獻大小，建議只看趨勢。';
  const overdue =
    updatedAt !== null && (now.getTime() - Date.parse(updatedAt)) / 3_600_000 > maxAgeHours;
  const updated = !updatedAt
    ? '<p class="stale">尚無 pr_stats 成功紀錄</p>'
    : overdue
      ? `<p class="stale">資料更新於 ${taipeiTime(updatedAt)}，已逾時（上限 ${maxAgeHours} 小時）</p>`
      : `<p>資料更新於 ${taipeiTime(updatedAt)}</p>`;
  const notice = range.reason
    ? `<p class="notice" role="status">${range.reason}，已改顯示近 ${range.weeks} 週</p>`
    : '';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>radar ${metric === 'commits' ? 'commit' : 'PR'} 趨勢</title>
<style>
${BASE_CSS}
${SERIES_CSS}
svg.chart { width: 100%; height: auto; font-size: 11px; fill: var(--muted); }
@media (max-width: 40rem) { svg.chart text { font-size: 28px; } }
svg.chart .axis { stroke: var(--muted); }
svg.chart .grid { stroke: var(--line); }
svg.chart .gap { fill: var(--line); opacity: 0.5; }
svg.chart .gap-label { fill: var(--text); }
form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.5rem 0 1rem; }
.legend { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
.legend li { display: flex; align-items: center; gap: 0.3rem; }
.notice { font-weight: 600; }
.chart-note { color: var(--muted); margin: 0 0 1rem; }
.caveat { display: block; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>每週 ${unit} 數</h1>
<nav aria-label="頁面"><a href="/">← 狀態</a></nav>
<nav aria-label="指標">${metricChoice('prs', 'PR')} · ${metricChoice('commits', 'commit')}</nav>
<small class="caveat">${caveat}</small>
${updated}
<nav aria-label="顯示範圍">${choices.join(' · ')}</nav>
${notice}
<form method="get" action="/prs">
${metric === 'commits' ? '<input type="hidden" name="metric" value="commits">\n' : ''}<label>從 <input type="date" name="from" value="${range.from}" max="${today}"></label>
<label>到 <input type="date" name="to" value="${range.to}" max="${today}"></label>
<button type="submit">顯示</button>
</form>
${content}
</main>
<footer>頁面產生於 ${taipeiTime(now.toISOString())}</footer>
</body>
</html>
`;
}
