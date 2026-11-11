import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fetchCommits, fetchWeek, isoWeek, run, weekStart, weeksBetween } from '../jobs/prStats.ts';

const searchPage = (logins: string[], totalCount = logins.length) =>
  new Response(
    JSON.stringify({
      total_count: totalCount,
      items: logins.map((login) => ({ user: { login } })),
    }),
    { status: 200 },
  );

const emptyOrganization = {
  organization: { repositories: { nodes: [], pageInfo: { hasNextPage: false } } },
};

function fakeDeps(
  responses: (() => Response)[],
  graphql: (query: string, variables: Record<string, string>) => unknown = () => emptyOrganization,
) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const sleeps: number[] = [];
  return {
    urls,
    headers,
    sleeps,
    deps: {
      fetch: (async (url: string, init?: RequestInit) => {
        if (url === 'https://api.github.com/graphql') {
          const body = JSON.parse(init?.body as string);
          const data = graphql(body.query, body.variables);
          if (data instanceof Error)
            return new Response(JSON.stringify({ errors: [{ message: data.message }] }), {
              status: 200,
            });
          const missing = (data as { node?: null }).node === null;
          return new Response(
            JSON.stringify({
              data,
              ...(missing && {
                errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }],
              }),
            }),
            { status: 200 },
          );
        }
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
    commits: {},
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

interface FakeCommit {
  oid: string;
  committedDate: string;
  parents?: number;
  login?: string | null;
  noAuthor?: true;
}
interface FakeBranch {
  id: string;
  tip: string;
  commits: FakeCommit[];
}

function fakeGithub(repositories: Record<string, FakeBranch[]>, failing: string[] = []) {
  const historyQueries: string[] = [];
  const graphql = (query: string, variables: Record<string, string>) => {
    if (query.includes('query Repos'))
      return {
        organization: {
          repositories: {
            nodes: Object.keys(repositories).map((name) => ({ name })),
            pageInfo: { hasNextPage: false },
          },
        },
      };
    if (query.includes('query Branches')) {
      if (failing.includes(variables.name)) return new Error('boom');
      return {
        repository: {
          refs: {
            nodes: repositories[variables.name].map((branch) => ({
              id: branch.id,
              target: { committedDate: branch.tip },
            })),
            pageInfo: { hasNextPage: false },
          },
        },
      };
    }
    historyQueries.push(variables.id);
    const branch = Object.values(repositories)
      .flat()
      .find((candidate) => candidate.id === variables.id);
    return {
      node: {
        target: {
          history: {
            nodes: (branch?.commits ?? []).map((commit) => ({
              oid: commit.oid,
              committedDate: commit.committedDate,
              parents: { totalCount: commit.parents ?? 1 },
              author: commit.noAuthor
                ? null
                : { user: commit.login === null ? null : { login: commit.login ?? 'alice' } },
            })),
            pageInfo: { hasNextPage: false },
          },
        },
      },
    };
  };
  return { graphql, historyQueries };
}

test('fetchCommits counts a commit once per repo, however many branches hold it', async () => {
  const shared = { oid: 'a1', committedDate: '2026-11-03T02:00:00Z' };
  const { graphql } = fakeGithub({
    one: [
      { id: 'b1', tip: '2026-11-03T02:00:00Z', commits: [shared] },
      {
        id: 'b2',
        tip: '2026-11-03T02:00:00Z',
        commits: [shared, { oid: 'a2', committedDate: '2026-11-03T01:00:00Z' }],
      },
    ],
  });
  const { deps } = fakeDeps([], graphql);

  const result = await fetchCommits('2026-11-02', '2026-11-04', config, deps);

  assert.deepEqual(result.weeks, { '2026-W45': { alice: 2 } });
});

test('fetchCommits skips merge commits and commits without a GitHub account', async () => {
  const { graphql } = fakeGithub({
    one: [
      {
        id: 'b1',
        tip: '2026-11-03T02:00:00Z',
        commits: [
          { oid: 'a1', committedDate: '2026-11-03T02:00:00Z', parents: 2 },
          { oid: 'a2', committedDate: '2026-11-03T02:00:00Z', login: null },
          { oid: 'a3', committedDate: '2026-11-03T02:00:00Z', login: 'bob' },
        ],
      },
    ],
  });
  const { deps } = fakeDeps([], graphql);

  const result = await fetchCommits('2026-11-02', '2026-11-04', config, deps);

  assert.deepEqual(result.weeks, { '2026-W45': { bob: 1 } });
});

test('fetchCommits puts a commit into the Taipei week, not the UTC one', async () => {
  const { graphql } = fakeGithub({
    one: [
      {
        id: 'b1',
        tip: '2026-11-08T16:30:00Z',
        commits: [
          { oid: 'sunday', committedDate: '2026-11-08T15:59:00Z' },
          { oid: 'monday', committedDate: '2026-11-08T16:00:00Z' },
        ],
      },
    ],
  });
  const { deps } = fakeDeps([], graphql);

  const result = await fetchCommits('2026-11-02', '2026-11-10', config, deps);

  assert.deepEqual(result.weeks, { '2026-W45': { alice: 1 }, '2026-W46': { alice: 1 } });
});

test('fetchCommits does not read the history of a branch last changed before the range', async () => {
  const { graphql, historyQueries } = fakeGithub({
    one: [
      {
        id: 'old',
        tip: '2026-10-01T00:00:00Z',
        commits: [{ oid: 'o1', committedDate: '2026-10-01T00:00:00Z' }],
      },
      {
        id: 'new',
        tip: '2026-11-03T02:00:00Z',
        commits: [{ oid: 'n1', committedDate: '2026-11-03T02:00:00Z' }],
      },
    ],
  });
  const { deps } = fakeDeps([], graphql);

  await fetchCommits('2026-11-02', '2026-11-04', config, deps);

  assert.deepEqual(historyQueries, ['new']);
});

test('fetchCommits warns about a repo that fails and still counts the others', async () => {
  const { graphql } = fakeGithub(
    {
      broken: [],
      fine: [
        {
          id: 'b1',
          tip: '2026-11-03T02:00:00Z',
          commits: [{ oid: 'a1', committedDate: '2026-11-03T02:00:00Z' }],
        },
      ],
    },
    ['broken'],
  );
  const { deps } = fakeDeps([], graphql);

  const result = await fetchCommits('2026-11-02', '2026-11-04', config, deps);

  assert.deepEqual(result.weeks, { '2026-W45': { alice: 1 } });
  assert.match(result.warnings[0], /perfect-corp\/broken.*boom/);
});

test('run stores commits next to the PR counts, and leaves them out when commits cannot be read', async () => {
  const { graphql } = fakeGithub({
    one: [
      {
        id: 'b1',
        tip: '2026-11-03T02:00:00Z',
        commits: [{ oid: 'a1', committedDate: '2026-11-03T02:00:00Z' }],
      },
    ],
  });
  const { deps } = fakeDeps([() => searchPage(['bob'])], graphql);
  await run({ from: '2026-11-04', to: '2026-11-04', config }, deps);
  const stored = JSON.parse(readFileSync(join(outputDir, 'prStats', '2026-W45.json'), 'utf8'));
  assert.deepEqual(stored.commits, { alice: 1 });

  outputDir = mkdtempSync(join(tmpdir(), 'radar-prstats-'));
  process.env.OUTPUT_DIR = outputDir;
  const failing = fakeDeps([() => searchPage(['bob'])], () => new Error('no access'));
  const result = await run({ from: '2026-11-04', to: '2026-11-04', config }, failing.deps);
  const kept = JSON.parse(readFileSync(join(outputDir, 'prStats', '2026-W45.json'), 'utf8'));
  assert.equal('commits' in kept, false);
  assert.deepEqual(kept.counts, { bob: 1 });
  assert.match(result.warnings[0], /commits.*no access/);
});

test('fetchCommits skips a commit without an author and a branch deleted during the run', async () => {
  const { graphql } = fakeGithub({
    one: [
      {
        id: 'b1',
        tip: '2026-11-03T02:00:00Z',
        commits: [
          { oid: 'a1', committedDate: '2026-11-03T02:00:00Z', noAuthor: true },
          { oid: 'a2', committedDate: '2026-11-03T02:00:00Z' },
        ],
      },
    ],
  });
  const withDeletedBranch = (query: string, variables: Record<string, string>) =>
    query.includes('query History') && variables.id === 'gone'
      ? { node: null }
      : graphql(query, variables);
  const branches = (query: string, variables: Record<string, string>) => {
    const data = withDeletedBranch(query, variables) as {
      repository?: { refs: { nodes: unknown[] } };
    };
    if (query.includes('query Branches'))
      data.repository?.refs.nodes.push({
        id: 'gone',
        target: { committedDate: '2026-11-03T02:00:00Z' },
      });
    return data;
  };
  const { deps } = fakeDeps([], branches);

  const result = await fetchCommits('2026-11-02', '2026-11-04', config, deps);

  assert.deepEqual(result.weeks, { '2026-W45': { alice: 1 } });
  assert.deepEqual(result.warnings, []);
});

test('run keeps the commits of an earlier run when this run could not read every repo', async () => {
  const good = fakeGithub({
    one: [
      {
        id: 'b1',
        tip: '2026-11-03T02:00:00Z',
        commits: [{ oid: 'a1', committedDate: '2026-11-03T02:00:00Z' }],
      },
    ],
  });
  await run(
    { from: '2026-11-04', to: '2026-11-04', config },
    fakeDeps([() => searchPage(['bob'])], good.graphql).deps,
  );

  const broken = fakeGithub({ one: [] }, ['one']);
  const result = await run(
    { from: '2026-11-04', to: '2026-11-04', config },
    fakeDeps([() => searchPage(['bob'])], broken.graphql).deps,
  );

  const stored = JSON.parse(readFileSync(join(outputDir, 'prStats', '2026-W45.json'), 'utf8'));
  assert.deepEqual(stored.commits, { alice: 1 });
  assert.match(result.warnings[0], /one.*boom/);
});

test('fetchCommits asks only for repositories that are not forks', async () => {
  const queries: string[] = [];
  const { deps } = fakeDeps([], (query) => {
    queries.push(query);
    return emptyOrganization;
  });

  await fetchCommits('2026-11-02', '2026-11-04', config, deps);

  assert.match(queries[0], /isFork: false/);
});

test('fetchCommits retries a 502 from GraphQL instead of giving up the repo', async () => {
  let failed = false;
  const { graphql } = fakeGithub({
    one: [
      {
        id: 'b1',
        tip: '2026-11-03T02:00:00Z',
        commits: [{ oid: 'a1', committedDate: '2026-11-03T02:00:00Z' }],
      },
    ],
  });
  const { deps, sleeps } = fakeDeps([], graphql);
  const inner = deps.fetch;
  const flaky = {
    ...deps,
    fetch: (async (url: string, init?: RequestInit) => {
      if (!failed && String(init?.body).includes('query Branches')) {
        failed = true;
        return new Response('{}', { status: 502 });
      }
      return inner(url, init);
    }) as typeof fetch,
  };

  const result = await fetchCommits('2026-11-02', '2026-11-04', config, flaky);

  assert.deepEqual(result.weeks, { '2026-W45': { alice: 1 } });
  assert.deepEqual(result.warnings, []);
  assert.equal(sleeps.length, 1);
});

test('run still replaces a week file that an earlier run left unreadable', async () => {
  mkdirSync(join(outputDir, 'prStats'));
  writeFileSync(join(outputDir, 'prStats', '2026-W45.json'), '{ half');
  const broken = fakeGithub({ one: [] }, ['one']);

  await run(
    { from: '2026-11-04', to: '2026-11-04', config },
    fakeDeps([() => searchPage(['bob'])], broken.graphql).deps,
  );

  const stored = JSON.parse(readFileSync(join(outputDir, 'prStats', '2026-W45.json'), 'utf8'));
  assert.deepEqual(stored.counts, { bob: 1 });
});

test('fetchCommits retries a network error from GraphQL', async () => {
  const { graphql } = fakeGithub({
    one: [
      {
        id: 'b1',
        tip: '2026-11-03T02:00:00Z',
        commits: [{ oid: 'a1', committedDate: '2026-11-03T02:00:00Z' }],
      },
    ],
  });
  const { deps } = fakeDeps([], graphql);
  const inner = deps.fetch;
  let dropped = false;
  const flaky = {
    ...deps,
    fetch: (async (url: string, init?: RequestInit) => {
      if (!dropped && String(init?.body).includes('query History')) {
        dropped = true;
        throw new TypeError('fetch failed');
      }
      return inner(url, init);
    }) as typeof fetch,
  };

  const result = await fetchCommits('2026-11-02', '2026-11-04', config, flaky);

  assert.deepEqual(result.weeks, { '2026-W45': { alice: 1 } });
  assert.deepEqual(result.warnings, []);
});

test('fetchCommits names an organization that cannot be read, and skips a repo that vanished', async () => {
  const { deps } = fakeDeps([], () => ({ organization: null }));
  await assert.rejects(fetchCommits('2026-11-02', '2026-11-04', config, deps), /perfect-corp/);

  const { graphql } = fakeGithub({ one: [] });
  const vanished = fakeDeps([], (query, variables) =>
    query.includes('query Branches') ? { repository: null } : graphql(query, variables),
  );
  const result = await fetchCommits('2026-11-02', '2026-11-04', config, vanished.deps);
  assert.deepEqual(result, { weeks: {}, warnings: [] });
});
