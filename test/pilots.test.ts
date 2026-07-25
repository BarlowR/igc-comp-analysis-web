/**
 * Unit tests for src/lib/pilots.ts — slugifyPilot folds the archive's messy
 * pilot names into one stable join key, which is what pilot_claims stores.
 * The sample names below are real ones taken from the built day JSONs.
 * node --test test/pilots.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPilotLabel, slugifyPilot } from '../src/lib/pilots.ts';

test('slugifyPilot: normalises case and spacing', () => {
  assert.equal(slugifyPilot('casey gerstle'), 'casey-gerstle');
  assert.equal(slugifyPilot('Casey Gerstle'), 'casey-gerstle');
  assert.equal(slugifyPilot('  Kenny   Kim  '), 'kenny-kim');
});

test('slugifyPilot: folds diacritics, so accents are not a second identity', () => {
  assert.equal(slugifyPilot('Walter H Gutiérrez '), 'walter-h-gutierrez');
  assert.equal(slugifyPilot('Walter H Gutierrez'), 'walter-h-gutierrez');
});

test('slugifyPilot: drops the xcdemon id suffix', () => {
  // The same pilot appears with and without the suffix depending on whether
  // their IGC carried a pilot header.
  assert.equal(slugifyPilot('(Bruno) Subarno.1177.131'), 'bruno-subarno');
  assert.equal(slugifyPilot('(Bruno) Subarno'), 'bruno-subarno');
  assert.equal(slugifyPilot('David Suder.676.148'), 'david-suder');
});

test('slugifyPilot: leaves interior digits alone', () => {
  // Only a trailing .n.n run is an id; digits in a name are part of the name.
  assert.equal(slugifyPilot('Pilot 2 Smith'), 'pilot-2-smith');
});

test('slugifyPilot: returns empty for names we cannot key on', () => {
  // One archived day has a blank pilot name; those rows are unclaimable.
  assert.equal(slugifyPilot(''), '');
  assert.equal(slugifyPilot('   '), '');
  assert.equal(slugifyPilot('.123.4'), '');
});

test('cleanPilotLabel: tidies for display without changing identity', () => {
  assert.equal(cleanPilotLabel('Walter H Gutiérrez '), 'Walter H Gutiérrez');
  assert.equal(cleanPilotLabel('David Suder.676.148'), 'David Suder');
  assert.equal(slugifyPilot(cleanPilotLabel('David Suder.676.148')), slugifyPilot('David Suder'));
});
