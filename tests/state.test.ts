import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { load, save } from '../lib/state.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'radar-state-'));
  process.env.STATE_DIR = dir;
});

test('load returns the fallback when the file does not exist', () => {
  assert.deepEqual(load('missing', { ids: [] }), { ids: [] });
});

test('save then load round-trips nested names and creates directories', () => {
  save('reddit/raw/2026-11-04', { posts: [1, 2] });
  assert.deepEqual(load('reddit/raw/2026-11-04', null), { posts: [1, 2] });
});

test('save leaves no temporary file behind', () => {
  save('seen', { a: 1 });
  assert.deepEqual(readdirSync(dir), ['seen.json']);
});
