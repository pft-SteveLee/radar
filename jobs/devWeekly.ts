import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { call, MODELS, runCost } from '../lib/claude.ts';
import { publish } from '../lib/codimd.ts';
import { withIndex } from '../lib/noteIndex.ts';
import { escapeMarkdown, note } from '../lib/render.ts';
import { type RunResult, recordRun } from '../lib/runLog.ts';
import { load, save } from '../lib/state.ts';
import { withContext } from './changelogWatch.ts';
import { collectRepo, fetchDiff, type GithubDeps } from './devWeeklyGithub.ts';
import {
  isUndescribedLarge,
  type MergedPr,
  OPUS_MAX_PRS,
  type OpenIssue,
  type OpenPr,
  referencedIssues,
  selectForOpus,
  shortRepo,
  staleDrafts,
  staleIssues,
  stuckPrs,
  trimDiff,
} from './devWeeklyRules.ts';
import { isoWeek, weekStart } from './prStats.ts';

const JOB = 'dev_weekly';
const GROUP_ATTEMPTS = 2;
const GROUP_MAX_TOKENS = 64_000;
const BODY_CHARS = 600;
const OTHER_FEATURE = '其他';
const LINKS_PER_FEATURE = 5;
const DAY_MS = 86_400_000;
const OLD_WEEK_DAYS = 7;
const DIFF_BODY_CHARS = 2000;

export interface Feature {
  name: string;
  summary: string;
  prs: MergedPr[];
  overlap?: string;
}

export interface GroupDeps {
  call: typeof call;
}

export interface Deps extends GithubDeps {
  now: () => Date;
  call: typeof call;
  publish: typeof publish;
}

export interface RawWeek {
  week: string;
  fetchedAt: string;
  merged: MergedPr[];
  openPrs: OpenPr[];
  openIssues: OpenIssue[];
}

export interface Options {
  week: string;
  upload: boolean;
  config: { repos: string[]; token: string; members: string[] };
}

const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          prs: { type: 'array', items: { type: 'integer' } },
          overlap: { type: 'string' },
        },
        required: ['name', 'summary', 'prs', 'overlap'],
        additionalProperties: false,
      },
    },
  },
  required: ['features'],
  additionalProperties: false,
};

const readPrompt = (name: string) =>
  readFileSync(join(process.env.PROMPTS_DIR ?? 'prompts', name), 'utf8');

export function normalizeGroups(answer: unknown, merged: MergedPr[]): Feature[] {
  const raw = (answer as { features?: unknown } | null)?.features;
  if (!Array.isArray(raw)) throw new SyntaxError('group answer has no features array');
  const assigned = new Set<number>();
  const features: Feature[] = [];
  for (const item of raw as {
    name?: unknown;
    summary?: unknown;
    prs?: unknown;
    overlap?: unknown;
  }[]) {
    const ids = Array.isArray(item.prs) ? item.prs : [];
    const prs: MergedPr[] = [];
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id >= merged.length || assigned.has(id)) continue;
      assigned.add(id);
      prs.push(merged[id]);
    }
    if (!prs.length) continue;
    features.push({
      name: String(item.name ?? ''),
      summary: String(item.summary ?? ''),
      prs,
      ...(typeof item.overlap === 'string' && item.overlap && { overlap: item.overlap }),
    });
  }
  const left = merged.filter((_, id) => !assigned.has(id));
  if (left.length) features.push({ name: OTHER_FEATURE, summary: '', prs: left });
  return features;
}

export async function groupPrs(
  merged: MergedPr[],
  opusSentences: Record<string, string>,
  context: string | null,
  deps: GroupDeps,
): Promise<Feature[]> {
  const user = JSON.stringify(
    merged.map((pr, id) => ({
      id,
      repo: shortRepo(pr.repo),
      title: pr.title,
      branch: pr.headRefName,
      base: pr.baseRefName,
      body: pr.body.slice(0, BODY_CHARS),
      ...(opusSentences[`${pr.repo}#${pr.number}`] && {
        description: opusSentences[`${pr.repo}#${pr.number}`],
      }),
      lines: pr.additions + pr.deletions,
    })),
  );
  for (let attempt = 1; attempt <= GROUP_ATTEMPTS; attempt++) {
    try {
      const answer = await deps.call({
        job: JOB,
        model: MODELS.sonnet,
        system: withContext(readPrompt('devWeeklyGroup.md'), context),
        user,
        schema: GROUP_SCHEMA,
        maxTokens: GROUP_MAX_TOKENS,
      });
      return normalizeGroups(answer, merged);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error('Sonnet 連續兩次回傳無效的分組格式');
}

export interface ReportInput {
  mergedCount: number;
  features: Feature[];
  stuck: { pr: OpenPr; days: number }[];
  staleDrafts: { pr: OpenPr; days: number }[];
  undescribed: MergedPr[];
  staleIssues: { issue: OpenIssue; days: number }[];
  repos: string[];
  fetchedAt: string;
}

const link = (item: { repo: string; number: number; url: string }) =>
  `[${shortRepo(item.repo)}#${item.number}](${item.url})`;
const listOrNone = (lines: string[]) => (lines.length ? lines.join('\n') : '無');

function renderFeature(feature: Feature): string {
  const authors = [...new Set(feature.prs.map((pr) => pr.author))].sort().join('、');
  const links = feature.prs
    .slice(0, LINKS_PER_FEATURE)
    .map((pr) => `- ${link(pr)} ${escapeMarkdown(pr.title)}`);
  if (feature.prs.length > LINKS_PER_FEATURE)
    links.push(`- 另 ${feature.prs.length - LINKS_PER_FEATURE} 個`);
  return [`### ${feature.name}`, feature.summary, `作者：${authors}`, links.join('\n')]
    .filter(Boolean)
    .join('\n\n');
}

export function renderReport(input: ReportInput): string {
  const merged = input.features.flatMap((feature) => feature.prs);
  const totals = input.mergedCount
    ? `上週合併 ${input.mergedCount} 個 PR，${new Set(merged.map((pr) => pr.author)).size} 位作者，${new Set(merged.map((pr) => pr.repo)).size} 個 repo\n\n`
    : '';
  const completed = input.mergedCount
    ? input.features.map(renderFeature).join('\n\n')
    : '本週無合併的 PR';
  const progress = [
    ...input.stuck.map(
      ({ pr, days }) => `- ${link(pr)} ${escapeMarkdown(pr.title)} — ${pr.author}，${days} 天`,
    ),
    ...input.staleDrafts.map(
      ({ pr, days }) =>
        `- ${link(pr)} ${escapeMarkdown(pr.title)} — ${pr.author}，draft 已 ${days} 天沒有更新`,
    ),
  ];
  const anomalies = [
    ...input.undescribed.map(
      (pr) =>
        `- ${link(pr)} ${escapeMarkdown(pr.title)} — ${pr.author}，改動 ${pr.additions + pr.deletions} 行，描述少於 50 個字`,
    ),
    ...input.staleIssues.map(
      ({ issue, days }) =>
        `- ${link(issue)} ${escapeMarkdown(issue.title)} — ${issue.author}，${days} 天沒有更新，也沒有 PR 提到它`,
    ),
    ...input.features.flatMap((feature) =>
      feature.overlap
        ? [`- ${feature.name}：${feature.overlap}（${feature.prs.map(link).join('、')}）`]
        : [],
    ),
  ];
  const snapshot = new Date(input.fetchedAt).toLocaleString('sv', { timeZone: 'Asia/Taipei' });
  return [
    `${totals}## 本週完成\n\n${completed}`,
    `## 進行中／卡住\n\n${listOrNone(progress)}`,
    `## 異常\n\n${listOrNone(anomalies)}`,
    `## 已涵蓋的 repo\n\n${input.repos.map(shortRepo).join('、')}`,
    `以上「進行中」與 issue 為 ${snapshot} 的狀態`,
  ].join('\n\n');
}

const rawName = (week: string) => `devWeekly/raw/${week}`;
const opusName = (week: string) => `devWeekly/opus/${week}`;
const outputPath = (week: string) =>
  join(process.env.OUTPUT_DIR ?? 'output', 'devWeekly', `${week}.md`);
const prLabel = (pr: { repo: string; number: number }) => `${shortRepo(pr.repo)}#${pr.number}`;
const errorMessage = (error: unknown) => (error as Error).message;

export function previousWeek(today: string): string {
  const day = new Date(new Date(`${today}T00:00:00Z`).getTime() - 7 * DAY_MS);
  return isoWeek(day.toISOString().slice(0, 10));
}

function readContext(): string | null {
  try {
    return readFileSync(join(process.env.CONFIG_DIR ?? 'config', 'devWeeklyContext.md'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function collectAll(
  options: Options,
  deps: Deps,
  warnings: string[],
): Promise<{ raw: RawWeek; failedRepos: number }> {
  const raw: RawWeek = {
    week: options.week,
    fetchedAt: deps.now().toISOString(),
    merged: [],
    openPrs: [],
    openIssues: [],
  };
  const errors: string[] = [];
  for (const repo of options.config.repos) {
    try {
      const data = await collectRepo(repo, options.week, options.config.token, deps);
      raw.merged.push(...data.merged);
      raw.openPrs.push(...data.openPrs);
      raw.openIssues.push(...data.openIssues);
      warnings.push(...data.warnings);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  if (errors.length === options.config.repos.length) throw new Error(errors[0]);
  warnings.push(...errors);
  return { raw, failedRepos: errors.length };
}

async function describeLargePrs(
  raw: RawWeek,
  options: Options,
  deps: Deps,
  warnings: string[],
): Promise<Record<string, string>> {
  const { selected, skipped } = selectForOpus(raw.merged);
  if (skipped.length)
    warnings.push(
      `每週最多讓 Opus 讀 ${OPUS_MAX_PRS} 個 diff，這些 PR 沒有處理：${skipped.map(prLabel).join('、')}`,
    );
  const sentences = load<Record<string, string>>(opusName(options.week), {});
  for (const pr of selected) {
    const key = `${pr.repo}#${pr.number}`;
    if (sentences[key]) continue;
    try {
      const { text, truncated } = trimDiff(await fetchDiff(pr, options.config.token, deps));
      if (truncated) warnings.push(`${prLabel(pr)}: diff 已截斷`);
      const answer = await deps.call({
        job: JOB,
        model: MODELS.opus,
        system: readPrompt('devWeeklyDiff.md'),
        user: JSON.stringify({
          title: pr.title,
          body: pr.body.slice(0, DIFF_BODY_CHARS),
          diff: text,
        }),
      });
      sentences[key] = (answer as string).trim();
      save(opusName(options.week), sentences);
    } catch (error) {
      warnings.push(`${prLabel(pr)}: Opus 說明失敗：${errorMessage(error)}`);
    }
  }
  return sentences;
}

export function readMembers(): string[] {
  try {
    const file = parseYaml(
      readFileSync(join(process.env.CONFIG_DIR ?? 'config', 'prStats.yaml'), 'utf8'),
    ) as { members?: unknown } | null;
    return Array.isArray(file?.members) ? file.members.map(String) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function run(options: Options, deps: Deps): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const weekEnd = Date.parse(`${weekStart(options.week)}T00:00:00+08:00`) + 7 * DAY_MS;
  let raw = load<RawWeek | null>(rawName(options.week), null);
  if (raw && Date.parse(raw.fetchedAt) < weekEnd) raw = null;
  if (!raw) {
    const collected = await collectAll(options, deps, warnings);
    raw = collected.raw;
    if (!collected.failedRepos) save(rawName(options.week), raw);
    if (deps.now().getTime() - weekEnd > OLD_WEEK_DAYS * DAY_MS)
      warnings.push(
        '這一週已經結束超過 7 天，「進行中」與 issue 顯示的是目前的狀態，不是那一週當時的',
      );
  }
  const context = readContext();
  if (context === null) warnings.push('找不到 config/devWeeklyContext.md，功能命名會比較籠統');

  const members = new Set(options.config.members);
  if (!members.size) warnings.push('config/prStats.yaml 沒有成員名單，週報未依團隊過濾');
  const byTeam = (item: { author: string }) => !members.size || members.has(item.author);
  const team = {
    ...raw,
    merged: raw.merged.filter(byTeam),
    openPrs: raw.openPrs.filter(byTeam),
    openIssues: raw.openIssues.filter(byTeam),
  };

  const sentences = await describeLargePrs(team, options, deps, warnings);
  const features = team.merged.length ? await groupPrs(team.merged, sentences, context, deps) : [];
  const snapshot = new Date(raw.fetchedAt);
  const text = note({
    title: `[開發週報] ${options.week}`,
    body: renderReport({
      mergedCount: team.merged.length,
      features,
      stuck: stuckPrs(team.openPrs, snapshot),
      staleDrafts: staleDrafts(team.openPrs, snapshot),
      undescribed: team.merged.filter(isUndescribedLarge),
      staleIssues: staleIssues(
        team.openIssues,
        referencedIssues([...raw.merged, ...raw.openPrs]),
        snapshot,
      ),
      repos: options.config.repos,
      fetchedAt: raw.fetchedAt,
    }),
    warnings,
    costUsd: runCost(JOB, startedAt),
  });
  mkdirSync(join(outputPath(options.week), '..'), { recursive: true });
  writeFileSync(outputPath(options.week), text);
  if (!options.upload) return { url: null, warnings };

  const { url, status } = await deps.publish(`radar-dev-weekly-${options.week}`, text);
  console.log(`${url} (${status})`);
  if (status === 'editedOnWeb')
    console.warn(`${url} was edited on the web, so it was not overwritten`);
  return { url, warnings };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { week: { type: 'string' }, 'no-upload': { type: 'boolean' } },
  });
  const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Taipei' });
  const week = values.week ?? previousWeek(today);
  if (!/^\d{4}-W\d{2}$/.test(week)) throw new Error(`--week must look like 2026-W45, got ${week}`);
  await recordRun(
    JOB,
    withIndex(
      JOB,
      () => {
        const token = process.env.GITHUB_TOKEN;
        if (!token) throw new Error('GITHUB_TOKEN is not set');
        const configFile = parseYaml(
          readFileSync(join(process.env.CONFIG_DIR ?? 'config', 'repos.yaml'), 'utf8'),
        ) as { repos: string[] };
        return run(
          {
            week,
            upload: !values['no-upload'],
            config: { repos: configFile.repos, token, members: readMembers() },
          },
          {
            fetch,
            sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
            now: () => new Date(),
            call,
            publish,
          },
        );
      },
      publish,
    ),
  );
}
