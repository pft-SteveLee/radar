import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { readRuns, recordRun } from '../lib/runLog.ts';

let outputDir: string;

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), 'radar-output-'));
  process.env.OUTPUT_DIR = outputDir;
});

const logCost = (job: string, usd: number) => {
  mkdirSync(outputDir, { recursive: true });
  appendFileSync(
    join(outputDir, 'cost.jsonl'),
    `${JSON.stringify({ ts: new Date().toISOString(), job, model: 'm', usd })}\n`,
  );
};

test('recordRun stores an ok record with the note url, the warnings and the cost of this run', async () => {
  logCost('a', 9);
  await new Promise((resolve) => setTimeout(resolve, 5));

  await recordRun('a', async () => {
    logCost('a', 0.25);
    logCost('b', 5);
    return { url: 'https://codimd.test/a', warnings: ['feed down'] };
  });

  const [record] = readRuns(10);
  assert.equal(record.job, 'a');
  assert.equal(record.status, 'ok');
  assert.equal(record.error, null);
  assert.equal(record.url, 'https://codimd.test/a');
  assert.deepEqual(record.warnings, ['feed down']);
  assert.equal(record.costUsd, 0.25);
  assert.ok(record.startedAt <= record.finishedAt);
});

test('recordRun stores a failed record with the error message and throws the error again', async () => {
  const failure = new Error('CodiMD down');

  await assert.rejects(
    recordRun('a', async () => {
      throw failure;
    }),
    failure,
  );

  const [record] = readRuns(10);
  assert.equal(record.status, 'failed');
  assert.equal(record.error, 'CodiMD down');
  assert.equal(record.url, null);
  assert.deepEqual(record.warnings, []);
});

test('readRuns returns the newest runs first, at most the limit, and nothing without a log', async () => {
  assert.deepEqual(readRuns(10), []);

  for (const url of ['1', '2', '3']) {
    await recordRun('a', async () => ({ url, warnings: [] }));
  }

  assert.deepEqual(
    readRuns(2).map((record) => record.url),
    ['3', '2'],
  );
});
