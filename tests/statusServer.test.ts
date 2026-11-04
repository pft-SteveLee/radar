import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { isoWeek } from '../jobs/prStats.ts';
import { createStatusServer } from '../web/statusServer.ts';

let outputDir: string;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  outputDir = mkdtempSync(join(tmpdir(), 'radar-output-'));
  process.env.OUTPUT_DIR = outputDir;
  server = createStatusServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

test('GET / serves the page built from the cost and run files', async () => {
  const now = new Date().toISOString();
  writeFileSync(
    join(outputDir, 'cost.jsonl'),
    `${JSON.stringify({ ts: now, job: 'reddit_digest', model: 'm', usd: 1.5 })}\n`,
  );
  writeFileSync(
    join(outputDir, 'runs.jsonl'),
    `${JSON.stringify({ job: 'reddit_digest', startedAt: now, finishedAt: now, status: 'failed', error: 'boom', warnings: [], costUsd: 1.5, url: null })}\n`,
  );

  const response = await fetch(baseUrl);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(html, /\$1\.50 \/ \$100/);
  assert.match(html, /boom/);
});

test('GET / works before any job has run', async () => {
  const response = await fetch(baseUrl);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /尚無執行紀錄/);
});

test('GET /prs shows the stored weekly counts of the configured members', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'radar-config-'));
  process.env.CONFIG_DIR = configDir;
  writeFileSync(join(configDir, 'prStats.yaml'), 'orgs: [perfect-corp]\nmembers: [alice]\n');
  const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Taipei' });
  const week = isoWeek(today);
  mkdirSync(join(outputDir, 'prStats'));
  writeFileSync(
    join(outputDir, 'prStats', `${week}.json`),
    JSON.stringify({ week, fetchedAt: today, counts: { alice: 7, outsider: 3 } }),
  );

  const response = await fetch(`${baseUrl}/prs?weeks=12`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, new RegExp(`<th scope="row">${week}</th><td>7</td>`));
  assert.doesNotMatch(html, /outsider/);
});

test('GET /prs with a bad query or no config still answers with a page', async () => {
  process.env.CONFIG_DIR = mkdtempSync(join(tmpdir(), 'radar-config-'));

  const response = await fetch(`${baseUrl}/prs?from=nope&weeks=999`);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /請在 config\/prStats\.yaml 填 members/);
});

test('any other path is a 404', async () => {
  assert.equal((await fetch(`${baseUrl}/secret`)).status, 404);
});

test('a corrupt run log gives a 500 and the server keeps answering', async () => {
  writeFileSync(join(outputDir, 'runs.jsonl'), 'not json\n');

  assert.equal((await fetch(baseUrl)).status, 500);

  writeFileSync(join(outputDir, 'runs.jsonl'), '');
  assert.equal((await fetch(baseUrl)).status, 200);
});
