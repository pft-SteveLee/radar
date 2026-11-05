export interface MergedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  mergedAt: string;
  author: string;
}

export interface OpenPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  body: string;
  headRefName: string;
  author: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OpenIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export const OPUS_MAX_PRS = 10;
export const DIFF_MAX_CHARS = 30_000;
const MIN_DESCRIPTION_WORDS = 50;
const MIN_LARGE_LINES = 100;
const STUCK_PR_DAYS = 3;
const STALE_DRAFT_DAYS = 14;
const STALE_ISSUE_DAYS = 14;
const DAY_MS = 86_400_000;

const GENERATED_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const GENERATED_DIRECTORIES = new Set(['dist', 'build', '__snapshots__']);

export const shortRepo = (repo: string) => repo.split('/').at(-1) as string;

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const changedLines = (pr: MergedPr) => pr.additions + pr.deletions;

export function isUndescribedLarge(pr: MergedPr): boolean {
  return wordCount(pr.body) < MIN_DESCRIPTION_WORDS && changedLines(pr) > MIN_LARGE_LINES;
}

export function selectForOpus(merged: MergedPr[]): { selected: MergedPr[]; skipped: MergedPr[] } {
  const eligible = merged
    .filter(isUndescribedLarge)
    .sort((a, b) => changedLines(b) - changedLines(a));
  return { selected: eligible.slice(0, OPUS_MAX_PRS), skipped: eligible.slice(OPUS_MAX_PRS) };
}

function isGenerated(path: string): boolean {
  const segments = path.split('/');
  return (
    GENERATED_FILES.has(segments.at(-1) as string) ||
    /\.min\.(js|css)$/.test(path) ||
    segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment))
  );
}

export function trimDiff(diff: string): { text: string; truncated: boolean } {
  const kept = diff
    .split(/^(?=diff --git )/m)
    .filter((section) => {
      const path = /^diff --git a\/.+ b\/(.+)$/m.exec(section)?.[1];
      return !path || !isGenerated(path);
    })
    .join('');
  return { text: kept.slice(0, DIFF_MAX_CHARS), truncated: kept.length > DIFF_MAX_CHARS };
}

const olderThan = (timestamp: string, days: number, now: Date) =>
  now.getTime() - new Date(timestamp).getTime() > days * DAY_MS;
const wholeDays = (timestamp: string, now: Date) =>
  Math.floor((now.getTime() - new Date(timestamp).getTime()) / DAY_MS);

export function stuckPrs(openPrs: OpenPr[], now: Date): { pr: OpenPr; days: number }[] {
  return openPrs
    .filter((pr) => !pr.isDraft && olderThan(pr.createdAt, STUCK_PR_DAYS, now))
    .map((pr) => ({ pr, days: wholeDays(pr.createdAt, now) }));
}

export function staleDrafts(openPrs: OpenPr[], now: Date): { pr: OpenPr; days: number }[] {
  return openPrs
    .filter((pr) => pr.isDraft && olderThan(pr.updatedAt, STALE_DRAFT_DAYS, now))
    .map((pr) => ({ pr, days: wholeDays(pr.updatedAt, now) }));
}

export function referencedIssues(
  prs: { repo: string; title: string; body: string; headRefName: string }[],
): Set<string> {
  const keys = new Set<string>();
  for (const pr of prs)
    for (const text of [pr.title, pr.body, pr.headRefName])
      for (const [, repo, number] of text.matchAll(/([\w.-]+\/[\w.-]+)?#(\d+)/g))
        keys.add(`${repo ?? pr.repo}#${number}`);
  return keys;
}

export function staleIssues(
  issues: OpenIssue[],
  referenced: Set<string>,
  now: Date,
): { issue: OpenIssue; days: number }[] {
  return issues
    .filter(
      (issue) =>
        olderThan(issue.updatedAt, STALE_ISSUE_DAYS, now) &&
        !referenced.has(`${issue.repo}#${issue.number}`),
    )
    .map((issue) => ({ issue, days: wholeDays(issue.updatedAt, now) }));
}
