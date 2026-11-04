# changelog_watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly job that collects changes from 7 sources, triages them with Haiku, summarizes the important ones with Sonnet, and publishes a Traditional Chinese note to CodiMD.

**Architecture:** `jobs/changelogSources.ts` turns each configured source into change items and the next per-source state (pure of the model). `jobs/changelogWatch.ts` triages items, summarizes, writes the note and advances state only after a successful upload, with the same `deps` injection as `jobs/redditDigest.ts`.

**Tech Stack:** Node 24 type stripping, `node:test`, `diff` (jsdiff) 9.0.0, existing `lib/` modules.

**Spec:** `docs/superpowers/specs/2026-11-04-changelog-watch-design.md`

## Global Constraints

- Erasable TypeScript only (no `enum`, no `namespace`); import local files with the `.ts` extension.
- Models only through `call()` / `MODELS` from `lib/claude.ts`; Haiku triages, Sonnet writes.
- Notes are Traditional Chinese; code, identifiers and commit messages are English; full variable names, no code comments.
- CodiMD alias `radar-changelog-<YYYY-Www>`; the week is `isoWeek()` of the Taipei date (`Asia/Taipei`).
- A source that cannot be fetched is a `> ⚠️` warning at the top of the note (via `note()` in `lib/render.ts`), never skipped silently; all sources failing throws.
- State (`state/changelog/…`) advances only after `publish()` succeeds; `--no-upload` never advances it.
- Env: `GITHUB_TOKEN` is already in `.env`; directories come from `STATE_DIR`, `OUTPUT_DIR`, `PROMPTS_DIR`, `CONFIG_DIR` with the existing defaults.
- Every task ends with `npm test`, `npm run typecheck`, `npm run lint` green.

## Review Focus

1. A GitHub 403/429/5xx or a non-200 on a `.md` page is a failed source (warning, state untouched), never "the file became empty".
2. Draft and prerelease GitHub releases are ignored; a release older than the stored `lastPublishedAt` is ignored.
3. A markdown source whose only change is trailing whitespace or a final newline produces no item and no model call.
4. Haiku answers with an unknown `category` or an out-of-range `importance`: coerced to `其他` / clamped to 0–3 (as `scorePosts` does), not thrown.
5. A source added to the config after the first run has no stored state: it is baselined (releases: last 7 days), it does not diff against nothing.

---

### Task 1: Collectors for releases, markdown pages and single GitHub files

**Files:**
- Create: `jobs/changelogSources.ts`
- Test: `tests/changelogSources.test.ts`
- Modify: `package.json`, `package-lock.json` (add `diff` 9.0.0 via `npm install diff@9.0.0`)

**Interfaces:**
- Produces:
  ```ts
  export interface SourceConfig {
    id: string;
    kind: 'githubReleases' | 'markdown' | 'githubFile' | 'githubSkills';
    repo?: string;
    path?: string;
    url?: string;
  }
  export interface ChangeItem { source: string; title: string; url: string; version?: string; text: string }
  export interface CollectResult { items: ChangeItem[]; baseline: boolean; nextState: unknown }
  export interface SourceDeps { fetch: typeof fetch; now: () => Date; token: string }
  export async function collectSource(source: SourceConfig, previousState: unknown | null, deps: SourceDeps): Promise<CollectResult>
  ```
  Stored states: `githubReleases` → `{ lastPublishedAt: string }`; `markdown` and `githubFile` → `{ text: string }`.

- [ ] **Step 1: Write the failing tests** in `tests/changelogSources.test.ts`, with `Response` objects from an injected `fetch`:
  - `githubReleases, no state: returns releases of the last 7 days as items` — three releases (published 1, 3 and 10 days before `now`) → 2 items, `baseline` false, `nextState.lastPublishedAt` = newest `published_at`; each item has `version` = `tag_name`, `url` = `html_url`, `text` = `body`.
  - `githubReleases with state: returns only newer releases, ignores drafts and prereleases` (Review Focus 2).
  - `markdown, no state: baseline, no items, state holds the text`.
  - `markdown with a change: one item whose text is a unified diff containing the added line`.
  - `markdown with only trailing whitespace changed: no item` (Review Focus 3).
  - `githubFile uses the contents API with the raw Accept header and the token` — assert request URL `https://api.github.com/repos/<repo>/contents/<path>`, headers `Accept: application/vnd.github.raw+json`, `Authorization: Bearer <token>`.
  - `non-200 response throws an error naming the source id and status` for each kind (Review Focus 1, 5: a source with `previousState === null` and kind `githubFile` is a baseline).

- [ ] **Step 2: Run** `node --test tests/changelogSources.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `collectSource` in `jobs/changelogSources.ts`. Releases: `GET https://api.github.com/repos/<repo>/releases?per_page=30`, skip `draft`/`prerelease`, keep `published_at` greater than the stored one (or than `now` minus 7 days when no state). Markdown: plain `fetch(url)`. Diff: jsdiff `createPatch(id, old, new, '', '', { context: 20 })` after normalizing each text with trailing whitespace stripped per line and a single final newline. Throw `new Error(\`${source.id}: HTTP ${status}\`)` on non-ok. `githubSkills` throws `not implemented` until Task 2.

- [ ] **Step 4: Run the tests** → PASS.

- [ ] **Step 5: Commit** `feat: collect changelog items from releases, markdown pages and GitHub files`

---

### Task 2: Collector for the skills directory

**Files:**
- Modify: `jobs/changelogSources.ts`
- Test: `tests/changelogSources.test.ts`

**Interfaces:**
- Consumes: `collectSource`, `SourceConfig`, `ChangeItem` from Task 1.
- Produces: `githubSkills` state `{ files: Record<string, { sha: string; text: string }> }` keyed by `skills/<name>/SKILL.md` (my call: store the text so a changed sha can be diffed).

- [ ] **Step 1: Write the failing tests**:
  - `githubSkills, no state: baseline, state lists every SKILL.md with sha and text`.
  - `githubSkills, new folder: item with the full SKILL.md as text and title naming the skill`.
  - `githubSkills, changed sha: item with a unified diff`; `unchanged sha: no item and no fetch of that file`.
  - `deleted skill folder: item whose text says the skill was removed; it is dropped from nextState`.
  Mock `GET /repos/<repo>/git/trees/HEAD?recursive=1` (entries with `path`, `type: 'blob'`, `sha`) and `GET /repos/<repo>/contents/<path>` (raw Accept).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** the `githubSkills` branch: list the tree, keep blobs matching `^skills/[^/]+/SKILL\.md$`, fetch only new or changed files.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat: collect new and changed skills from anthropics/skills`

---

### Task 3: Haiku triage

**Files:**
- Create: `jobs/changelogWatch.ts` (triage part), `prompts/changelogTriage.md`
- Test: `tests/changelogWatch.test.ts`

**Interfaces:**
- Consumes: `ChangeItem` from Task 1; `call`, `MODELS` from `lib/claude.ts`.
- Produces:
  ```ts
  export type Category = '新功能' | '修正' | '棄用' | '價格' | '其他';
  export interface Change { source: string; version?: string; url: string; text: string; category: Category; importance: number }
  export interface Deps { fetch: typeof fetch; now: () => Date; call: typeof call; publish: typeof publish }
  export async function triageItem(item: ChangeItem, deps: Deps): Promise<Change[] | null>
  ```
  `null` means two invalid answers. The JSON schema answer is `{ changes: { text, category, importance }[] }`; `source`, `version` and `url` are copied from the item, never from the model.

- [ ] **Step 1: Write the failing tests** (a fake `deps.call` that records options):
  - `triageItem sends the item to Haiku with the schema and returns one Change per answer, with source, version and url from the item`.
  - `unknown category becomes 其他 and importance is clamped to 0-3` (Review Focus 4).
  - `two invalid answers (not an object with a changes array) return null`; `first invalid then valid returns the changes`.
  - `a non-SyntaxError from call is rethrown`.

- [ ] **Step 2: Run** `node --test tests/changelogWatch.test.ts` → FAIL.

- [ ] **Step 3: Implement** `triageItem` the way `scoreBatch` in `jobs/redditDigest.ts` does (two attempts, `SyntaxError` only). Write `prompts/changelogTriage.md` in Traditional Chinese: split the text into individual changes; categories as in the type; importance 0–3 where price and deprecation changes are at least 2 and routine fixes are 0–1; keep each change's text short and faithful.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat: triage changelog items into categorized changes with Haiku`

---

### Task 4: run(): summary, note, weekly file and state

**Files:**
- Modify: `jobs/changelogWatch.ts`
- Create: `prompts/changelogSummary.md`
- Test: `tests/changelogWatch.test.ts`

**Interfaces:**
- Consumes: `collectSource` (Tasks 1–2), `triageItem` and `Change` (Task 3), `isoWeek` from `jobs/prStats.ts`, `note` (`lib/render.ts`), `load`/`save` (`lib/state.ts`), `runCost` (`lib/claude.ts`).
- Produces:
  ```ts
  export interface Config { sources: SourceConfig[]; token: string }
  export async function run(options: { upload: boolean; config: Config }, deps: Deps): Promise<RunResult>
  ```
  State: `changelog/<id>` per source; `changelog/weeks/<week>` → `{ changes: Change[]; baselined: string[] }`.

- [ ] **Step 1: Write the failing tests** (fake `fetch`/`call`/`publish`, temp `STATE_DIR` and `OUTPUT_DIR` as `tests/redditRun.test.ts` does):
  - `nothing changed: no call() at all, note body is 本週無重大更新 and lists the sources checked, published to radar-changelog-<week>`.
  - `a change with importance 2: Sonnet gets only changes with importance >= 1; changes in 棄用/價格 are in an "urgent" array separate from "others" in the user payload`.
  - `all changes importance 0: no Sonnet call, body is 本週無重大更新`.
  - `a failed source: its warning is at the top of the note, the other sources still run, its state is not advanced`; `all sources failed: run rejects`.
  - `baselined sources are listed under 已建立基準 in the note`.
  - `--no-upload (upload false): no publish call, no state written`.
  - `publish fails: nothing saved, so the next run collects the same items again`.
  - `rerun in the same week after a successful upload with nothing new: the note rebuilt from changes/weeks/<week>.json equals the first note's body, not 本週無重大更新` (the weekly file merges previous `changes` with newly triaged ones).
  - `triage returned null for an item: a warning is added and that item's source state is not advanced` (my call: so the item is retried).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `run`. Order: collect all sources (failures → warnings) → triage items → merge with the stored week → summarize (single Sonnet call, `system` = `changelogSummary.md` + the contents of `config/changelogContext.md`, `user` = JSON `{ urgent, others }`) → `note()` titled `[Changelog 週報] <week>` → write `output/changelog/<week>.md` → `publish` → save every successful source's `nextState` and the weekly file. The summary prompt (Traditional Chinese) requires: a first section `## ⚠️ 價格與棄用` for `urgent`, then the rest grouped by source; one or two sentences per change plus one 「對我們的影響」 sentence; keep versions and links; merge the same change if it appears twice.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat: summarize triaged changes into a weekly note and advance state after upload`

---

### Task 5: CLI, config, schedule and docs

**Files:**
- Modify: `jobs/changelogWatch.ts` (CLI under `import.meta.main`), `crontab`, `web/statusServer.ts` (`MAX_AGE_HOURS`), `CLAUDE.md`, `README.md`, `tests/statusServer.test.ts` only if it asserts the key list
- Create: `config/changelog.yaml`, `config/changelogContext.md`

**Interfaces:**
- Consumes: `run`, `Config` (Task 4), `recordRun` from `lib/runLog.ts`.

- [ ] **Step 1: Add the CLI**: `parseArgs` with `no-upload` only; `recordRun('changelog_watch', …)` reads `config/changelog.yaml` (`sources: SourceConfig[]`), requires `GITHUB_TOKEN`, and calls `run` with real `fetch`, `now`, `call`, `publish`.

- [ ] **Step 2: Write `config/changelog.yaml`** with exactly these sources: `claude-code` (githubReleases, `anthropics/claude-code`), `orca` (githubReleases, `stablyai/orca`), `api-release-notes` (markdown, `https://platform.claude.com/docs/en/release-notes/overview.md`), `model-deprecations` (markdown, `https://platform.claude.com/docs/en/about-claude/model-deprecations.md`), `skills` (githubSkills, `anthropics/skills`), `marketplace-official`, `marketplace-community`, `marketplace-knowledge-work` (githubFile, `.claude-plugin/marketplace.json` of `anthropics/claude-plugins-official`, `anthropics/claude-plugins-community`, `anthropics/knowledge-work-plugins`), `awesome` (githubFile, `GetBindu/awesome-claude-code-and-skills`, `README.md`).

- [ ] **Step 3: Draft `config/changelogContext.md`** (Traditional Chinese) from the plugins and skills installed on this machine (`~/.claude/plugins`) and the project workflow: Claude Code with superpowers and ponytail skills, Orca ADE, CodiMD, AMP workspaces l10n / edm / dah. State at the top of the file that the user maintains it.

- [ ] **Step 4: Wire it**: add `0 9 * * 5 cd /app && node jobs/changelogWatch.ts` to `crontab`; add `changelog_watch: 8 * 24` to `MAX_AGE_HOURS` in `web/statusServer.ts`; update the CLAUDE.md job table, Status line and pipeline paragraph; add the manual command `docker compose exec jobs node jobs/changelogWatch.ts [--no-upload]` to `README.md`.

- [ ] **Step 5: Verify**: `npm test && npm run typecheck && npm run lint`. Then a real dry run: `GITHUB_TOKEN=$(gh auth token) npm run changelog -- --no-upload` is not available (no script), so run `GITHUB_TOKEN=$(gh auth token) node jobs/changelogWatch.ts --no-upload` with a real `ANTHROPIC_API_KEY`; expect `output/changelog/<week>.md` containing the Orca and Claude Code releases of the last 7 days and the `已建立基準` list. If no key is available here, state that this step was not run.

- [ ] **Step 6: Commit** `feat: schedule changelog_watch on Fridays and document it`
