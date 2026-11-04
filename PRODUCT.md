# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Primary: the owner of radar (steve_lee), who runs it on a machine inside the company network. They check whether the scheduled jobs actually ran, how much of the monthly $100 Claude API credit is spent, and how merged PRs trend per person and for the team.
- Also: a few colleagues on the company LAN who open the same pages, mostly for the PR trend and the spending. They know the team but not how radar works inside. They do not log in and have no special access.

## Product Purpose

radar is a set of scheduled jobs that turns signals from outside and inside the company into short reports and numbers. Today it runs two jobs. One publishes a daily Reddit digest to the internal CodiMD. The other counts merged PRs per member every day.

The web pages at `:8080` answer three questions at a glance:

- Did each job run recently?
- What did it cost this month?
- How is PR output trending?

Success means a missed schedule or a failing job is noticed the same day, without reading container logs.

## Positioning

radar is a personal tool, not a product for sale. It runs on Max plan API credits with a hard monthly budget, so cost per job is a first-class number. Notes and summaries go to the internal CodiMD; the web pages only show status and trends.

## Operating Context

- It runs as Docker Compose on an internal machine. Schedules are run by supercronic inside the `jobs` container.
- The `web` service can only read `output/` and `config/`.
- The pages are opened from a desktop browser on the LAN, usually for a quick check rather than a long session. Phones can open them but are not the main case.
- Reports are published to the internal CodiMD at `https://rd-server-dev.perfectcorp.com`.

## Capabilities and Constraints

- `/` (status):
  - How long ago each job last succeeded, red when overdue.
  - This month's cost against the $100 budget, and the cost of each job.
  - The last 30 runs with result, error, warnings, cost and note link.
- `/prs` (trend):
  - A team chart with the total and the per-member average of the members listed in `config/prStats.yaml`.
  - One line per member.
  - A weekly table.
  - A range of 12, 26 or 52 weeks, or custom dates.
  - A week that was never fetched shows as `—`, never as 0.
- The server renders the HTML as plain strings, with inline SVG and no client-side framework or JS dependency. The pages must work without JavaScript.
- There is no login, and nothing on the pages needs one. Sensitive data such as credentials or emails must never appear on them.
- Language: the UI text is Traditional Chinese. Code, identifiers and job names stay in English.
- Undecided:
  - How the PR counts may be used, for example whether they are fit for judging individuals.
  - Whether the team gets split into sub-groups later.
  - The billing-cycle reset day. The calendar month is used for now.

## Evidence on Hand

- Real data lives on the deployment machine in `output/cost.jsonl`, `output/runs.jsonl` and `output/prStats/*.json`.
- The PR counts for 2026-W40 to W45 were checked against GitHub search. For W43 both give 453 for the whole org.
- There are no screenshots, logos or brand assets. Do not invent any.

## Product Principles

1. Silence must never look like health. A job that did not run, or a week that was not fetched, is shown as missing, not as fine or zero.
2. Cost is always shown next to the work that caused it.
3. A glance answers the question. Details such as errors and the per-run rows are there, but they come second.
4. Read-only and low-risk: the pages only read files and never act on the system.

## Accessibility & Inclusion

Color is never the only signal: overdue and failed states also say so in text ("已逾時", "失敗"). Each chart has an `aria-label`, and the table holds the same data as the chart.
