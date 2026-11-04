import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectSource, type SourceConfig, type SourceDeps } from '../jobs/changelogSources.ts';

const NOW = new Date('2026-11-04T02:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

interface Request {
  url: string;
  headers: Record<string, string>;
}

function makeDeps(respond: (url: string) => Response) {
  const requests: Request[] = [];
  const deps: SourceDeps = {
    fetch: (async (url: string, init?: { headers?: Record<string, string> }) => {
      requests.push({ url, headers: init?.headers ?? {} });
      return respond(url);
    }) as unknown as typeof fetch,
    now: () => NOW,
    token: 'secret-token',
  };
  return { deps, requests };
}

const release = (tag: string, publishedAt: string, extra: object = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/acme/tool/releases/tag/${tag}`,
  body: `notes of ${tag}`,
  published_at: publishedAt,
  draft: false,
  prerelease: false,
  ...extra,
});

const json = (value: unknown) => new Response(JSON.stringify(value));

const releasesSource: SourceConfig = { id: 'tool', kind: 'githubReleases', repo: 'acme/tool' };
const markdownSource: SourceConfig = {
  id: 'docs',
  kind: 'markdown',
  url: 'https://docs.test/a.md',
};
const fileSource: SourceConfig = {
  id: 'market',
  kind: 'githubFile',
  repo: 'acme/market',
  path: '.claude-plugin/marketplace.json',
};

test('githubReleases, no state: returns releases of the last 7 days as items', async () => {
  const { deps } = makeDeps(() =>
    json([release('v3', daysAgo(1)), release('v2', daysAgo(3)), release('v1', daysAgo(10))]),
  );
  const result = await collectSource(releasesSource, null, deps);
  assert.equal(result.baseline, false);
  assert.deepEqual(
    result.items.map((item) => item.version),
    ['v3', 'v2'],
  );
  assert.equal(result.items[0].url, 'https://github.com/acme/tool/releases/tag/v3');
  assert.equal(result.items[0].text, 'notes of v3');
  assert.equal(result.items[0].source, 'tool');
  assert.deepEqual(result.nextState, { lastPublishedAt: daysAgo(1) });
});

test('githubReleases with state: returns only newer releases, ignores drafts and prereleases', async () => {
  const { deps } = makeDeps(() =>
    json([
      release('v5', daysAgo(0.5), { draft: true }),
      release('v4', daysAgo(0.6), { prerelease: true }),
      release('v3', daysAgo(1)),
      release('v2', daysAgo(3)),
    ]),
  );
  const result = await collectSource(releasesSource, { lastPublishedAt: daysAgo(2) }, deps);
  assert.deepEqual(
    result.items.map((item) => item.version),
    ['v3'],
  );
  assert.deepEqual(result.nextState, { lastPublishedAt: daysAgo(1) });
});

test('githubReleases with state and nothing newer: state stays the same', async () => {
  const { deps } = makeDeps(() => json([release('v2', daysAgo(3))]));
  const result = await collectSource(releasesSource, { lastPublishedAt: daysAgo(2) }, deps);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.nextState, { lastPublishedAt: daysAgo(2) });
});

test('markdown, no state: baseline, no items, state holds the text', async () => {
  const { deps } = makeDeps(() => new Response('# Notes\n\nline one\n'));
  const result = await collectSource(markdownSource, null, deps);
  assert.equal(result.baseline, true);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.nextState, { text: '# Notes\n\nline one\n' });
});

test('markdown with a change: one item whose text is a unified diff containing the added line', async () => {
  const { deps } = makeDeps(() => new Response('# Notes\n\nline one\nline two\n'));
  const result = await collectSource(markdownSource, { text: '# Notes\n\nline one\n' }, deps);
  assert.equal(result.baseline, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source, 'docs');
  assert.equal(result.items[0].url, 'https://docs.test/a.md');
  assert.match(result.items[0].text, /^\+line two$/m);
  assert.deepEqual(result.nextState, { text: '# Notes\n\nline one\nline two\n' });
});

test('markdown with only trailing whitespace changed: no item', async () => {
  const { deps } = makeDeps(() => new Response('# Notes  \n\nline one   \n\n\n'));
  const result = await collectSource(markdownSource, { text: '# Notes\n\nline one\n' }, deps);
  assert.deepEqual(result.items, []);
});

test('githubFile uses the contents API with the raw Accept header and the token', async () => {
  const { deps, requests } = makeDeps(() => new Response('{"plugins":[]}'));
  await collectSource(fileSource, null, deps);
  assert.equal(
    requests[0].url,
    'https://api.github.com/repos/acme/market/contents/.claude-plugin/marketplace.json',
  );
  assert.equal(requests[0].headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(requests[0].headers.Authorization, 'Bearer secret-token');
});

test('githubFile, no state: baseline', async () => {
  const { deps } = makeDeps(() => new Response('{"plugins":[]}'));
  const result = await collectSource(fileSource, null, deps);
  assert.equal(result.baseline, true);
  assert.deepEqual(result.items, []);
});

for (const [source, status] of [
  [releasesSource, 403],
  [markdownSource, 404],
  [fileSource, 502],
] as const) {
  test(`${source.kind}: non-200 response throws an error naming the source id and status`, async () => {
    const { deps } = makeDeps(() => new Response('nope', { status }));
    await assert.rejects(
      collectSource(source, source.kind === 'githubReleases' ? null : { text: 'old' }, deps),
      new Error(`${source.id}: HTTP ${status}`),
    );
  });
}

const skillsSource: SourceConfig = { id: 'skills', kind: 'githubSkills', repo: 'acme/skills' };

const skillsRepo =
  (files: Record<string, { sha: string; text: string }>, truncated = false) =>
  (url: string) => {
    if (url.includes('/git/trees/')) {
      return json({
        truncated,
        tree: [
          { path: 'README.md', type: 'blob', sha: 'readme' },
          { path: 'skills/pdf', type: 'tree', sha: 'dir' },
          ...Object.entries(files).map(([path, { sha }]) => ({ path, type: 'blob', sha })),
        ],
      });
    }
    return new Response(files[url.split('/contents/')[1]].text);
  };

const pdfFile = { sha: 'a1', text: 'pdf skill\n' };
const docxFile = { sha: 'b1', text: 'docx skill\n' };

test('githubSkills, no state: baseline, state lists every SKILL.md with sha and text', async () => {
  const { deps } = makeDeps(
    skillsRepo({ 'skills/pdf/SKILL.md': pdfFile, 'skills/docx/SKILL.md': docxFile }),
  );
  const result = await collectSource(skillsSource, null, deps);
  assert.equal(result.baseline, true);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.nextState, {
    files: { 'skills/pdf/SKILL.md': pdfFile, 'skills/docx/SKILL.md': docxFile },
  });
});

test('githubSkills, new folder: item with the full SKILL.md as text and a title naming the skill', async () => {
  const { deps } = makeDeps(
    skillsRepo({ 'skills/pdf/SKILL.md': pdfFile, 'skills/docx/SKILL.md': docxFile }),
  );
  const result = await collectSource(
    skillsSource,
    { files: { 'skills/pdf/SKILL.md': pdfFile } },
    deps,
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].text, 'docx skill\n');
  assert.match(result.items[0].title, /docx/);
  assert.equal(
    result.items[0].url,
    'https://github.com/acme/skills/blob/HEAD/skills/docx/SKILL.md',
  );
});

test('githubSkills, changed sha: item with a unified diff; unchanged sha: no fetch of that file', async () => {
  const changed = { sha: 'a2', text: 'pdf skill\nnew line\n' };
  const { deps, requests } = makeDeps(
    skillsRepo({ 'skills/pdf/SKILL.md': changed, 'skills/docx/SKILL.md': docxFile }),
  );
  const result = await collectSource(
    skillsSource,
    { files: { 'skills/pdf/SKILL.md': pdfFile, 'skills/docx/SKILL.md': docxFile } },
    deps,
  );
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].text, /^\+new line$/m);
  assert.equal(requests.filter((request) => request.url.includes('docx')).length, 0);
  assert.deepEqual(result.nextState, {
    files: { 'skills/pdf/SKILL.md': changed, 'skills/docx/SKILL.md': docxFile },
  });
});

test('githubSkills, deleted skill folder: item says the skill was removed and it leaves the state', async () => {
  const { deps } = makeDeps(skillsRepo({ 'skills/pdf/SKILL.md': pdfFile }));
  const result = await collectSource(
    skillsSource,
    { files: { 'skills/pdf/SKILL.md': pdfFile, 'skills/docx/SKILL.md': docxFile } },
    deps,
  );
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].text, /docx.*removed/);
  assert.deepEqual(result.nextState, { files: { 'skills/pdf/SKILL.md': pdfFile } });
});

test('githubSkills, truncated tree: throws instead of reporting skills as removed', async () => {
  const { deps } = makeDeps(skillsRepo({ 'skills/pdf/SKILL.md': pdfFile }, true));
  await assert.rejects(
    collectSource(skillsSource, { files: { 'skills/pdf/SKILL.md': pdfFile } }, deps),
    new Error('skills: file tree is truncated'),
  );
});

test('githubSkills: non-200 response throws an error naming the source id and status', async () => {
  const { deps } = makeDeps(() => new Response('nope', { status: 403 }));
  await assert.rejects(collectSource(skillsSource, null, deps), new Error('skills: HTTP 403'));
});
