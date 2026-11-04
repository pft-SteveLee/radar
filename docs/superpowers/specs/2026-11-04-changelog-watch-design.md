# changelog_watch — design

## Context
Stage 2 of `t.md` (Job 3). radar exists to use the Max plan's $100/month API credits (no rollover, billing cycle resets on the 14th). This job watches what changes in the tools the team relies on — Claude Code, the Claude API, Orca ADE, Anthropic skills and plugin marketplaces — and once a week writes a short Chinese note on what changed and what it means for the team, so nobody has to read eight changelogs. Success: a Friday note on CodiMD that is short, flags price/deprecation changes clearly, and never silently skips a source.

## Goals
- Weekly note `radar-changelog-<YYYY-Www>` on CodiMD, Fri 09:00 Taipei.
- Only changed content costs tokens: unchanged sources are skipped before any model call.
- Haiku triages each change (category + importance 0–3); Sonnet writes the note from items with importance ≥ 1, one or two sentences each plus one 「對我們的影響」 sentence, keeping links and version numbers.
- Price and deprecation changes stand out at the top of the note.
- A source that fails to fetch is a `> ⚠️` warning at the top; the rest still run. All sources failing fails the run.

## Non-goals (user decisions)
- No HTML scraping, no readability library: every source is a `.md` page or the GitHub API (Q1). `onorca.dev/plugins` is not monitored.
- No monthly trend review (Q5).
- Not in this change: the status page counts budget per calendar month while credits reset on the 14th (billing cycle). Separate follow-up.

## Anti-goals
- A long weekly wall of Orca patch notes. Triage must cut it down; that is the job's main value.
- Duplicate items for the same change from two sources.

## Sources (`config/changelog.yaml`)
| id | kind | what | first run |
| --- | --- | --- | --- |
| claude-code | `githubReleases` | `anthropics/claude-code` releases (dated, body has notes) | releases from the last 7 days |
| orca | `githubReleases` | `stablyai/orca` releases (3–5/week, 27–72 K chars each) | last 7 days |
| api-release-notes | `markdown` | `https://platform.claude.com/docs/en/release-notes/overview.md` | baseline |
| model-deprecations | `markdown` | `https://platform.claude.com/docs/en/about-claude/model-deprecations.md` | baseline |
| skills | `githubSkills` | `anthropics/skills` `skills/*/SKILL.md` via the git tree API; new folder = new skill (full SKILL.md to Sonnet), changed blob sha = diff | baseline |
| marketplaces | `githubFile` ×3 | `.claude-plugin/marketplace.json` of `claude-plugins-official`, `claude-plugins-community`, `knowledge-work-plugins` | baseline |
| awesome | `githubFile` | `GetBindu/awesome-claude-code-and-skills` README | baseline |

Verified 2026-11-04: both `.md` URLs return `text/markdown`; both repos publish releases with notes in the body; `knowledge-work-plugins` marketplace.json and the awesome repo exist. GitHub's `CHANGELOG.md` (1.1 MB) is replaced by the releases API (my call: same content, dated, no huge diff). The docs `changelog.md` is not monitored: it repeats the releases (user decision, so the same release never appears twice).

## Pipeline (`jobs/changelogWatch.ts`, same shape as `jobs/redditDigest.ts`)
1. Collect each source with injected `fetch` (GitHub with `GITHUB_TOKEN`). Per-source failure → warning.
2. Compare with `state/changelog/<id>.json` (last release `published_at`, or last text / blob shas). Produce change items `{ source, title, url, version?, text }`: new releases as whole bodies; text sources as a unified diff with 20 lines of context.
3. Haiku (`call` with JSON schema, `prompts/changelogTriage.md`) splits each item (a release body or a diff) into individual changes and returns each as `{ text, category: 新功能|修正|棄用|價格|其他, importance: 0–3 }`, keeping the source, version and url of the item (user decision: classify per change, not per release, so a deprecation buried in a release still reaches the top section and Sonnet never sees a whole 72 K release). Two invalid answers → that item's changes are dropped with a warning (same rule as `scorePosts`).
3a. The triaged changes of the week are saved in `state/changelog/weeks/<week>.json`. A rerun in the same week loads them, adds changes found since, and rebuilds the whole note, so a rerun only adds to the published note and never replaces it with 「本週無重大更新」 (user decision).
4. If no change ≥ 1: body is 「本週無重大更新」 plus the list of sources checked. Otherwise Sonnet (`prompts/changelogSummary.md`, system prompt includes `config/changelogContext.md`) gets only the changes ≥ 1 and writes the body; changes in 棄用/價格 go in a 「⚠️ 價格與棄用」 section first.
5. `note()` from `lib/render.ts`, write `output/changelog/<week>.md`, `publish()` to `radar-changelog-<week>`.
6. State advances only after the upload succeeds; `--no-upload` never advances it (same rule as reddit seen ids). First run: baseline sources write state and are listed under 「已建立基準」 in the note.
- CLI: `--no-upload`. Wrapped in `recordRun('changelog_watch', …)`.

## Team context (`config/changelogContext.md`)
I draft it from this machine's installed plugins/skills and the project's workflow (Claude Code + superpowers/ponytail skills, Orca ADE, CodiMD, AMP workspaces l10n / edm / dah); the user edits it (Q2).

## Wiring
- `crontab`: `0 9 * * 5 cd /app && node jobs/changelogWatch.ts`.
- `web/statusServer.ts` `MAX_AGE_HOURS`: `changelog_watch: 8 * 24`.
- Reuse: `isoWeek` from `jobs/prStats.ts`, `call`/`MODELS`/`runCost` (`lib/claude.ts`), `publish` (`lib/codimd.ts`), `note` (`lib/render.ts`), `load`/`save` (`lib/state.ts`), `recordRun` (`lib/runLog.ts`).
- Diff: add the `diff` (jsdiff) package for unified diffs (my call: Node has no built-in; check latest version first).
- Docs: CLAUDE.md status/table/pipeline line, README manual command.

## Cost
Orca ≈ 50 K tokens/week to Haiku, Sonnet only on kept items: under $0.5/week, $2–4/month as in `t.md`.

## Left to the builder
Haiku chunking for very large release bodies, exact prompt wording, JSON schema shapes, test fixture layout.

## Verification
- `node --test tests/changelogWatch.test.ts` with fixtures: unchanged source → no model call; new release/diff → triage + summary; failed source → warning; first run → baseline listed, no state advance on `--no-upload`; rerun in the same week with nothing new → same note as before, not 「本週無重大更新」.
- `npm test`, `npm run typecheck`, `npm run lint`.
- Real run: `docker compose exec jobs node jobs/changelogWatch.ts --no-upload`, check the note in `output/changelog/` and the cost on the status page.
