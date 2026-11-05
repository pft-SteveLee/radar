# dev_weekly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly job that writes a Chinese note on last week's merged PRs (grouped by feature), stuck PRs and anomalies, published to CodiMD as `radar-dev-weekly-<YYYY-Www>`.

**Architecture:** `jobs/devWeeklyRules.ts` holds pure rules (thresholds, Opus selection, diff trimming, stuck/stale/anomaly checks). `jobs/devWeeklyGithub.ts` is the GraphQL/REST collector. `jobs/devWeekly.ts` holds grouping validation, note rendering, `run()` and the CLI, in the same shape as `jobs/changelogWatch.ts`. One Sonnet call groups the PRs; Opus writes one sentence for at most 10 undescribed large PRs.

**Tech Stack:** Node 24 type-stripped TypeScript (no `enum`, no `namespace`, imports end in `.ts`), `node:test`, `yaml`, existing `lib/*`.

**Spec:** `docs/superpowers/specs/2026-11-05-dev-weekly-design.md`

## Global Constraints

- Week = ISO week Monday–Sunday in Asia/Taipei; reuse `isoWeek`, `weekStart` from `jobs/prStats.ts`; merged range is `merged:<monday>T00:00:00+08:00..<sunday>T23:59:59+08:00`.
- Job name `dev_weekly`; alias `radar-dev-weekly-<week>`; note title `[開發週報] <week>`; output `output/devWeekly/<week>.md`.
- State under `STATE_DIR`: `devWeekly/raw/<week>`, `devWeekly/opus/<week>` (use `load`/`save` from `lib/state.ts`).
- Thresholds: Opus candidate = fewer than 50 whitespace-separated words in the body AND more than 100 changed lines (additions + deletions); at most 10 per week, largest first; diff cut at 30,000 characters; stuck = open non-draft PR created more than 3 days before `fetchedAt`; stale draft = no update for more than 14 days; stale issue = no update for more than 14 days.
- GraphQL cursor variable must be named `$endCursor`. Search returns at most 1000 results per query: more gives a warning naming the repo.
- Models via `MODELS` in `lib/claude.ts`; the PR links, authors and titles in the note come from code, never from the model.
- A failed repo is a warning; every repo failing fails the run. Two invalid Sonnet answers fail the run.
- Warnings are Chinese strings, matching the other jobs. Biome style, no code comments except a one-line why.

## Review Focus

- A PR whose author account is deleted (`author: null`): shown as `ghost`, not a crash.
- A week with zero merged PRs: note says 本週無合併的 PR, no Sonnet or Opus call is made.
- Sonnet returns an id twice, an id out of range, a non-integer id, or omits PRs: every PR still appears exactly once.
- PR titles containing `[`, `]`, `|` or backticks do not break the Markdown list or links.
- Token without access to a repo (GraphQL 200 with `errors`, or 404): a warning naming the repo, not an empty section.

---

### Task 1: Pure rules

**Files:**
- Create: `jobs/devWeeklyRules.ts`
- Test: `tests/devWeeklyRules.test.ts`

**Interfaces:**
- Produces (types are defined here and imported by later tasks; Task 2 re-exports nothing):
```ts
export interface MergedPr { repo: string; number: number; title: string; url: string; body: string; additions: number; deletions: number; changedFiles: number; headRefName: string; baseRefName: string; createdAt: string; mergedAt: string; author: string }
export interface OpenPr { repo: string; number: number; title: string; url: string; body: string; headRefName: string; author: string; isDraft: boolean; createdAt: string; updatedAt: string }
export interface OpenIssue { repo: string; number: number; title: string; url: string; author: string; createdAt: string; updatedAt: string }
export const OPUS_MAX_PRS = 10; export const DIFF_MAX_CHARS = 30_000
export function wordCount(text: string): number
export function isUndescribedLarge(pr: MergedPr): boolean
export function selectForOpus(merged: MergedPr[]): { selected: MergedPr[]; skipped: MergedPr[] }
export function trimDiff(diff: string): { text: string; truncated: boolean }
export function stuckPrs(openPrs: OpenPr[], now: Date): { pr: OpenPr; days: number }[]
export function staleDrafts(openPrs: OpenPr[], now: Date): { pr: OpenPr; days: number }[]
export function referencedIssues(prs: { repo: string; title: string; body: string; headRefName: string }[]): Set<string>
export function staleIssues(issues: OpenIssue[], referenced: Set<string>, now: Date): { issue: OpenIssue; days: number }[]
export const shortRepo = (repo: string): string  // "perfect-corp/x" -> "x"
```
`repo` is always the full `owner/name`. Issue keys in `referencedIssues` are `owner/name#123`.

- [ ] **Step 1: Write failing tests** covering exactly these assertions: `wordCount('a  b\nc') === 3`, `wordCount('') === 0`; `isUndescribedLarge` is true at 49 words and 101 lines, false at 50 words, false at exactly 100 lines; `selectForOpus` of 12 eligible PRs returns the 10 largest in `selected` (sorted by lines desc) and the other 2 in `skipped`; `trimDiff` drops file sections whose path matches `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `*.min.js`, `dist/`, `build/`, `__snapshots__/` while keeping `src/a.ts`, and cuts a 40,000-character diff to 30,000 with `truncated: true`; `stuckPrs` includes a non-draft PR created 3 days + 1 minute earlier, excludes one created exactly 3 days earlier, excludes drafts; `staleDrafts` includes a draft updated 14 days + 1 minute earlier, excludes 14 days exactly and non-drafts; `referencedIssues` finds `#12` in a title of repo `o/r` as `o/r#12`, `fixes #7` in a body, `#5` in a branch name, and `o/other#9` as `o/other#9`; `staleIssues` returns an issue untouched for 15 days that is not referenced, omits the same issue when referenced, omits one updated 14 days exactly.
- [ ] **Step 2: Run** `node --test tests/devWeeklyRules.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** the signatures above in `jobs/devWeeklyRules.ts`. `trimDiff` splits on lines starting `diff --git `; apply the path patterns to the `b/` path; truncate after filtering.
- [ ] **Step 4: Run** the same command → PASS. Run `npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit** `feat: add dev_weekly rules`.

### Task 2: GitHub collector

**Files:**
- Create: `jobs/devWeeklyGithub.ts`
- Test: `tests/devWeeklyGithub.test.ts`

**Interfaces:**
- Consumes: `MergedPr`, `OpenPr`, `OpenIssue` from Task 1.
- Produces:
```ts
export interface GithubDeps { fetch: typeof fetch; sleep: (ms: number) => Promise<void> }
export interface RepoData { merged: MergedPr[]; openPrs: OpenPr[]; openIssues: OpenIssue[]; warnings: string[] }
export async function collectRepo(repo: string, week: string, token: string, deps: GithubDeps): Promise<RepoData>
export async function fetchDiff(pr: { repo: string; number: number }, token: string, deps: GithubDeps): Promise<string>
```
`collectRepo` runs three searches against `https://api.github.com/graphql` (merged PRs of the week, `is:pr is:open`, `is:issue is:open`), POST with `Authorization: Bearer`, paging with `pageInfo.endCursor` as variable `endCursor`. `fetchDiff` GETs `https://api.github.com/repos/<repo>/pulls/<n>` with `Accept: application/vnd.github.diff`.

- [ ] **Step 1: Write failing tests** with a fake `fetch` returning GraphQL pages: (a) `collectRepo` follows `hasNextPage` and sends `endCursor` of page 1 as the variable of page 2, returning all merged PRs with `repo` set to the full name; (b) `author: null` becomes `'ghost'`; (c) `issueCount` of 1001 on any search adds a warning containing the repo name and `1000`; (d) a 200 response with `{ errors: [{ message: 'Could not resolve' }] }` makes `collectRepo` throw an Error whose message contains the repo name; (e) HTTP 403 with `x-ratelimit-remaining: 0` and `x-ratelimit-reset` calls `deps.sleep` with reset time + 1000 ms and retries once (reuse the wait rule of `waitMilliseconds` in `jobs/prStats.ts`; export it from there if needed, do not copy it); (f) `fetchDiff` sends the diff `Accept` header and returns the body text.
- [ ] **Step 2: Run** `node --test tests/devWeeklyGithub.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the signatures. Three attempts maximum per request, 20 s timeout per request, same as `prStats`.
- [ ] **Step 4: Run** → PASS; typecheck and lint.
- [ ] **Step 5: Commit** `feat: add dev_weekly GitHub collector`.

### Task 3: Grouping

**Files:**
- Create: `jobs/devWeekly.ts` (grouping part only), `prompts/devWeeklyGroup.md`
- Test: `tests/devWeeklyGroup.test.ts`

**Interfaces:**
- Consumes: `MergedPr` (Task 1).
- Produces:
```ts
export interface Feature { name: string; summary: string; prs: MergedPr[]; overlap?: string }
export interface GroupDeps { call: typeof call }
export function normalizeGroups(answer: unknown, merged: MergedPr[]): Feature[]   // throws SyntaxError if answer has no features array
export async function groupPrs(merged: MergedPr[], opusSentences: Record<string, string>, context: string | null, deps: GroupDeps): Promise<Feature[]>
```
`opusSentences` is keyed `<repo>#<number>`. Model input: JSON array of `{id, repo (short name), title, branch, base, body cut at 600 chars, description (the Opus sentence, if any), lines}` where `id` is the index in `merged`. Schema: `{features: [{name, summary, prs: integer[], overlap?: string}]}`. Call: `job: 'dev_weekly'`, `model: MODELS.sonnet`, system = `prompts/devWeeklyGroup.md` + `\n\n## 團隊背景\n\n<context>` when context exists (same helper shape as `withContext` in `jobs/changelogWatch.ts`; reuse by exporting it if cheap).

`prompts/devWeeklyGroup.md` (Traditional Chinese) must say: group PRs into features, not by PR; feature language not technical language; fold PRs that carry the same change to several branches or are a numbered series into one feature; a PR belongs to exactly one feature; name and summary of one or two sentences each; set `overlap` (one sentence) only when separate PRs by different people touch the same thing; answer with the JSON only.

- [ ] **Step 1: Write failing tests**: valid answer → features with `prs` resolved to the `MergedPr` objects; id listed twice keeps the first feature; id out of range, `1.5` and `'3'` are dropped; PRs mentioned nowhere land in a final feature named `其他` (summary empty string) in `merged` order; a feature left with no PRs is removed; `groupPrs` retries once after a `SyntaxError` answer and then succeeds; two invalid answers → rejects with an Error (not SyntaxError) mentioning two attempts; the call carries `MODELS.sonnet`, `job: 'dev_weekly'`, the schema, and a system prompt containing the context text; user JSON contains `base` and cuts a 2,000-character body to 600.
- [ ] **Step 2: Run** `node --test tests/devWeeklyGroup.test.ts` → FAIL.
- [ ] **Step 3: Implement** the signatures and write the prompt file.
- [ ] **Step 4: Run** → PASS; typecheck and lint.
- [ ] **Step 5: Commit** `feat: group dev_weekly PRs by feature`.

### Task 4: Note rendering

**Files:**
- Modify: `jobs/devWeekly.ts`
- Test: `tests/devWeeklyNote.test.ts`

**Interfaces:**
- Consumes: `Feature` (Task 3); `MergedPr`, `OpenIssue`, `shortRepo` (Task 1).
- Produces:
```ts
export interface ReportInput { mergedCount: number; features: Feature[]; stuck: { pr: OpenPr; days: number }[]; staleDrafts: { pr: OpenPr; days: number }[]; undescribed: MergedPr[]; staleIssues: { issue: OpenIssue; days: number }[]; repos: string[]; fetchedAt: string }
export function renderReport(input: ReportInput): string
```
Layout, in order: totals line (`上週合併 N 個 PR，M 位作者，K 個 repo`; authors counted from `features`); `## 本週完成` with one `### <name>` per feature: summary, an authors line (all authors, sorted, joined `、`), up to 5 links `[repo#n](url) title` then `另 N 個` when more; `## 進行中／卡住` (stuck, then stale drafts; each line link, title, author, `N 天`); `## 異常` (undescribed PRs, stale issues, each feature's `overlap`); `## 已涵蓋的 repo`; and the line `以上「進行中」與 issue 為 <fetchedAt in Asia/Taipei> 的狀態`. An empty section prints `無` under its heading. Zero merged PRs: 本週完成 section is the single line 本週無合併的 PR.

- [ ] **Step 1: Write failing tests**: 7 PRs in one feature print 5 links and `另 2 個` and all authors; a title `a [b] | c` renders with `[` `]` escaped so the link text still closes; empty stuck list prints `無`; zero merged → `本週無合併的 PR`; the footer line contains the Taipei time of `fetchedAt`; an `overlap` string appears under 異常 with the feature's links.
- [ ] **Step 2: Run** `node --test tests/devWeeklyNote.test.ts` → FAIL.
- [ ] **Step 3: Implement** `renderReport`.
- [ ] **Step 4: Run** → PASS; typecheck and lint.
- [ ] **Step 5: Commit** `feat: render dev_weekly note`.

### Task 5: Run, Opus step, CLI

**Files:**
- Modify: `jobs/devWeekly.ts`
- Create: `prompts/devWeeklyDiff.md`
- Test: `tests/devWeeklyRun.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `note` from `lib/render.ts`; `runCost`, `call`, `MODELS`; `publish`; `recordRun`, `withIndex`; `load`/`save`.
- Produces:
```ts
export interface RawWeek { week: string; fetchedAt: string; merged: MergedPr[]; openPrs: OpenPr[]; openIssues: OpenIssue[] }
export interface Deps { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => Date; call: typeof call; publish: typeof publish }
export interface Options { week: string; upload: boolean; config: { repos: string[]; token: string } }
export function previousWeek(today: string): string   // isoWeek of today minus 7 days
export async function run(options: Options, deps: Deps): Promise<RunResult>
```
`run` order: load `devWeekly/raw/<week>` or collect every repo (failed repo → warning; all failed → throw) and save it (also with `upload: false`); warn when no raw file existed and the week ended more than 7 days before `now`; Opus step over `selectForOpus(merged)` using `devWeekly/opus/<week>` as cache (saved after each success; skipped PRs → one warning listing them; a failed diff fetch or call → warning, PR keeps its title); `groupPrs` (not called when there are no merged PRs); `renderReport`; `note({title: '[開發週報] <week>', ...})` with `runCost('dev_weekly', startedAt)`; write `output/devWeekly/<week>.md`; if `upload`, `deps.publish('radar-dev-weekly-<week>', text)`, log the URL, warn on `editedOnWeb` as `changelogWatch` does. Missing `config/devWeeklyContext.md` → warning, run continues. Truncated diff → warning naming the PR. CLI under `import.meta.main`: `--week`, `--no-upload`, `GITHUB_TOKEN` required, `config/repos.yaml` (`repos: string[]`) read with `yaml`, wrapped in `recordRun('dev_weekly', withIndex('dev_weekly', work, publish))`.

`prompts/devWeeklyDiff.md` (Traditional Chinese): given a PR title, short body and a diff, answer one sentence in feature language on what the PR does for users or the team; no preamble.

- [ ] **Step 1: Write failing tests** with temp `STATE_DIR`/`OUTPUT_DIR`/`CONFIG_DIR`/`PROMPTS_DIR` (pattern of `tests/changelogWatch.test.ts`) and fake `fetch`/`call`/`publish`: (a) end to end with two repos → note written, `publish` called once with alias `radar-dev-weekly-2026-W44`, raw file saved; (b) `upload: false` → no `publish` call but raw file and Opus cache exist; (c) rerun with the raw file present → fake `fetch` is never called for GraphQL; (d) 12 eligible PRs → exactly 10 Opus calls (model `MODELS.opus`), a warning names the 2 skipped; (e) Opus cache hit → no Opus call on rerun; (f) Opus `call` rejects for one PR → warning, run still succeeds; (g) one repo throws → warning naming it, note still produced; all repos throw → `run` rejects; (h) zero merged PRs → no `call` at all, note says 本週無合併的 PR; (i) missing context file → warning, run succeeds; (j) `previousWeek('2026-11-09') === '2026-W45'` and `previousWeek('2026-11-05') === '2026-W44'`.
- [ ] **Step 2: Run** `node --test tests/devWeeklyRun.test.ts` → FAIL.
- [ ] **Step 3: Implement** `run`, `previousWeek`, the CLI and the diff prompt.
- [ ] **Step 4: Run** `npm test` → all green (228 existing plus the new ones); typecheck and lint.
- [ ] **Step 5: Commit** `feat: add dev_weekly job`.

### Task 6: Config and wiring

**Files:**
- Create: `config/repos.yaml`, `config/devWeeklyContext.md`
- Modify: `crontab`, `web/statusServer.ts:12`, `lib/noteIndex.ts` (`JOB_TITLES`), `tests/noteIndex.test.ts`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Write failing test** in `tests/noteIndex.test.ts`: a `dev_weekly` run with a URL renders under the heading `## 開發週報`.
- [ ] **Step 2: Run** `node --test tests/noteIndex.test.ts` → FAIL.
- [ ] **Step 3: Implement**: `JOB_TITLES.dev_weekly = '開發週報'`; `MAX_AGE_HOURS.dev_weekly = 8 * 24` in `web/statusServer.ts`; crontab line `0 9 * * 1 cd /app && node jobs/devWeekly.ts`; `config/repos.yaml` with the 13 repos of the spec under `perfect-corp/`; `config/devWeeklyContext.md` as a draft with a leading HTML comment saying the user maintains it, sections 成員與負責的 workspace (placeholders) and 產品用語. README: schedule line, a `dev_weekly` paragraph (`--week`, `--no-upload` writes raw file and Opus cache but publishes nothing, needs `GITHUB_TOKEN` with pull requests/issues/contents read and `ANTHROPIC_API_KEY`, context file, sends private PR text to the API). CLAUDE.md: Status (stages 1–3 built), jobs table row marked built, one Architecture paragraph for the `dev_weekly` pipeline, Next stages shows only `amp_compare`.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` → green.
- [ ] **Step 5: Commit** `feat: schedule dev_weekly and document it`.

### Task 7: Real-data check (spends money; tell the user the estimate first)

- [ ] **Step 1:** Ask the user to confirm the spend (about $0.3–0.8 for Sonnet plus up to $0.5 per Opus diff, ten at most) and that `.env` has `GITHUB_TOKEN` and `ANTHROPIC_API_KEY`.
- [ ] **Step 2:** `npm run`-style dry run: `node jobs/devWeekly.ts --week 2026-W44 --no-upload`. Read `output/devWeekly/2026-W44.md` and `output/cost.jsonl`: report the cost per model, the number of Opus calls (expect about 11, capped at 10), whether `yce-frontend#922` stayed under $0.5, and show the user the note.
- [ ] **Step 3:** Run it again; expect zero GraphQL calls and zero Opus cost (raw file and cache reused).
- [ ] **Step 4:** Only after the user has read the note and accepts it: open the PR with `gh pr create --base main`, then start the merge `Monitor` from `CLAUDE.md` §9.

---

## Self-review

- Spec coverage: collect + raw reuse + stale-week warning (T2, T5); Opus selection, cap, generated-file filter, truncation, cache (T1, T5); Sonnet grouping with validation and 其他 (T3); stuck/draft/anomaly rules at their boundaries (T1); layout, link cap, escape, zero-merged (T4); `--no-upload` state behavior and cost line (T5); wiring: crontab, status limit, index title, config, README, CLAUDE.md (T6); acceptance run and #922 cost check (T7).
- Type names are defined once in T1/T3/T4/T5 and reused unchanged.
- Known open point for the builder: exporting `waitMilliseconds` from `jobs/prStats.ts` and `withContext` from `jobs/changelogWatch.ts` is allowed, copying them is not.
