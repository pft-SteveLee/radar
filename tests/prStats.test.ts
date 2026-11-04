import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fetchWeek, isoWeek, run, weekStart, weeksBetween } from '../jobs/prStats.ts';

const searchPage = (logins: string[], totalCount = logins.length) =>
  new Response(
    JSON.stringify({
      total_count: totalCount,
      items: logins.map((login) => ({ user: { login } })),
    }),
    { status: 200 },
  );

function fakeDeps(responses: (() => Response)[]) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const sleeps: number[] = [];
  return {
    urls,
    headers,
    sleeps,
    deps: {
      fetch: (async (url: string, init?: RequestInit) => {
        urls.push(url);
        headers.push(init?.headers as Record<string, string>);
        const next = responses.shift();
        if (!next) throw new Error('no more responses');
        return next();
      }) as typeof fetch,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
      now: () => new Date('2026-11-04T03:00:00Z'),
    },
  };
}

const config = { orgs: ['perfect-corp'], token: 'secret-token' };

let outputDir: string;
beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), 'radar-prstats-'));
  process.env.OUTPUT_DIR = outputDir;
});

test('isoWeek names the ISO week of a calendar day, also across the year end', () => {
  assert.equal(isoWeek('2026-11-04'), '2026-W45');
  assert.equal(isoWeek('2026-11-02'), '2026-W45');
  assert.equal(isoWeek('2026-11-08'), '2026-W45');
  assert.equal(isoWeek('2026-12-31'), '2026-W53');
  assert.equal(isoWeek('2027-01-01'), '2026-W53');
  assert.equal(isoWeek('2027-01-04'), '2027-W01');
  assert.equal(isoWeek('2025-12-29'), '2026-W01');
});

test('weekStart gives the Monday of an ISO week', () => {
  assert.equal(weekStart('2026-W45'), '2026-11-02');
  assert.equal(weekStart('2026-W53'), '2026-12-28');
  assert.equal(weekStart('2026-W01'), '2025-12-29');
});

test('weeksBetween lists every week touched by the date range, in order', () => {
  assert.deepEqual(weeksBetween('2026-12-20', '2027-01-11'), [
    '2026-W51',
    '2026-W52',
    '2026-W53',
    '2027-W01',
    '2027-W02',
  ]);
  assert.deepEqual(weeksBetween('2026-11-04', '2026-11-04'), ['2026-W45']);
});

test('fetchWeek searches merged PRs of the org within the Taipei week and counts them per author', async () => {
  const { deps, urls, headers } = fakeDeps([() => searchPage(['alice', 'bob', 'alice'])]);

  const result = await fetchWeek('2026-W45', config, deps);

  assert.deepEqual(result, { counts: { alice: 2, bob: 1 }, warnings: [], truncated: false });
  const query = new URL(urls[0]).searchParams.get('q');
  assert.equal(
    query,
    'org:perfect-corp is:pr is:merged merged:2026-11-02T00:00:00+08:00..2026-11-08T23:59:59+08:00',
  );
  assert.equal(new URL(urls[0]).searchParams.get('per_page'), '100');
  assert.equal(headers[0].Authorization, 'Bearer secret-token');
});

test('fetchWeek follows the pages until every result is read', async () => {
  const fullPage = Array.from({ length: 100 }, () => 'alice');
  const { deps, urls, sleeps } = fakeDeps([
    () => searchPage(fullPage, 101),
    () => searchPage(['bob'], 101),
  ]);

  const result = await fetchWeek('2026-W45', config, deps);

  assert.deepEqual(result.counts, { alice: 100, bob: 1 });
  assert.equal(new URL(urls[1]).searchParams.get('page'), '2');
  assert.ok(sleeps.length >= 1);
});

test('fetchWeek warns when the week has more results than the search can return', async () => {
  const fullPage = Array.from({ length: 100 }, () => 'alice');
  const { deps, urls } = fakeDeps(
    Array.from({ length: 10 }, () => () => searchPage(fullPage, 1500)),
  );

  const result = await fetchWeek('2026-W45', config, deps);

  assert.equal(urls.length, 10);
  assert.equal(result.counts.alice, 1000);
  assert.equal(result.truncated, true);
  assert.match(result.warnings[0], /2026-W45.*1500.*1000/);
});

test('fetchWeek waits until the rate limit resets after a 403, then retries', async () => {
  const resetEpochSeconds = Date.parse('2026-11-04T03:00:30Z') / 1000;
  const { deps, sleeps } = fakeDeps([
    () =>
      new Response('{}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSeconds) },
      }),
    () => searchPage(['alice']),
  ]);

  const result = await fetchWeek('2026-W45', config, deps);

  assert.deepEqual(result.counts, { alice: 1 });
  assert.ok(sleeps.includes(31_000));
});

test('fetchWeek throws on an error that waiting does not fix', async () => {
  const { deps } = fakeDeps([() => new Response('{}', { status: 401 })]);

  await assert.rejects(fetchWeek('2026-W45', config, deps), /HTTP 401/);
});

test('run stores the counts of every week in the range and replaces an older file', async () => {
  const { deps } = fakeDeps([() => searchPage(['alice']), () => searchPage(['bob'])]);

  const result = await run({ from: '2026-10-26', to: '2026-11-04', config }, deps);

  assert.deepEqual(result, { url: null, warnings: [] });
  const stored = JSON.parse(readFileSync(join(outputDir, 'prStats', '2026-W45.json'), 'utf8'));
  assert.deepEqual(stored, {
    week: '2026-W45',
    fetchedAt: '2026-11-04T03:00:00.000Z',
    counts: { bob: 1 },
  });

  const rerun = fakeDeps([() => searchPage(['dave'])]);
  await run({ from: '2026-11-04', to: '2026-11-04', config }, rerun.deps);
  const replaced = JSON.parse(readFileSync(join(outputDir, 'prStats', '2026-W45.json'), 'utf8'));
  assert.deepEqual(replaced.counts, { dave: 1 });
});

test('run marks a week file as truncated only when the search cut the week short', async () => {
  const fullPage = Array.from({ length: 100 }, () => 'alice');
  const { deps } = fakeDeps(Array.from({ length: 10 }, () => () => searchPage(fullPage, 1500)));

  await run({ from: '2026-11-04', to: '2026-11-04', config }, deps);

  const stored = JSON.parse(readFileSync(join(outputDir, 'prStats', '2026-W45.json'), 'utf8'));
  assert.equal(stored.truncated, true);
  assert.equal(stored.counts.alice, 1000);
});

test('run keeps going and warns when one week fails, but fails when every week fails', async () => {
  const partly = fakeDeps([() => new Response('{}', { status: 500 }), () => searchPage(['alice'])]);
  const result = await run({ from: '2026-10-26', to: '2026-11-04', config }, partly.deps);
  assert.match(result.warnings[0], /2026-W44.*HTTP 500/);

  const allFail = fakeDeps([() => new Response('{}', { status: 401 })]);
  await assert.rejects(
    run({ from: '2026-11-04', to: '2026-11-04', config }, allFail.deps),
    /HTTP 401/,
  );
});
