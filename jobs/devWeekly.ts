import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type call, MODELS } from '../lib/claude.ts';
import { withContext } from './changelogWatch.ts';
import { type MergedPr, type OpenIssue, type OpenPr, shortRepo } from './devWeeklyRules.ts';

const JOB = 'dev_weekly';
const GROUP_ATTEMPTS = 2;
const BODY_CHARS = 600;
const OTHER_FEATURE = '其他';
const LINKS_PER_FEATURE = 5;

export interface Feature {
  name: string;
  summary: string;
  prs: MergedPr[];
  overlap?: string;
}

export interface GroupDeps {
  call: typeof call;
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
    const answer = await deps.call({
      job: JOB,
      model: MODELS.sonnet,
      system: withContext(readPrompt('devWeeklyGroup.md'), context),
      user,
      schema: GROUP_SCHEMA,
    });
    try {
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

const escapeMarkdown = (text: string) => text.replace(/[\\[\]|`]/g, '\\$&');
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
