interface NoteInput {
  title: string;
  body: string;
  warnings: string[];
  costUsd: number;
}

export function note({ title, body, warnings, costUsd }: NoteInput): string {
  const warningBlock = warnings.length ? `${warnings.map((w) => `> ⚠️ ${w}`).join('\n')}\n\n` : '';
  return `# ${title}\n\n${warningBlock}${body}\n\n本次花費 $${costUsd.toFixed(2)}\n`;
}
