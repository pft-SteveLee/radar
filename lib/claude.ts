import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

export const MODELS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
} as const;

// USD per million tokens. Cache writes (5 minute TTL) cost 1.25x the input price.
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  [MODELS.haiku]: { input: 0.1, output: 0.5, cacheRead: 0.01 },
  [MODELS.sonnet]: { input: 2, output: 10, cacheRead: 0.2 },
  [MODELS.opus]: { input: 4, output: 20, cacheRead: 0.2 },
  [MODELS.fable]: { input: 10, output: 50, cacheRead: 0.25 },
};

interface CallOptions {
  job: string;
  model: string;
  system: string;
  user: string;
  schema?: Record<string, unknown>;
}

interface CostLine {
  ts: string;
  job: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

const costLogPath = () => join(process.env.OUTPUT_DIR ?? 'output', 'cost.jsonl');

export async function call(
  { job, model, system, user, schema }: CallOptions,
  client: Anthropic = new Anthropic({ maxRetries: 3 }),
): Promise<string | unknown> {
  const price = PRICES[model];
  if (!price) throw new Error(`No price known for model ${model}`);

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    ...(schema && { output_config: { format: { type: 'json_schema', schema } } }),
  });

  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
    response.usage;
  const cacheRead = cache_read_input_tokens ?? 0;
  const cacheWrite = cache_creation_input_tokens ?? 0;
  const usd =
    (input_tokens * price.input +
      output_tokens * price.output +
      cacheRead * price.cacheRead +
      cacheWrite * price.input * 1.25) /
    1_000_000;
  const line: CostLine = {
    ts: new Date().toISOString(),
    job,
    model,
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    cacheRead,
    cacheWrite,
    usd,
  };
  mkdirSync(join(costLogPath(), '..'), { recursive: true });
  appendFileSync(costLogPath(), `${JSON.stringify(line)}\n`);

  const text = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
  return schema ? JSON.parse(text) : text;
}

export function runCost(job: string, sinceTimestamp: string): number {
  let log: string;
  try {
    log = readFileSync(costLogPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CostLine)
    .filter((line) => line.job === job && line.ts >= sinceTimestamp)
    .reduce((total, line) => total + line.usd, 0);
}
