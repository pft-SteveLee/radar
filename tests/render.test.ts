import assert from 'node:assert/strict';
import { test } from 'node:test';
import { note } from '../lib/render.ts';

test('note puts the title first, the body next and the cost last', () => {
  const text = note({
    title: '[Reddit 摘要] 2026-11-04',
    body: '內文',
    warnings: [],
    costUsd: 0.0312,
  });
  assert.equal(text, '# [Reddit 摘要] 2026-11-04\n\n內文\n\n本次花費 $0.03\n');
});

test('note shows every warning as a quoted block right after the title', () => {
  const text = note({
    title: 'T',
    body: 'B',
    warnings: ['feed A 失敗', 'feed B 失敗'],
    costUsd: 0,
  });
  assert.equal(text, '# T\n\n> ⚠️ feed A 失敗\n> ⚠️ feed B 失敗\n\nB\n\n本次花費 $0.00\n');
});
