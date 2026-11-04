import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCost } from './claude.ts';

export interface RunResult {
  url: string | null;
  warnings: string[];
}

export interface RunRecord {
  job: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'failed';
  error: string | null;
  warnings: string[];
  costUsd: number;
  url: string | null;
}

const runLogPath = () => join(process.env.OUTPUT_DIR ?? 'output', 'runs.jsonl');

function append(record: RunRecord): void {
  mkdirSync(join(runLogPath(), '..'), { recursive: true });
  appendFileSync(runLogPath(), `${JSON.stringify(record)}\n`);
}

// Writes one record per run, also when the job fails, then lets the failure reach the caller.
export async function recordRun(job: string, work: () => Promise<RunResult>): Promise<void> {
  const startedAt = new Date().toISOString();
  const finish = (outcome: Pick<RunRecord, 'status' | 'error' | 'warnings' | 'url'>) =>
    append({
      job,
      startedAt,
      finishedAt: new Date().toISOString(),
      costUsd: runCost(job, startedAt),
      ...outcome,
    });
  try {
    const { url, warnings } = await work();
    finish({ status: 'ok', error: null, warnings, url });
  } catch (error) {
    finish({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      warnings: [],
      url: null,
    });
    throw error;
  }
}

export function readRuns(limit: number): RunRecord[] {
  let log: string;
  try {
    log = readFileSync(runLogPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunRecord)
    .reverse()
    .slice(0, limit);
}
