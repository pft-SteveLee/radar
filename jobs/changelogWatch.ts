import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { call, MODELS, runCost } from '../lib/claude.ts';
import { publish } from '../lib/codimd.ts';
import { withIndex } from '../lib/noteIndex.ts';
import { note } from '../lib/render.ts';
import { type RunResult, recordRun } from '../lib/runLog.ts';
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
const TRIAGE_CHUNK_CHARS = 15_000;
const MAX_SUMMARY_CHANGES = 40;
const RESERVED_PER_SOURCE = 4;
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

function splitText(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split(/(?<=\n)/)) {
    for (let start = 0; start < line.length; start += TRIAGE_CHUNK_CHARS) {
      const piece = line.slice(start, start + TRIAGE_CHUNK_CHARS);
      if (current.length + piece.length > TRIAGE_CHUNK_CHARS) {
        chunks.push(current);
        current = '';
      }
      current += piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function triageItem(item: ChangeItem, deps: Deps): Promise<Change[] | null> {
  const changes: Change[] = [];
  for (const chunk of splitText(item.text)) {
    const chunkChanges = await triageChunk(item, chunk, deps);
    if (!chunkChanges) return null;
    changes.push(...chunkChanges);
  }
  return changes;
}

async function triageChunk(item: ChangeItem, text: string, deps: Deps): Promise<Change[] | null> {
  for (let attempt = 1; attempt <= TRIAGE_ATTEMPTS; attempt++) {
    try {
      const answer = await deps.call({
        job: JOB,
        model: MODELS.haiku,
        system: withContext(readPrompt('changelogTriage.md'), readContext()),
        user: JSON.stringify({ source: item.source, title: item.title, text }),
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

export const withContext = (prompt: string, context: string | null) =>
  context ? `${prompt}\n\n## 團隊背景\n\n${context}` : prompt;

const isUrgent = (change: Change) => change.category === '棄用' || change.category === '價格';

export function selectChanges(changes: Change[]): Change[] {
  const ranked = [...changes].sort(
    (a, b) => Number(isUrgent(b)) - Number(isUrgent(a)) || b.importance - a.importance,
  );
  const chosen = new Set<Change>(ranked.filter(isUrgent).slice(0, MAX_SUMMARY_CHANGES));
  const perSource = new Map<string, number>();
  for (const change of ranked) {
    const taken = perSource.get(change.source) ?? 0;
    if (chosen.size >= MAX_SUMMARY_CHANGES || taken >= RESERVED_PER_SOURCE) continue;
    if (!chosen.has(change)) chosen.add(change);
    perSource.set(change.source, taken + 1);
  }
  for (const change of ranked) if (chosen.size < MAX_SUMMARY_CHANGES) chosen.add(change);
  return ranked.filter((change) => chosen.has(change));
}

async function summarize(significant: Change[], context: string | null, deps: Deps) {
  return (await deps.call({
    job: JOB,
    model: MODELS.sonnet,
    system: withContext(readPrompt('changelogSummary.md'), context),
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
  const triageErrors: Error[] = [];
  let failedSources = 0;
  let triagedSources = 0;

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
      let itemChanges: Change[] | null;
      try {
        itemChanges = await triageItem(item, deps);
      } catch (error) {
        triageErrors.push(error as Error);
        warnings.push(
          `${source.id}: 篩選「${item.title}」失敗：${(error as Error).message}，下次執行會再試一次`,
        );
        triaged = false;
        break;
      }
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
    if (result.items.length) triagedSources++;
    newChanges.push(...sourceChanges);
    nextStates.push({ id: source.id, state: result.nextState });
    if (result.baseline) newBaselines.push(source.id);
  }
  if (failedSources === config.sources.length) throw new Error(warnings[0]);
  if (triageErrors.length && triagedSources === 0) throw triageErrors[0];

  const stored = load<WeekFile>(weekStateName(week), { changes: [], baselined: [] });
  const changes = [...stored.changes, ...newChanges];
  const baselined = [...new Set([...stored.baselined, ...newBaselines])];
  const significant = changes.filter((change) => change.importance >= SUMMARY_MIN_IMPORTANCE);
  const selected = selectChanges(significant);
  if (significant.length > selected.length)
    warnings.push(
      `本週有 ${significant.length} 項重要變更，週報只列出最重要的 ${selected.length} 項，另外 ${significant.length - selected.length} 項未列入`,
    );
  const context = readContext();
  if (significant.length && context === null)
    warnings.push('找不到 config/changelogContext.md，「對我們的影響」會比較籠統');

  const sections = [significant.length ? await summarize(selected, context, deps) : NO_UPDATES];
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
  const chosen = new Set(selected);
  writeFileSync(
    outputPath(week).replace(/\.md$/, '.triage.json'),
    JSON.stringify(
      {
        total: significant.length,
        selected: selected.length,
        changes: changes.map((change) => ({ ...change, selected: chosen.has(change) })),
      },
      null,
      2,
    ),
  );
  if (!upload) return { url: null, warnings };

  const { url, status } = await deps.publish(`radar-changelog-${week}`, text);
  console.log(`${url} (${status})`);
  if (status === 'editedOnWeb')
    console.warn(`${url} was edited on the web, so it was not overwritten`);

  for (const { id, state } of nextStates) save(sourceStateName(id), state);
  save(weekStateName(week), { changes, baselined } satisfies WeekFile);
  return { url, warnings };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'no-upload': { type: 'boolean' } } });
  await recordRun(
    JOB,
    withIndex(
      JOB,
      () => {
        const token = process.env.GITHUB_TOKEN;
        if (!token) throw new Error('GITHUB_TOKEN is not set');
        const configFile = parseYaml(
          readFileSync(join(process.env.CONFIG_DIR ?? 'config', 'changelog.yaml'), 'utf8'),
        ) as { sources: SourceConfig[] };
        return run(
          { upload: !values['no-upload'], config: { sources: configFile.sources, token } },
          { fetch, now: () => new Date(), call, publish },
        );
      },
      publish,
    ),
  );
}
