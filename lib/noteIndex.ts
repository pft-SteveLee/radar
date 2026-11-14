import type { publish } from './codimd.ts';
import { type RunRecord, type RunResult, readRuns } from './runLog.ts';

const ALIAS = 'radar-index';
const MONTHS = 6;
const JOB_TITLES: Record<string, string> = {
  daily_report: '個人日報',
  reddit_digest: 'Reddit 摘要',
  changelog_watch: 'Changelog 週報',
  dev_weekly: '開發週報',
};

const taipeiDate = (timestamp: string) =>
  new Date(timestamp).toLocaleDateString('sv', { timeZone: 'Asia/Taipei' });

export function renderIndex(runs: RunRecord[]): string {
  const latestByUrl = new Map<string, RunRecord>();
  for (const run of runs) {
    if (run.status !== 'ok' || !run.url) continue;
    const known = latestByUrl.get(run.url);
    if (!known || run.startedAt > known.startedAt) latestByUrl.set(run.url, run);
  }
  const notes = [...latestByUrl.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const month = (run: RunRecord) => taipeiDate(run.startedAt).slice(0, 7);
  const [year, newestMonth] = (notes[0] ? month(notes[0]) : '0-1').split('-').map(Number);
  const oldestMonth = new Date(Date.UTC(year, newestMonth - MONTHS, 1)).toISOString().slice(0, 7);
  const byJob = Map.groupBy(
    notes.filter((run) => month(run) >= oldestMonth),
    (run) => run.job,
  );
  const sections = [...byJob.keys()].sort().map((job) => {
    const months = [...Map.groupBy(byJob.get(job) ?? [], month)].map(([name, runs]) => {
      const rows = runs.map((run) => {
        const url = run.url as string;
        return `- ${taipeiDate(run.startedAt)} [${url.split('/').at(-1)}](${url})`;
      });
      return `### ${name}\n\n${rows.join('\n')}`;
    });
    return `## ${JOB_TITLES[job] ?? job}\n\n${months.join('\n\n')}`;
  });
  return `# radar 筆記索引\n\n${sections.join('\n\n')}\n`;
}

export function withIndex(
  job: string,
  work: () => Promise<RunResult>,
  publishNote: typeof publish,
): () => Promise<RunResult> {
  return async () => {
    const result = await work();
    if (!result.url) return result;
    const startedAt = new Date().toISOString();
    const thisRun: RunRecord = {
      job,
      startedAt,
      finishedAt: startedAt,
      status: 'ok',
      error: null,
      warnings: [],
      costUsd: 0,
      url: result.url,
    };
    try {
      const markdown = renderIndex([...readRuns(Number.POSITIVE_INFINITY), thisRun]);
      const { status } = await publishNote(ALIAS, markdown);
      if (status === 'editedOnWeb')
        return {
          ...result,
          warnings: [...result.warnings, `${ALIAS} 在網頁上被改過，這次沒有更新`],
        };
      return result;
    } catch (error) {
      return {
        ...result,
        warnings: [...result.warnings, `${ALIAS} 更新失敗：${(error as Error).message}`],
      };
    }
  };
}
