import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type call, MODELS } from '../lib/claude.ts';
import { withContext } from './changelogWatch.ts';
import { type MergedPr, shortRepo } from './devWeeklyRules.ts';

const JOB = 'dev_weekly';
const GROUP_ATTEMPTS = 2;
const BODY_CHARS = 600;
const OTHER_FEATURE = '其他';

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
