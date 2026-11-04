import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type call, MODELS, runCost } from '../lib/claude.ts';
import type { publish } from '../lib/codimd.ts';
import { note } from '../lib/render.ts';
import type { RunResult } from '../lib/runLog.ts';
import { load, save } from '../lib/state.ts';
import {
  type ChangeItem,
  type CollectResult,
  collectSource,
  type SourceConfig,
} from './changelogSources.ts';
import { isoWeek } from './prStats.ts';

export const CATEGORIES = ['新功能', '修正', '棄用', '價格', '其他'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Change {
  source: string;
  version?: string;
  url: string;
  text: string;
  category: Category;
  importance: number;
}

export interface Deps {
  fetch: typeof fetch;
  now: () => Date;
  call: typeof call;
  publish: typeof publish;
}

const JOB = 'changelog_watch';
const TRIAGE_ATTEMPTS = 2;
const MAX_IMPORTANCE = 3;

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          category: { type: 'string', enum: [...CATEGORIES] },
          importance: { type: 'integer' },
        },
        required: ['text', 'category', 'importance'],
        additionalProperties: false,
      },
    },
  },
  required: ['changes'],
  additionalProperties: false,
};

const readPrompt = (name: string) =>
  readFileSync(join(process.env.PROMPTS_DIR ?? 'prompts', name), 'utf8');

interface RawChange {
  text: string;
  category: string;
  importance: number;
}

function parseChanges(answer: unknown): RawChange[] {
  const changes = (answer as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes)) throw new SyntaxError('triage answer has no changes array');
  return changes;
}

export async function triageItem(item: ChangeItem, deps: Deps): Promise<Change[] | null> {
  for (let attempt = 1; attempt <= TRIAGE_ATTEMPTS; attempt++) {
    try {
      const answer = await deps.call({
        job: JOB,
        model: MODELS.haiku,
        system: readPrompt('changelogTriage.md'),
        user: JSON.stringify({ source: item.source, title: item.title, text: item.text }),
        schema: TRIAGE_SCHEMA,
      });
      return parseChanges(answer).map((raw) => ({
        source: item.source,
        ...(item.version && { version: item.version }),
        url: item.url,
        text: raw.text,
        category: CATEGORIES.includes(raw.category as Category)
          ? (raw.category as Category)
          : '其他',
        importance: Math.min(MAX_IMPORTANCE, Math.max(0, Math.round(raw.importance))),
      }));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

export interface Config {
  sources: SourceConfig[];
  token: string;
}

interface WeekFile {
  changes: Change[];
  baselined: string[];
}

const SUMMARY_MIN_IMPORTANCE = 1;
const NO_UPDATES = '本週無重大更新';

const sourceStateName = (id: string) => `changelog/${id}`;
const weekStateName = (week: string) => `changelog/weeks/${week}`;
const outputPath = (week: string) =>
  join(process.env.OUTPUT_DIR ?? 'output', 'changelog', `${week}.md`);
const idList = (ids: string[]) => ids.map((id) => `- ${id}`).join('\n');

function readContext(): string | null {
  try {
    return readFileSync(join(process.env.CONFIG_DIR ?? 'config', 'changelogContext.md'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function summarize(significant: Change[], context: string | null, deps: Deps) {
  const isUrgent = (change: Change) => change.category === '棄用' || change.category === '價格';
  const system = [readPrompt('changelogSummary.md'), context && `## 團隊背景\n\n${context}`]
    .filter(Boolean)
    .join('\n\n');
  return (await deps.call({
    job: JOB,
    model: MODELS.sonnet,
    system,
    user: JSON.stringify({
      urgent: significant.filter(isUrgent),
      others: significant.filter((change) => !isUrgent(change)),
    }),
  })) as string;
}

export async function run(
  { upload, config }: { upload: boolean; config: Config },
  deps: Deps,
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const week = isoWeek(deps.now().toLocaleDateString('sv', { timeZone: 'Asia/Taipei' }));
  const sourceDeps = { fetch: deps.fetch, now: deps.now, token: config.token };
  const warnings: string[] = [];
  const checked: string[] = [];
  const newChanges: Change[] = [];
  const newBaselines: string[] = [];
  const nextStates: { id: string; state: unknown }[] = [];
  let failedSources = 0;

  for (const source of config.sources) {
    let result: CollectResult;
    try {
      result = await collectSource(
        source,
        load<unknown>(sourceStateName(source.id), null),
        sourceDeps,
      );
    } catch (error) {
      const message = (error as Error).message;
      warnings.push(message.startsWith(`${source.id}:`) ? message : `${source.id}: ${message}`);
      failedSources++;
      continue;
    }
    checked.push(source.id);
    const sourceChanges: Change[] = [];
    let triaged = true;
    for (const item of result.items) {
      const itemChanges = await triageItem(item, deps);
      if (!itemChanges) {
        warnings.push(
          `${source.id}: Haiku 篩選連續兩次回傳無效格式，「${item.title}」下次執行會再試一次`,
        );
        triaged = false;
        break;
      }
      sourceChanges.push(...itemChanges);
    }
    if (!triaged) continue;
    newChanges.push(...sourceChanges);
    nextStates.push({ id: source.id, state: result.nextState });
    if (result.baseline) newBaselines.push(source.id);
  }
  if (failedSources === config.sources.length) throw new Error(warnings[0]);

  const stored = load<WeekFile>(weekStateName(week), { changes: [], baselined: [] });
  const changes = [...stored.changes, ...newChanges];
  const baselined = [...new Set([...stored.baselined, ...newBaselines])];
  const significant = changes.filter((change) => change.importance >= SUMMARY_MIN_IMPORTANCE);
  const context = readContext();
  if (significant.length && context === null)
    warnings.push('找不到 config/changelogContext.md，「對我們的影響」會比較籠統');

  const sections = [significant.length ? await summarize(significant, context, deps) : NO_UPDATES];
  if (baselined.length) sections.push(`## 已建立基準\n\n${idList(baselined)}`);
  sections.push(`## 已檢查的來源\n\n${idList(checked)}`);
  const text = note({
    title: `[Changelog 週報] ${week}`,
    body: sections.join('\n\n'),
    warnings,
    costUsd: runCost(JOB, startedAt),
  });
  mkdirSync(join(outputPath(week), '..'), { recursive: true });
  writeFileSync(outputPath(week), text);
  if (!upload) return { url: null, warnings };

  const { url, status } = await deps.publish(`radar-changelog-${week}`, text);
  console.log(`${url} (${status})`);
  if (status === 'editedOnWeb')
    console.warn(`${url} was edited on the web, so it was not overwritten`);

  for (const { id, state } of nextStates) save(sourceStateName(id), state);
  save(weekStateName(week), { changes, baselined } satisfies WeekFile);
  return { url, warnings };
}
