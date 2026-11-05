import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectRepo, fetchDiff, type GithubDeps } from '../jobs/devWeeklyGithub.ts';

interface Page {
  nodes: object[];
  hasNextPage?: boolean;
  endCursor?: string | null;
  issueCount?: number;
}

const page = ({ nodes, hasNextPage = false, endCursor = null, issueCount }: Page) =>
  new Response(
    JSON.stringify({
      data: {
        search: {
          issueCount: issueCount ?? nodes.length,
          pageInfo: { hasNextPage, endCursor },
          nodes,
        },
      },
    }),
    { status: 200 },
  );

const prNode = (number: number, overrides: object = {}) => ({
  number,
  title: `pr ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  body: 'body',
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  headRefName: 'feature/x',
  baseRefName: 'amp/master',
  isDraft: false,
  createdAt: '2026-11-02T01:00:00Z',
  updatedAt: '2026-11-03T01:00:00Z',
  mergedAt: '2026-11-03T02:00:00Z',
  author: { login: 'alice' },
  ...overrides,
});

const issueNode = (number: number) => ({
  number,
  title: `issue ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  author: { login: 'carol' },
});

type Queue = Record<'merged' | 'openPrs' | 'issues', (() => Response)[]>;

function fakeDeps(queue: Partial<Queue>) {
  const requests: { query: string; variables: { q: string; endCursor?: string | null } }[] = [];
  const sleeps: number[] = [];
  const kindOf = (q: string): keyof Queue =>
    q.includes('is:merged') ? 'merged' : q.includes('is:issue') ? 'issues' : 'openPrs';
  const deps: GithubDeps = {
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      requests.push(body);
      const next = queue[kindOf(body.variables.q)]?.shift();
      return next ? next() : page({ nodes: [] });
    }) as typeof fetch,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  };
  return { deps, requests, sleeps };
}

test('collectRepo follows pages, passing the previous endCursor, and tags every PR with the full repo name', async () => {
  const { deps, requests } = fakeDeps({
    merged: [
      () => page({ nodes: [prNode(1)], hasNextPage: true, endCursor: 'CUR1' }),
      () => page({ nodes: [prNode(2)] }),
    ],
  });
  const data = await collectRepo('o/r', '2026-W44', 'token', deps);
  assert.deepEqual(
    data.merged.map((pr) => [pr.repo, pr.number, pr.author]),
    [
      ['o/r', 1, 'alice'],
      ['o/r', 2, 'alice'],
    ],
  );
  const mergedRequests = requests.filter((request) => request.variables.q.includes('is:merged'));
  assert.equal(mergedRequests[0].variables.endCursor ?? null, null);
  assert.equal(mergedRequests[1].variables.endCursor, 'CUR1');
  assert.match(
    mergedRequests[0].variables.q,
    /repo:o\/r is:pr is:merged merged:2026-10-26T00:00:00\+08:00\.\.2026-11-01T23:59:59\+08:00/,
  );
  assert.match(mergedRequests[0].query, /\$endCursor/);
});

test('collectRepo returns open PRs and open issues too', async () => {
  const { deps } = fakeDeps({
    openPrs: [() => page({ nodes: [prNode(5, { isDraft: true })] })],
    issues: [() => page({ nodes: [issueNode(9)] })],
  });
  const data = await collectRepo('o/r', '2026-W44', 'token', deps);
  assert.equal(data.openPrs[0].isDraft, true);
  assert.equal(data.openPrs[0].number, 5);
  assert.deepEqual([data.openIssues[0].repo, data.openIssues[0].number], ['o/r', 9]);
});

test('collectRepo shows a deleted author account as ghost', async () => {
  const { deps } = fakeDeps({ merged: [() => page({ nodes: [prNode(1, { author: null })] })] });
  const data = await collectRepo('o/r', '2026-W44', 'token', deps);
  assert.equal(data.merged[0].author, 'ghost');
});

test('collectRepo warns with the repo name when a search has more than 1000 results', async () => {
  const { deps } = fakeDeps({ merged: [() => page({ nodes: [prNode(1)], issueCount: 1001 })] });
  const data = await collectRepo('o/r', '2026-W44', 'token', deps);
  assert.equal(data.warnings.length, 1);
  assert.match(data.warnings[0], /o\/r/);
  assert.match(data.warnings[0], /1000/);
});

test('collectRepo throws naming the repo when GraphQL answers 200 with errors', async () => {
  const { deps } = fakeDeps({
    merged: [
      () =>
        new Response(
          JSON.stringify({ errors: [{ message: 'Could not resolve to a Repository' }] }),
          {
            status: 200,
          },
        ),
    ],
  });
  await assert.rejects(collectRepo('o/r', '2026-W44', 'token', deps), /o\/r.*Could not resolve/);
});

test('collectRepo waits for the rate limit reset and retries', async () => {
  const resetSeconds = Math.floor(Date.now() / 1000) + 30;
  const { deps, sleeps } = fakeDeps({
    merged: [
      () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) },
        }),
      () => page({ nodes: [prNode(1)] }),
    ],
  });
  const data = await collectRepo('o/r', '2026-W44', 'token', deps);
  assert.equal(data.merged.length, 1);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 25_000 && sleeps[0] < 35_000);
});

test('fetchDiff asks for the diff media type and returns the text', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const deps: GithubDeps = {
    fetch: (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return new Response('diff --git a/x b/x\n', { status: 200 });
    }) as typeof fetch,
    sleep: async () => {},
  };
  const diff = await fetchDiff({ repo: 'o/r', number: 7 }, 'token', deps);
  assert.equal(diff, 'diff --git a/x b/x\n');
  assert.equal(seen[0].url, 'https://api.github.com/repos/o/r/pulls/7');
  assert.equal(seen[0].headers.Accept, 'application/vnd.github.diff');
  assert.equal(seen[0].headers.Authorization, 'Bearer token');
});

test('every search also looks the repository up, so a repo the token cannot see is an error and not an empty week', async () => {
  const { deps, requests } = fakeDeps({});
  await collectRepo('o/r', '2026-W45', 'token', deps);
  assert.ok(requests.length >= 3);
  for (const request of requests) {
    assert.match(request.query, /repository\(owner: \$owner, name: \$name\)/);
    const variables = request.variables as Record<string, unknown>;
    assert.deepEqual([variables.owner, variables.name], ['o', 'r']);
  }
});
