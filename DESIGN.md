---
name: radar
description: Status, cost and PR trends for a personal set of scheduled jobs, read on the LAN.
colors:
  notebook-paper: "#fafaf9"
  graphite-ink: "#1c1917"
  pencil-gray: "#78716c"
  ruled-line: "#e7e5e4"
  ink-blue: "#2563eb"
  correction-red: "#b91c1c"
  correction-wash: "#fee2e2"
  notebook-paper-dark: "#1c1917"
  graphite-ink-dark: "#f5f5f4"
  pencil-gray-dark: "#a8a29e"
  ruled-line-dark: "#44403c"
  ink-blue-dark: "#60a5fa"
  correction-red-dark: "#fca5a5"
  correction-wash-dark: "#450a0a"
  series-1: "#2563eb"
  series-2: "#dc2626"
  series-3: "#16a34a"
  series-4: "#d97706"
  series-5: "#7c3aed"
  series-6: "#0891b2"
  series-7: "#db2777"
  series-8: "#4d7c0f"
  series-1-dark: "#60a5fa"
  series-2-dark: "#f87171"
  series-3-dark: "#4ade80"
  series-4-dark: "#fbbf24"
  series-5-dark: "#a78bfa"
  series-6-dark: "#22d3ee"
  series-7-dark: "#f472b6"
  series-8-dark: "#a3e635"
typography:
  headline:
    fontFamily: "system-ui, \"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.5
  title:
    fontFamily: "system-ui, \"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "1.05rem"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, \"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  data:
    fontFamily: "system-ui, \"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "0.9rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, \"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "11px"
    fontWeight: 400
rounded:
  none: "0"
spacing:
  hair: "0.25rem"
  tight: "0.3rem"
  xs: "0.4rem"
  gap: "0.5rem"
  sm: "0.6rem"
  md: "1rem"
  lg: "2rem"
components:
  data-table-cell:
    textColor: "{colors.graphite-ink}"
    typography: "{typography.data}"
    padding: "0.4rem 0.6rem"
  data-table-row-failed:
    backgroundColor: "{colors.correction-wash}"
    textColor: "{colors.correction-red}"
  freshness-item:
    textColor: "{colors.graphite-ink}"
    padding: "0.4rem 0.6rem"
  freshness-item-stale:
    backgroundColor: "{colors.correction-wash}"
    textColor: "{colors.correction-red}"
    padding: "0.4rem 0.6rem"
  budget-meter:
    backgroundColor: "{colors.ink-blue}"
    height: "0.75rem"
    width: "100%"
  link:
    textColor: "{colors.ink-blue}"
---

# Design System: radar

## Overview

**Creative North Star: "The Lab Notebook"**

radar's pages are a researcher's notebook kept by a running experiment. Each page is a sheet: plain paper, ruled lines between rows, numbers written in ink, and a margin note in red where something went wrong. The data is the subject. Charts and tables carry the page, and nothing decorative competes with them.

The system is quiet by default and precise when it speaks. One ink (blue) marks what you can act on or follow: links and the budget meter. One correction color (red, on a pale red wash) marks what failed or went stale, and always comes with words that say so. Everything else is graphite on paper. Density is a working notebook's: compact data rows, generous gaps only between sections, one centered column.

Both themes come from the system: a light paper sheet and a dark one that follows `prefers-color-scheme`. Every color, including the chart series, has a dark counterpart, and the browser's own form controls follow the theme (`color-scheme: light dark`).

**Key Characteristics:**

- Flat sheets: no shadows, no rounded corners, no cards.
- Ruled rows: 1px dividers under each table row, not boxes.
- One ink, one correction color, graphite for the rest.
- Charts are drawn by hand in inline SVG and are always paired with a table holding the same numbers.
- The system font stack with Traditional Chinese fallbacks. No web fonts.

## Colors

A warm stone neutral ground with a single blue ink and a single red correction color. The chart series palette is separate from both.

### Primary

- **Ink Blue** (light `ink-blue`, dark `ink-blue-dark`): links, and the bar of the monthly budget meter. It means "follow this" or "this is the measured amount". It is never used for status.

### Neutral

- **Notebook Paper** (`notebook-paper` / `notebook-paper-dark`): page background, set explicitly on `body`.
- **Graphite Ink** (`graphite-ink` / `graphite-ink-dark`): all body text, headings and numbers.
- **Pencil Gray** (`pencil-gray` / `pencil-gray-dark`): table captions, chart axis labels and chart text. It is for annotation, not content.
- **Ruled Line** (`ruled-line` / `ruled-line-dark`): row dividers and the chart baseline.

### Status

- **Correction Red** (`correction-red` / `correction-red-dark`) on **Correction Wash** (`correction-wash` / `correction-wash-dark`): failed run rows and overdue freshness lines. The wash fills the row, the red colors its text.

### Chart Series

- **Series 1–8** (`series-1` … `series-8`, each with a `-dark` version): one color per line on the PR charts, assigned in member order and cycled after eight. They are CSS variables (`--s1` … `--s8`), switched by the dark block. On the team chart there is one line, the total, in series 1. These colors identify lines. They carry no status meaning, and they never carry identity alone: each series also has its own marker shape (see Line Chart). The shape cycles through four forms and moves one step further after every eight series, so the first 32 series all differ in color, shape or both.

### Named Rules

**The Correction Ink Rule.** Red appears only where something failed or is overdue, and always next to words that say so ("失敗", "已逾時", "尚無成功紀錄"). Red is never decoration, emphasis or a brand color.

**The One Ink Rule.** Blue is for links and the measured amount. It never marks a status or a heading.

**The Dash Rule.** An em dash `—` means "no value here". Three places use it, and each says so in context: a week that was never fetched (the table caption explains it), a run with no warnings, and a run with no note link. It is never 0.

## Typography

**Body Font:** system-ui (with Noto Sans TC, PingFang TC, Microsoft JhengHei, sans-serif)

**Character:** The operating system's own UI face, chosen so Traditional Chinese and Latin numbers sit together without a web-font download. The type is quiet. Hierarchy comes from a small step in size and from bold headings, not from contrast between typefaces.

### Hierarchy

- **Headline** (700, 1.25rem, 1.5): the one page title (`radar 狀態`, `每週 merged PR 數`).
- **Title** (700, 1.05rem, 1.5, 2rem above): section headings such as the month's cost, the run log, 團隊 and 個人.
- **Body** (400, 1rem, 1.5): sentences, the freshness lines, form labels.
- **Data** (400, 0.9rem, 1.5): every table: runs, cost per job, weekly PR counts.
- **Label** (400, 11px): chart axis values, week labels on the chart. Pencil gray.

### Named Rules

**The Small Step Rule.** Headings are at most 1.25× body. A page is a sheet of notes, not a poster.

## Layout

A single centered column, at most 64rem wide, with 1rem padding on every side. Sections stack vertically in a fixed order, and each title adds 2rem above it. There is no grid and no sidebar.

Tables span the full column. A table that is too wide, such as the PR table with many members, scrolls sideways inside its own container and never makes the page scroll. Charts scale to the column width through their `viewBox` (800 × 260), keeping their aspect ratio. The layout is the same on phones, only narrower.

Spacing is a short scale: 0.4rem and 0.6rem inside rows and list items, 1rem for the page edge and gaps, and 2rem between sections. Three small steps serve tight spots: 0.25rem between legend rows, 0.3rem between a legend marker and its name, and 0.5rem for gaps in the date form and under captions.

Each page is one `<main>` landmark. On the status page the title and the link to the other page share one wrapping row. Links to the other page and the range choices sit in labelled `<nav>` elements. Links and form controls keep at least 24px of room to tap.

## Elevation & Depth

None. The system is completely flat: no `box-shadow`, no layered surfaces, no overlays. Rows are separated by ruled lines, sections by space and titles. Status is shown by a colored wash behind a row, never by lifting it.

### Named Rules

**The Flat Sheet Rule.** Nothing floats. If something needs to stand out, give it the correction wash or a title, not a shadow.

## Shapes

Corners are square (radius 0) in everything the system draws: tables and wash rows. The one exception is the budget meter, a native `<progress>` that keeps the browser's own rounded bar, because CSS cannot square it. Borders are 1px ruled lines under table rows, never full outlines around content. On charts, lines are 2px strokes and data points are small markers in four shapes: circle, square, diamond and triangle. The legend repeats each marker beside the series name.

## Components

### Data Table

The working surface of every page: plain and dense.

- **Cells:** data type size, 0.4rem × 0.6rem padding, left-aligned, top-aligned, a 1px ruled line underneath.
- **Caption:** pencil gray, above the table, and it also says how to read it (for example "— 表示該週尚未抓取").
- **Row headers:** use `<th scope="row">` for the week or job, in regular weight on the status page.
- **Run log columns:** Job, 結果, 開始時間, 花費, 警告, 筆記, 耗時, so the columns that matter are the first to show on a phone.
- **Failed row:** correction wash fills the row, the text turns correction red, and the error message sits in its own full-width row under it, so it never squeezes into a narrow column on a phone. A visually hidden "{job} 錯誤：" starts that row, so a screen reader knows whose error it is. A link inside a failed row takes the row's color and is underlined.
- **Warnings:** a count that opens in place (`<details>`) to the list of warnings.
- **Current week:** the newest week is marked 「（進行中）」, because its count is not final.
- **Scrolling hint:** on narrow screens the caption adds 「（可左右捲動）」.
- **Missing value:** an em dash `—`, never 0 or blank (see The Dash Rule).

### Freshness Line

A list under the heading 各 job 狀態 at the top of the status page, one line per job: "{job} 上次成功：N 小時前（time）".

- **Verdict:** one line above the list: "全部正常", or "N 個 job 需要處理" in the stale style. A job needs attention when it is overdue, has never succeeded, or its latest run failed. Jobs that need attention are listed first. A job without a limit is never counted.
- **Normal:** body text with no marker.
- **Stale:** correction wash, correction red, weight 600, ending with "，已逾時（上限 N 小時）".
- **Latest failure:** when a run failed after the last success, the line ends with "，最近一次：time 失敗：error", in either state. The error is cut to its first 80 characters and followed by a link "詳見執行紀錄" to the run log; the full text sits in the run log row.
- **Unmonitored job:** a job that has runs or cost but no limit gets a neutral muted line, "{job} 未設定新鮮度上限". It is never red: it says that nothing is watching, not that something is wrong.
- **On `/prs`:** one line, "資料更新於 time", takes the same stale style, ending "，已逾時（上限 N 小時）", when `pr_stats` last succeeded longer ago than its limit.

### Budget Meter

A native `<progress>` bar: full width, 0.75rem high, ink blue via `accent-color`. It sits right under the "$spent / $100（N%）" line, which states the same number in text. A spend under 1% reads "<1%", not 0%. Above the budget the line turns correction red, bold, and ends with "，已超支 $X" (the amount over). The native bar only fills, so the amount is stated in text. The bar is hidden from screen readers (`aria-hidden`) because that text already says the same, and its value is the unrounded spend, so a few cents draw as a sliver rather than an empty bar.

### Line Chart

A hand-drawn inline SVG with `role="img"` and an `aria-label` that names the measure and the week range.

- **Axes:** one baseline in pencil gray (dark enough to read as a graphic). Three or four ruled grid lines in ruled-line color mark round values (1, 2 or 5 times a power of ten) with their numbers in pencil gray on the left, and 0 sits on the baseline; the top grid line is the top of the chart. Five evenly spaced week labels run along the bottom (fewer when there are fewer weeks). On a phone the axis text grows to 28 units so it stays readable, and the left margin grows with the number of digits of the top value so a four-digit label is never cut. With a single week the point sits in the middle with one label.
- **Lines:** 2px strokes in series colors. A line breaks at a week that has no data instead of dropping to zero.
- **Current week:** the last segment is dashed and its marker is hollow, with "（進行中）" in its `<title>`.
- **Unfetched weeks:** a stretch of weeks with no data is a pale band labelled 「未抓取」 (the label is dropped when the band is narrow).
- **Truncated week:** a week the GitHub search cut short (more than 1000 results) is marked 「（已截斷，數字偏低）」 in the table and in the point titles, because its counts are too low. Its marker is hollow and the line breaks there, so it never reads as a real dip.
- **Points:** a marker per value, circle, square, diamond or triangle by series order (moving one step on after every eight series). Each carries a `<title>` with "{name} {week}: {value}".
- **Legend:** an unstyled list under the chart, each item the series marker followed by the name.
- **Pairing:** every chart has a table on the same page with the same numbers. The `aria-label` ends with 「（數據見下方表格）」 and a muted line under the legend says 「數值見下方表格」, because the points have no touch or keyboard readout (the pages use no JavaScript). When the range holds a current or truncated week, the same line adds 「空心點＝進行中或已截斷（數字未定或偏低）」.

### Range Picker

Links for 12 / 26 / 52 weeks in a labelled `<nav>`, with the active choice in bold and `aria-current="true"` instead of a link. Below them, a native GET form with two `type="date"` inputs (no later than today) and a native submit button, in a wrapping flex row with 0.5rem gaps. Native controls are left unstyled except for a 2rem minimum height. When the requested range is invalid, a bold line in the normal text color says so and names the range shown instead; it is not an error state, so it does not use correction red.

### Links

Ink blue, underlined by the browser default. They are used for navigation between the two pages and for links to notes.

## Do's and Don'ts

### Do:

- **Do** pair every red state with text that names it ("失敗", "已逾時"). Color is never the only signal.
- **Do** show missing data as `—` in tables and as a gap in chart lines.
- **Do** give every chart a table with the same numbers, and an `aria-label` that names the measure and the range.
- **Do** keep tables inside a sideways-scrolling container, so the page itself never scrolls horizontally.
- **Do** define a dark counterpart for any new color in the `prefers-color-scheme: dark` block.
- **Do** mark data that is not final (the current week) and data that does not exist (unfetched weeks) differently from final numbers.
- **Do** tell series apart by marker shape as well as by color.

### Don't:

- **Don't** add shadows, rounded corners or card containers. Rows are ruled, not boxed.
- **Don't** use ink blue for status, or correction red for anything that is not a failure or overdue.
- **Don't** add web fonts, icon fonts or client-side JavaScript. The pages must render as plain server HTML.
- **Don't** treat the chart series red (`series-2`) as an alarm: it only identifies a line. Its closeness to correction red is a known tension in the current palette.
- **Don't** add a chart line that is a rescaled copy of another (such as an average next to a total). Put derived numbers in the table.
