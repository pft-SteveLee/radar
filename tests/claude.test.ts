import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { call, MODELS, runCost } from '../lib/claude.ts';

interface FakeRequest {
  model: string;
  system: { type: string; text: string; cache_control?: { type: string } }[];
  output_config?: { format: { type: string; schema: object } };
}

let outputDir: string;
let requests: FakeRequest[];

const fakeClient = (text: string) =>
  ({
    messages: {
      create: async (request: FakeRequest) => {
        requests.push(request);
        return {
          content: [{ type: 'text', text }],
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 0,
          },
        };
      },
    },
  }) as never;

const costLines = () =>
  readFileSync(join(outputDir, 'cost.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), 'radar-output-'));
  process.env.OUTPUT_DIR = outputDir;
  requests = [];
});

test('call returns the text, caches the system prompt and logs the cost of the call', async () => {
  const text = await call(
    { job: 'reddit', model: MODELS.sonnet, system: 'S', user: 'U' },
    fakeClient('hello'),
  );

  assert.equal(text, 'hello');
  assert.deepEqual(requests[0].system, [
    { type: 'text', text: 'S', cache_control: { type: 'ephemeral' } },
  ]);
  const [line] = costLines();
  assert.equal(line.job, 'reddit');
  assert.equal(line.model, 'claude-sonnet-5-5');
  assert.equal(line.inputTokens, 1000);
  assert.equal(line.outputTokens, 500);
  assert.equal(line.cacheRead, 2000);
  assert.ok(Math.abs(line.usd - 0.0074) < 1e-9);
});

test('call with a schema sends it as the output format and returns the parsed JSON', async () => {
  const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
  const result = await call(
    { job: 'reddit', model: MODELS.haiku, system: 'S', user: 'U', schema },
    fakeClient('{"a":1}'),
  );

  assert.deepEqual(result, { a: 1 });
  assert.deepEqual(requests[0].output_config, { format: { type: 'json_schema', schema } });
});

test('call throws when the schema response is not valid JSON', async () => {
  await assert.rejects(
    call(
      { job: 'reddit', model: MODELS.haiku, system: 'S', user: 'U', schema: { type: 'object' } },
      fakeClient('not json'),
    ),
    SyntaxError,
  );
});

test('runCost sums only the calls of that job logged at or after the given time', async () => {
  const client = fakeClient('x');
  await call({ job: 'a', model: MODELS.sonnet, system: 'S', user: 'U' }, client);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const since = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await call({ job: 'a', model: MODELS.sonnet, system: 'S', user: 'U' }, client);
  await call({ job: 'b', model: MODELS.sonnet, system: 'S', user: 'U' }, client);

  assert.ok(Math.abs(runCost('a', since) - 0.0074) < 1e-9);
});
