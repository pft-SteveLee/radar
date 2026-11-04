import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type call, MODELS } from '../lib/claude.ts';
import type { publish } from '../lib/codimd.ts';
import type { ChangeItem } from './changelogSources.ts';

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
