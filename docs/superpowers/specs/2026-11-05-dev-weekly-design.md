# dev_weekly — design

## Context
Stage 3 of `t.md` (Job 2). Every Monday 09:00 Taipei, one Chinese note on CodiMD (`radar-dev-weekly-<YYYY-Www>`) telling the author what the team shipped last week, what is stuck, and what looks off, so Monday starts with a 3-minute read and a list of PRs to chase. The note lives on the internal CodiMD, so teammates can read it: state facts, never judge a person.

Measured on 2026-10-26..11-01 across the agreed repos: 360 merged PRs (257 `ymk-web-utils`, 80 `yce-frontend`, 23 elsewhere), 11 of them match the Opus condition, 354 of 360 have no review at all, none has a closing-issue link, 18 open issues in the whole org, 48 open PRs. `t.md` assumed 30–80 PRs a week; the design below follows the measured numbers.

## Goals
- Weekly note, ISO week Monday–Sunday in Taipei time; default run covers the week that just ended; `--week 2026-W45` reruns any week; `--no-upload` writes `output/devWeekly/<week>.md` only.
- Three sections: 本週完成 (grouped by feature, not by PR), 進行中／卡住, 異常. Every item has PR links (`repo#123`); authors and links come from code, never from the model.
- Feature grouping in one Sonnet call; code checks that every PR appears exactly once.
- "Stuck" and "anomaly" lists are computed by code from fixed rules.
- Repo list in `config/repos.yaml`; adding a repo is a config edit.

## Non-goals (user decisions)
- No per-person leaderboard or scoring; no judgement of individuals (Q1).
- No fuzzy issue-to-PR matching; only an explicit `#123` / `fixes #123` / `org/repo#123` in a PR title, body or branch name counts (Q11).
- No "waiting for review" rule: almost nobody reviews PRs here (Q9). Revisit when review becomes normal.
- `*-doc` repos are not covered at first (Q2).

## Anti-goals
- A note that lists 360 PRs. Grouping must collapse the many series PRs ("(2/3)", repeated titles) into a handful of features.
- A PR silently missing, or listed twice.
- Technical wording ("add DiscountService"); write feature language ("cart supports discount codes").

## Constraints
- Sends private PR titles, descriptions and, for a few PRs, diffs to the Anthropic API through the linked Console org key. The user accepted this (Q4). If policy changes, the Opus step is the first thing to remove.
- Models: Sonnet 5.5 for grouping and the write-up; Opus 5.5 only for the diff step below; no Haiku needed.
- GitHub through the API only. `GITHUB_TOKEN` must read pull requests, issues and contents of the listed private repos (fine-grained PAT).
- Follows the job architecture in `CLAUDE.md`: `jobs/devWeekly.ts` exports its steps and `run(options, deps)`, CLI under `import.meta.main`, wrapped in `recordRun` + `withIndex`, `deps` = `fetch`, `now`, `call`, `publish`, `sleep`.
- Reuse `isoWeek`/`weekStart` from `jobs/prStats.ts`.

## Decisions
**Repos** (`config/repos.yaml`, full names): `ymk-web-utils`, `yce-frontend`, `ymk-web-cicd`, `yco-api-console`, `bc-console-ui`, `ymk-web-sdk`, `pmt-api`, `smb-frontend`, `smb-api`, `smb-admin`, `smb-backend`, `smb-strapi`, `smb-shopify` under `perfect-corp`.

**Context file** `config/devWeeklyContext.md`, maintained by the user: members and the workspace each owns. Passed to Sonnet in the system prompt like `changelogContext.md`. Missing file: the run goes on, with a warning in the note. All authors in the listed repos are reported; there is no member filter.

**Collect** (GraphQL search, one query per repo and kind, cursor-paged with a variable named `$endCursor`):
- merged PRs of the week: number, title, url, body, additions, deletions, changedFiles, headRefName, baseRefName, createdAt, mergedAt, author login, repo;
- open PRs now: same identity fields plus `isDraft`, `createdAt`, `updatedAt`;
- open issues now: number, title, url, `createdAt`, `updatedAt`, author.
Search returns at most 1000 results per query; more gives a warning naming the repo. A repo that fails to fetch becomes a warning and the rest go on; every repo failing fails the run.

**Raw file** `state/devWeekly/raw/<week>.json` holds the three lists and `fetchedAt`. If it exists, a rerun (`--week`) reuses it instead of fetching again, like `reddit_digest --date`. The open-PR and open-issue lists are a snapshot, so the stuck and anomaly sections say "as of `fetchedAt`". If there is no raw file for a week that ended more than 7 days ago, merged PRs are fetched fresh and a warning says the stuck and issue sections show the current state, not that week's.

**Opus step.** Eligible: merged PR with fewer than 50 whitespace-separated words in the body and more than 100 changed lines. At most 10 per week, largest first; those left out are named in a warning. Diff from the REST pulls endpoint (`Accept: application/vnd.github.diff`); files that are lockfiles, `*.min.*`, `dist/`, `build/`, snapshots or similar generated output are dropped, and the rest is cut at 30,000 characters with "diff 已截斷" noted. Opus returns one sentence on what the PR does; it is cached in `state/devWeekly/opus/<week>.json` so a rerun never pays twice. A failed or invalid answer becomes a warning and the PR is described by its title. Shortcut: the word count is whitespace-based, so a Chinese-only description counts as few words and passes the check; the team writes English, upgrade if that changes. Check before shipping: run `yce-frontend#922` (6851 lines) and confirm one Opus call stays under $0.5.

**Sonnet step (one call).** Input: each merged PR (the target branch is included so a change sent to several workspace branches, such as `amp/workspaces/<ws>/master`, folds into one feature) as `{id, repo, title, branch, base, body cut at 600 characters, opus sentence if any, lines}` where `id` is a small integer assigned by the code, plus the context file. Output (JSON schema): `features: [{name, summary, prs: [id], overlap?}]`. `summary` is one or two sentences in feature language; `overlap` is set when separate PRs by different people touch the same thing. Code validates: unknown ids dropped, an id listed twice keeps its first feature, ids not listed anywhere go to a final group 其他 with their titles. Two invalid answers fail the run (nothing to publish without the grouping). Estimated 70–100K input tokens, about $0.2–0.3 a week.

**Stuck section (code, fixed rules).**
- Open, non-draft PR created more than 3 days before `fetchedAt`.
- Draft PR with no update for more than 14 days.
Each line: link, title, author, age in days.

**Anomaly section.**
- Merged PR with more than 100 changed lines and fewer than 50 words of description (same test as the Opus condition, so the two lists agree).
- Open issue with no update for more than 14 days (`updatedAt`, same basis as drafts) that no PR in the raw file (merged this week or open) mentions explicitly.
- Each feature's `overlap` text from Sonnet, with its PR links.

**Scope of "merged".** Every merged PR counts whatever its target branch: last week none went to `main`; they went to long-lived branches (`amp/master`, `amp/workspaces/<ws>/master`, `gm-261125`, ...). No bot filter: no bot author appeared. Known limit: if a PR merged into an integration branch is later merged again on its way to `master`, both count; grouping folds them, the totals line may overstate.

**Context file use.** Prompt context only (member names, workspace owners, product language); the note has no per-owner field.

**Link cap.** A feature lists its first 5 PR links and "另 N 個" for the rest; the authors line is complete.

**Note layout** via `lib/render.ts`: title `[開發週報] <week>`, `> ⚠️` warnings, one line of totals (merged PR count, authors, repos), the three sections, a list of repos covered, cost line. Written to `output/devWeekly/<week>.md`, published to alias `radar-dev-weekly-<week>`.

**Wiring.** `crontab`: `0 9 * * 1 cd /app && node jobs/devWeekly.ts`. `web/statusServer.ts`: add `dev_weekly: 8 * 24` to `MAX_AGE_HOURS`. `lib/noteIndex.ts`: add `dev_weekly: '開發週報'` to `JOB_TITLES`. `README.md` and `CLAUDE.md` Status/Architecture updated. Prompts in `prompts/devWeeklyGroup.md` and `prompts/devWeeklyDiff.md`. `GITHUB_TOKEN` is already in `.env.example`.

Known limit: an issue that only an earlier week's merged PR mentions is not in the raw file, so it can be flagged although work happened; acceptable with 18 open issues.

## Tests
`node:test` with injected deps and GraphQL fixtures, no network: paging and the 1000-result warning; Opus eligibility, cap of 10, generated-file filtering and truncation; grouping validation (duplicate id, unknown id, missing id, two invalid answers); stuck and anomaly rules at their boundaries (3 and 14 days, 49 vs 50 words, 100 vs 101 lines); explicit issue-reference matching; raw-file reuse on rerun; `--no-upload` publishes nothing and marks nothing as done, but does write the raw file and the Opus cache (so rehearsals do not pay twice, as with `reddit_digest`).

## Acceptance (from `t.md`)
Run `--week 2026-W44 --no-upload`, read the note against the author's own picture of that week: no obvious grouping mistakes, grouping accuracy above 90% on a sample, and the cost line matches the estimate. Rerunning any week works.

## Left to the builder
Exact generated-file patterns, prompt wording, GraphQL query shape, how to split `jobs/devWeekly.ts` (a second file such as `devWeeklyGithub.ts` is fine, as `changelogSources.ts` is), wording of warnings.
