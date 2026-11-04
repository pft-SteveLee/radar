import { createPatch } from 'diff';

export interface SourceConfig {
  id: string;
  kind: 'githubReleases' | 'markdown' | 'githubFile' | 'githubSkills';
  repo?: string;
  path?: string;
  url?: string;
}

export interface ChangeItem {
  source: string;
  title: string;
  url: string;
  version?: string;
  text: string;
}

export interface CollectResult {
  items: ChangeItem[];
  baseline: boolean;
  nextState: unknown;
}

export interface SourceDeps {
  fetch: typeof fetch;
  now: () => Date;
  token: string;
}

interface ReleaseState {
  lastPublishedAt: string;
}

interface TextState {
  text: string;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  body: string | null;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
}

const FIRST_RUN_DAYS = 7;
const DAY_MS = 86_400_000;
const DIFF_CONTEXT_LINES = 20;
const API = 'https://api.github.com';

const githubHeaders = (token: string, accept: string) => ({
  Accept: accept,
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
});

async function getText(
  source: SourceConfig,
  url: string,
  headers: Record<string, string>,
  deps: SourceDeps,
): Promise<string> {
  const response = await deps.fetch(url, { headers });
  if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
  return response.text();
}

export const normalizeText = (text: string): string =>
  `${text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd()}\n`;

export function textChange(
  source: SourceConfig,
  url: string,
  title: string,
  previous: TextState | null,
  text: string,
): CollectResult {
  const nextState: TextState = { text };
  if (!previous) return { items: [], baseline: true, nextState };
  const before = normalizeText(previous.text);
  const after = normalizeText(text);
  if (before === after) return { items: [], baseline: false, nextState };
  const patch = createPatch(source.id, before, after, '', '', { context: DIFF_CONTEXT_LINES });
  return { items: [{ source: source.id, title, url, text: patch }], baseline: false, nextState };
}

async function collectReleases(
  source: SourceConfig,
  previous: ReleaseState | null,
  deps: SourceDeps,
): Promise<CollectResult> {
  const body = await getText(
    source,
    `${API}/repos/${source.repo}/releases?per_page=30`,
    githubHeaders(deps.token, 'application/vnd.github+json'),
    deps,
  );
  const cutoff =
    previous?.lastPublishedAt ??
    new Date(deps.now().getTime() - FIRST_RUN_DAYS * DAY_MS).toISOString();
  const fresh = (JSON.parse(body) as GithubRelease[])
    .filter((release) => !release.draft && !release.prerelease && release.published_at > cutoff)
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
  return {
    items: fresh.map((release) => ({
      source: source.id,
      title: `${source.repo} ${release.tag_name}`,
      url: release.html_url,
      version: release.tag_name,
      text: release.body ?? '',
    })),
    baseline: false,
    nextState: { lastPublishedAt: fresh[0]?.published_at ?? previous?.lastPublishedAt ?? cutoff },
  };
}

interface SkillFile {
  sha: string;
  text: string;
}

interface SkillsState {
  files: Record<string, SkillFile>;
}

interface GithubTree {
  truncated: boolean;
  tree: { path: string; type: string; sha: string }[];
}

const SKILL_PATH = /^skills\/([^/]+)\/SKILL\.md$/;

async function collectSkills(
  source: SourceConfig,
  previous: SkillsState | null,
  deps: SourceDeps,
): Promise<CollectResult> {
  const tree = JSON.parse(
    await getText(
      source,
      `${API}/repos/${source.repo}/git/trees/HEAD?recursive=1`,
      githubHeaders(deps.token, 'application/vnd.github+json'),
      deps,
    ),
  ) as GithubTree;
  if (tree.truncated) throw new Error(`${source.id}: file tree is truncated`);

  const files: Record<string, SkillFile> = {};
  const items: ChangeItem[] = [];
  const urlOf = (path: string) => `https://github.com/${source.repo}/blob/HEAD/${path}`;
  for (const entry of tree.tree) {
    const name = SKILL_PATH.exec(entry.path)?.[1];
    if (entry.type !== 'blob' || !name) continue;
    const known = previous?.files[entry.path];
    if (known?.sha === entry.sha) {
      files[entry.path] = known;
      continue;
    }
    const text = await getText(
      source,
      `${API}/repos/${source.repo}/contents/${entry.path}`,
      githubHeaders(deps.token, 'application/vnd.github.raw+json'),
      deps,
    );
    files[entry.path] = { sha: entry.sha, text };
    if (!previous) continue;
    const title = `${source.repo} skill ${name}`;
    if (!known) {
      items.push({ source: source.id, title, url: urlOf(entry.path), text });
    } else {
      items.push(...textChange(source, urlOf(entry.path), title, known, text).items);
    }
  }
  for (const path of Object.keys(previous?.files ?? {})) {
    if (files[path]) continue;
    const name = SKILL_PATH.exec(path)?.[1];
    items.push({
      source: source.id,
      title: `${source.repo} skill ${name}`,
      url: urlOf(path),
      text: `Skill ${name} was removed from ${source.repo}.`,
    });
  }
  return { items, baseline: !previous, nextState: { files } };
}

export async function collectSource(
  source: SourceConfig,
  previousState: unknown | null,
  deps: SourceDeps,
): Promise<CollectResult> {
  switch (source.kind) {
    case 'githubReleases':
      return collectReleases(source, previousState as ReleaseState | null, deps);
    case 'markdown': {
      const url = source.url as string;
      const text = await getText(source, url, {}, deps);
      return textChange(source, url, source.id, previousState as TextState | null, text);
    }
    case 'githubFile': {
      const text = await getText(
        source,
        `${API}/repos/${source.repo}/contents/${source.path}`,
        githubHeaders(deps.token, 'application/vnd.github.raw+json'),
        deps,
      );
      const url = `https://github.com/${source.repo}/blob/HEAD/${source.path}`;
      return textChange(
        source,
        url,
        `${source.repo} ${source.path}`,
        previousState as TextState | null,
        text,
      );
    }
    case 'githubSkills':
      return collectSkills(source, previousState as SkillsState | null, deps);
  }
}
