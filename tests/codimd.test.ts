import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../lib/codimd.ts';

test('decide says unchanged when the note already holds the content', () => {
  assert.equal(decide('old', 'new', 'new'), 'unchanged');
});

test('decide says write when the note still equals what was last pushed', () => {
  assert.equal(decide('old', 'old', 'new'), 'write');
});

test('decide says editedOnWeb when the note differs from what was last pushed', () => {
  assert.equal(decide('old', 'changed on the web', 'new'), 'editedOnWeb');
});

test('decide writes into an empty note that was never pushed', () => {
  assert.equal(decide(null, '', 'new'), 'write');
});

test('decide refuses to overwrite a note with content that was never pushed by this program', () => {
  assert.equal(decide(null, 'someone wrote this', 'new'), 'editedOnWeb');
});
