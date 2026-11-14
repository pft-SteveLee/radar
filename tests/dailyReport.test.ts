import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fetchMyCommits,
  fetchPullRequests,
  renderReport,
  reportRange,
  run,
} from '../jobs/dailyReport.ts';

const config = { login: 'me', orgs: ['perfect-corp'], token: 'secret-token' };
const range = { from: '2026-11-13', to: '2026-11-15' };

interface FakeCommit {
  oid: string;
  headline?: string;
  parents?: number;
}
interface FakeBranch {
  id: string;
  tip: string;
  commits: FakeCommit[];
}
interface FakeGithub {
  orgRepos?: Record<string, FakeBranch[]>;
  ownRepos?: Record<string, FakeBranch[]>;
  failing?: string[];
  search?: (query: string) => unknown[];
  searchCount?: number;
}

const lastPage = { hasNextPage: false, endCursor: null };

function fakeDeps(github: FakeGithub = {}) {
  const orgRepos = github.orgRepos ?? {};
  const ownRepos = github.ownRepos ?? {};
  const repositories = { ...orgRepos, ...ownRepos };
  const queries: { query: string; variables: Record<string, string> }[] = [];
  const answer = (query: string, variables: Record<string, string>) => {
    if (query.includes('query Me'))
      return {
        user: {
          id: 'U_me',
          repositories: {
            nodes: Object.keys(ownRepos).map((nameWithOwner) => ({ nameWithOwner })),
            pageInfo: lastPage,
          },
        },
      };
    if (query.includes('query Repos'))
      return {
        organization: {
          repositories: {
            nodes: Object.keys(orgRepos).map((repo) => ({ name: repo.split('/')[1] })),
            pageInfo: lastPage,
          },
        },
      };
    if (query.includes('query Branches')) {
      const repo = `${variables.owner}/${variables.name}`;
      if (github.failing?.includes(repo)) return new Error('boom');
      return {
        repository: {
          refs: {
            nodes: repositories[repo].map((branch) => ({
              id: branch.id,
              target: { committedDate: branch.tip },
            })),
            pageInfo: lastPage,
          },
        },
      };
    }
    if (query.includes('query MyHistory')) {
      const branch = Object.values(repositories)
        .flat()
        .find((candidate) => candidate.id === variables.id);
      return {
        node: {
          target: {
            history: {
              nodes: (branch?.commits ?? []).map((commit) => ({
                oid: commit.oid,
                messageHeadline: commit.headline ?? `commit ${commit.oid}`,
                url: `https://github.test/commit/${commit.oid}`,
                parents: { totalCount: commit.parents ?? 1 },
              })),
              pageInfo: lastPage,
            },
          },
        },
      };
    }
    const nodes = github.search?.(variables.q) ?? [];
    return {
      search: { issueCount: github.searchCount ?? nodes.length, nodes, pageInfo: lastPage },
    };
  };
  return {
    queries,
    deps: {
      fetch: (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        queries.push(body);
        const data = answer(body.query, body.variables);
        return new Response(
          JSON.stringify(
            data instanceof Error ? { errors: [{ message: data.message }] } : { data },
          ),
          { status: 200 },
        );
      }) as typeof fetch,
      sleep: async () => {},
      now: () => new Date('2026-11-16T00:30:00Z'),
    },
  };
}

const inRange = '2026-11-13T02:00:00Z';

test('reportRange on a Monday covers Friday to Sunday', () => {
  assert.deepEqual(reportRange('2026-11-16'), { from: '2026-11-13', to: '2026-11-15' });
});

test('reportRange on any other day covers the day before', () => {
  assert.deepEqual(reportRange('2026-11-17'), { from: '2026-11-16', to: '2026-11-16' });
  assert.deepEqual(reportRange('2026-11-01'), { from: '2026-10-31', to: '2026-10-31' });
});

test('fetchMyCommits lists my commits of org repos and my own repos, once per repo', async () => {
  const shared = { oid: 'a1', headline: 'feat: shared' };
  const { deps, queries } = fakeDeps({
    orgRepos: {
      'perfect-corp/one': [
        { id: 'b1', tip: inRange, commits: [shared] },
        { id: 'b2', tip: inRange, commits: [shared, { oid: 'a2', headline: 'fix: second' }] },
      ],
    },
    ownRepos: { 'me/home': [{ id: 'b3', tip: inRange, commits: [{ oid: 'a3' }] }] },
  });

  const result = await fetchMyCommits(range, config, deps);

  assert.deepEqual(result, {
    commits: [
      { repo: 'perfect-corp/one', headline: 'feat: shared', url: 'https://github.test/commit/a1' },
      { repo: 'perfect-corp/one', headline: 'fix: second', url: 'https://github.test/commit/a2' },
      { repo: 'me/home', headline: 'commit a3', url: 'https://github.test/commit/a3' },
    ],
    warnings: [],
  });
  const history = queries.find(({ query }) => query.includes('query MyHistory'));
  assert.deepEqual(history?.variables, {
    id: 'b1',
    author: 'U_me',
    since: '2026-11-13T00:00:00+08:00',
    until: '2026-11-16T00:00:00+08:00',
    after: null,
  });
});

test('fetchMyCommits skips merge commits and branches whose tip is older than the range', async () => {
  const { deps, queries } = fakeDeps({
    orgRepos: {
      'perfect-corp/one': [
        { id: 'b1', tip: inRange, commits: [{ oid: 'merge', parents: 2 }, { oid: 'a1' }] },
        { id: 'old', tip: '2026-11-12T15:59:00Z', commits: [{ oid: 'a9' }] },
      ],
    },
  });

  const result = await fetchMyCommits(range, config, deps);

  assert.deepEqual(
    result.commits.map((commit) => commit.headline),
    ['commit a1'],
  );
  assert.ok(!queries.some(({ variables }) => variables.id === 'old'));
});

test('fetchMyCommits warns about a repo that fails and still lists the others', async () => {
  const { deps } = fakeDeps({
    orgRepos: {
      'perfect-corp/broken': [],
      'perfect-corp/one': [{ id: 'b1', tip: inRange, commits: [{ oid: 'a1' }] }],
    },
    failing: ['perfect-corp/broken'],
  });

  const result = await fetchMyCommits(range, config, deps);

  assert.equal(result.commits.length, 1);
  assert.deepEqual(result.warnings, ['commits perfect-corp/broken: boom']);
});

const pullRequest = (number: number, reviewedAt: string[] = []) => ({
  number,
  title: `title ${number}`,
  url: `https://github.test/pull/${number}`,
  repository: { nameWithOwner: 'perfect-corp/one' },
  reviews: { nodes: reviewedAt.map((submittedAt) => ({ submittedAt })) },
});
const listed = (number: number) => ({
  repo: 'perfect-corp/one',
  number,
  title: `title ${number}`,
  url: `https://github.test/pull/${number}`,
});

test('fetchPullRequests reads the PRs I opened, the ones merged and the ones I reviewed', async () => {
  const { deps } = fakeDeps({
    search: (query) =>
      ({
        'is:pr author:me created:2026-11-13T00:00:00+08:00..2026-11-15T23:59:59+08:00': [
          pullRequest(1),
        ],
        'is:pr author:me merged:2026-11-13T00:00:00+08:00..2026-11-15T23:59:59+08:00': [
          pullRequest(2),
        ],
        'is:pr reviewed-by:me -author:me updated:>=2026-11-13T00:00:00+08:00': [
          pullRequest(3, ['2026-11-14T03:00:00Z']),
        ],
      })[query] ?? [],
  });

  const result = await fetchPullRequests(range, config, deps);

  assert.deepEqual(result, {
    opened: [listed(1)],
    merged: [listed(2)],
    reviewed: [listed(3)],
    warnings: [],
  });
});

test('fetchPullRequests lists a reviewed PR only when my review was submitted in the range, Taipei time', async () => {
  const { deps } = fakeDeps({
    search: (query) =>
      query.includes('reviewed-by')
        ? [
            pullRequest(1, ['2026-11-12T15:59:59Z']),
            pullRequest(2, ['2026-11-12T16:00:00Z']),
            pullRequest(3, ['2026-11-01T00:00:00Z', '2026-11-15T15:59:59Z']),
            pullRequest(4, ['2026-11-15T16:00:00Z']),
          ]
        : [],
  });

  const result = await fetchPullRequests(range, config, deps);

  assert.deepEqual(
    result.reviewed.map((pr) => pr.number),
    [2, 3],
  );
});

test('fetchPullRequests warns when a search has more results than GitHub returns', async () => {
  const { deps } = fakeDeps({ search: () => [pullRequest(1)], searchCount: 1001 });

  const result = await fetchPullRequests(range, config, deps);

  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings[0], /1001.*1000/);
});

test('renderReport groups PRs and commits by repo and says what happened to each PR', () => {
  const other = { ...listed(7), repo: 'me/home', title: 'docs [draft]' };
  const text = renderReport({
    opened: [listed(1), listed(2)],
    merged: [listed(1)],
    reviewed: [other],
    commits: [
      { repo: 'perfect-corp/one', headline: 'feat: add `x`', url: 'https://github.test/commit/a1' },
    ],
  });

  assert.equal(
    text,
    [
      '開啟 2 個 PR、合併 1 個、review 1 個、commit 1 個',
      '',
      '## me/home',
      '',
      '- [#7](https://github.test/pull/7) docs \\[draft\\] — review',
      '',
      '## perfect-corp/one',
      '',
      '- [#1](https://github.test/pull/1) title 1 — 開啟、合併',
      '- [#2](https://github.test/pull/2) title 2 — 開啟',
      '',
      'Commit：',
      '',
      '- [feat: add \\`x\\`](https://github.test/commit/a1)',
    ].join('\n'),
  );
});

test('renderReport says 無活動 when nothing happened', () => {
  assert.equal(renderReport({ opened: [], merged: [], reviewed: [], commits: [] }), '無活動');
});

function runDeps(github: FakeGithub = {}) {
  process.env.OUTPUT_DIR = mkdtempSync(join(tmpdir(), 'daily-report-'));
  const published: { alias: string; markdown: string }[] = [];
  const publish = (async (alias: string, markdown: string) => {
    published.push({ alias, markdown });
    return { url: `https://codimd.test/${alias}`, status: 'written' };
  }) as never;
  return { published, deps: { ...fakeDeps(github).deps, publish } };
}
const oneCommit = {
  orgRepos: {
    'perfect-corp/broken': [],
    'perfect-corp/one': [{ id: 'b1', tip: inRange, commits: [{ oid: 'a1' }] }],
  },
  failing: ['perfect-corp/broken'],
};

test('run publishes the note as radar-daily-<date> with the range in the title and failed repos on top', async () => {
  const { deps, published } = runDeps(oneCommit);

  const result = await run({ date: '2026-11-16', range, upload: true, config }, deps);

  assert.deepEqual(result, {
    url: 'https://codimd.test/radar-daily-2026-11-16',
    warnings: ['commits perfect-corp/broken: boom'],
  });
  assert.equal(published[0].alias, 'radar-daily-2026-11-16');
  assert.match(published[0].markdown, /^# 個人日報 2026-11-16（2026-11-13 至 2026-11-15）\n/);
  assert.match(published[0].markdown, /> ⚠️ commits perfect-corp\/broken: boom/);
  assert.match(published[0].markdown, /\[commit a1\]/);
});

test('run without upload writes the note file and publishes nothing', async () => {
  const { deps, published } = runDeps();

  const result = await run(
    { date: '2026-11-17', range: reportRange('2026-11-17'), upload: false, config },
    deps,
  );

  assert.deepEqual(result, { url: null, warnings: [] });
  assert.equal(published.length, 0);
  const file = readFileSync(join(process.env.OUTPUT_DIR as string, 'daily/2026-11-17.md'), 'utf8');
  assert.match(file, /^# 個人日報 2026-11-17（2026-11-16）\n\n無活動/);
});
