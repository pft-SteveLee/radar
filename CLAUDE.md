# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Pre-implementation: the repo has no commits and no code yet. The only content is `t.md` (untracked, written in Traditional Chinese), the plan this project is built from. Build/lint/test commands do not exist yet; add them here once the first job lands. If `t.md` and the code disagree, ask which one is right.

## What this is

`radar`: four scheduled jobs that run on the monthly $100 Claude API credits (Max plan), each producing a Markdown report published to the internal CodiMD.

| Job | Schedule (Asia/Taipei) | Models |
| --- | --- | --- |
| `reddit_digest` | daily 08:00 | Haiku 5.5 scores, Sonnet 5.5 summarizes |
| `dev_weekly` (GitHub PRs/issues) | Mon 09:00 | Sonnet 5.5; Opus 5.5 only for diffs of PRs with a short description (<50 words) and >100 changed lines |
| `changelog_watch` (Claude Code, Claude API, Orca ADE, skills/plugin marketplaces) | Fri 09:00 | Haiku 5.5 diff triage, Sonnet 5.5 summary |
| `amp_compare` (competitor feature matrix per AMP workspace) | monthly or manual | Sonnet extracts, Opus 5.5 aligns and analyzes, Fable 5.1 for `--deep` |

## Planned architecture

- `jobs/*.py`: one collector plus prompt per job. Run as `python -m jobs.<name>`; every job CLI takes a date, week or workspace argument (`--date`, `--week`, `--workspace`, `--deep`) so any run can be redone.
- `lib/`: shared by all jobs: `claude.py` (Messages API wrapper, retry, cost logging), `codimd.py`, `state.py` (processed-id/hash cache), `render.py` (Markdown templates).
- `prompts/` (one file per job), `config/` (`repos.yaml`, `changelog_sources.yaml`, `competitors.yaml`), `state/`, `output/`: mounted as volumes so prompts and config change without rebuilding the image.
- One Docker image; `supercronic` reads `crontab` inside the container. Env vars: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `CODIMD_URL`, `CODIMD_EMAIL`, `CODIMD_PASSWORD`, `TZ=Asia/Taipei`. Only `.env.example` is committed.
- Pipeline for every job: collect, dedupe against `state/` (so only new content costs tokens), cheap-model filter, stronger-model write-up, save to `output/`, upload to CodiMD.

## Constraints that shape the code

- All model calls go through the Messages API or Agent SDK with the key from the linked Console org. Interactive Claude Code, the GitHub Action and IDE/desktop launches bill as Claude Code usage and are not covered by the credits.
- Model tiers: Haiku classifies and filters first, Sonnet writes, Opus only where reading large diffs or making comparison judgments, Fable only for `amp_compare --deep`. Put the fixed part of each prompt (system prompt, format examples) first for prompt caching.
- `lib/claude.py` appends every call (model, input/output tokens, estimated USD) to `output/cost.jsonl`, and each CodiMD note ends with that run's cost.
- Reddit: RSS only (no API), custom User-Agent. GitHub sources: always the API, never scrape HTML. Page-to-text with `trafilatura` or `readability-lxml` so nav/footer changes do not trigger fake diffs.
- A source that cannot be fetched (403, redesign) must be flagged at the top of that run's note, never silently skipped.
- Must run on a machine that can reach the internal CodiMD, not GitHub Actions.
- Missed runs are back-filled from `state/last_run.json` at job startup.
- Write the cheapest tests first: collectors and fake-data tests before calling the real API.

## CodiMD publishing

`t.md` plans a `codimd.py` that logs in with email/password and POSTs to `/new`. The global setup notes (`~/.claude/CLAUDE.md` §10) say `POST /new/<alias>` returns 404 on this server and that named notes are written through the socket.io polling channel, as `~/.claude-shared/scripts/codimd/push.mjs` does. Check which works before implementing `codimd.py`. Credentials live only in `.env`, never in chat or docs.

## Build order

1. `lib/` plus Reddit, Dockerfile, compose, and cost logging
2. Changelog watch
3. Dev weekly
4. AMP compare, starting with workspace `l10n`, then `edm`, `dah`

Open items in `t.md`: competitor lists for `config/competitors.yaml`, repo list for `config/repos.yaml`, and the CodiMD URL and bot account.
