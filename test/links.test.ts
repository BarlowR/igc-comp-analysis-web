/**
 * The deep-link contract (src/lib/links.ts): every hash the builders write
 * must be one the matching parser reads back. node --test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotationUrl,
  archiveCompUrl,
  notebookUrl,
  notesPanelUrl,
  parseAnnotationHash,
  parseCompHash,
  parseNoteAnchor,
  savedCompUrl,
  taskUrls,
  wantsNotesDock,
} from '../src/lib/links.ts';

const hashOf = (url: string): string => url.slice(url.indexOf('#'));

test('comp links round-trip through parseCompHash, on / and /saved', () => {
  assert.equal(parseCompHash(hashOf(archiveCompUrl('chelan2026'))), 'chelan2026');
  assert.equal(parseCompHash(hashOf(savedCompUrl('0b9e-uuid'))), '0b9e-uuid');
  // The archive index reads location.hash, which the browser may deliver
  // percent-encoded.
  assert.equal(parseCompHash('#c/comp%20name'), 'comp name');
  assert.equal(parseCompHash('#free'), null);
});

test('annotation links round-trip, archived and saved, id encoded', () => {
  const archived = annotationUrl('chelan2026', 'day1', 'note/1');
  assert.equal(archived.startsWith('/archive/chelan2026/day1/3d#'), true);
  assert.equal(parseAnnotationHash(hashOf(archived)), 'note/1');

  const saved = annotationUrl('saved', 'task-uuid', 'n1');
  assert.equal(saved.startsWith('/saved/3d?id=task-uuid#'), true);
  assert.equal(parseAnnotationHash(hashOf(saved)), 'n1');
});

test('taskUrls: saved comps are query-addressed, archive comps are paths', () => {
  assert.deepEqual(taskUrls('saved', 'abc'), { base: '/saved?id=abc', threeD: '/saved/3d?id=abc' });
  assert.deepEqual(taskUrls('c', 'd'), { base: '/archive/c/d', threeD: '/archive/c/d/3d' });
});

test('notebook note anchors round-trip through parseNoteAnchor', () => {
  assert.equal(parseNoteAnchor(hashOf(notebookUrl('nb', 'note-id'))), 'note-id');
  assert.equal(parseNoteAnchor('#notes'), null);
});

test('wantsNotesDock: panel and single-annotation links open the dock', () => {
  assert.equal(wantsNotesDock(hashOf(notesPanelUrl('c', 'd'))), true);
  assert.equal(wantsNotesDock(hashOf(annotationUrl('c', 'd', 'n'))), true);
  assert.equal(wantsNotesDock('#c/chelan2026'), false);
  assert.equal(wantsNotesDock(''), false);
});
