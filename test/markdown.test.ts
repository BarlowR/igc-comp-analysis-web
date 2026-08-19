/**
 * Tests for src/lib/markdown.ts — the parts that run without a DOM.
 * renderMarkdown builds real DOM nodes and is exercised in the browser; its
 * safety property (no innerHTML anywhere) is structural. node --test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownTitle } from '../src/lib/markdown.ts';

test('markdownTitle: first heading wins, hashes stripped', () => {
  assert.equal(markdownTitle('# Day 3 debrief\n\nbody'), 'Day 3 debrief');
  assert.equal(markdownTitle('### deep heading first'), 'deep heading first');
});

test('markdownTitle: no heading falls back to the first non-empty line', () => {
  assert.equal(markdownTitle('\n\nplain first line\nmore'), 'plain first line');
});

test('markdownTitle: empty body gets a placeholder, long titles clip', () => {
  assert.equal(markdownTitle('\n \n'), 'Untitled note');
  assert.equal(markdownTitle(`# ${'x'.repeat(300)}`).length, 120);
});
