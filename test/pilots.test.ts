/**
 * Unit tests for src/lib/pilots.ts — slugifyPilot folds the archive's messy
 * pilot names into one stable join key, which is what pilot_claims stores.
 * The sample names below are real ones taken from the built day JSONs.
 * node --test test/pilots.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPilotLabel, slugifyPilot } from '../src/lib/pilots.ts';
import { IgcFlight, pilotNameFromHeader } from '../src/lib/igc.ts';

/** Minimal IGC: header, one B record, done. */
function igc(header: string[], body: string[] = ['B1300004712000N00830000EA0100001000']): string {
  return [...header, ...body, 'GABC'].join('\n');
}

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

// The roster (src/pages/pilots.json.ts) reads only the head of each IGC, so its
// notion of a pilot's name must match what the full parser puts on the day page.
test('pilotNameFromHeader: agrees with IgcFlight on the header name', () => {
  for (const name of ['Bill Belcourt', 'casey gerstle', 'Walter H Gutiérrez ']) {
    const text = igc(['AXTEST', 'HFDTE070726', 'HFPLTPILOT:' + name]);
    assert.equal(pilotNameFromHeader(text), name);
    assert.equal(new IgcFlight(text, 'fallback').pilotName, name);
  }
});

test('pilotNameFromHeader: null without a pilot record, so the caller falls back', () => {
  const text = igc(['AXTEST', 'HFDTE070726']);
  assert.equal(pilotNameFromHeader(text), null);
  assert.equal(new IgcFlight(text, 'From Filename').pilotName, 'From Filename');
});

test('pilotNameFromHeader: an empty header name does not beat the fallback', () => {
  // Four tracks in the archive carry a bare "HFPLTPILOT:". Treating that as a
  // name would blank the pilot out even though the filename names them
  // perfectly well.
  for (const header of ['HFPLTPILOT:', 'HFPLTPILOT:   ']) {
    const text = igc(['AXTEST', 'HFDTE070726', header]);
    assert.equal(pilotNameFromHeader(text), null);
    assert.equal(new IgcFlight(text, 'Jorge Atramiz').pilotName, 'Jorge Atramiz');
  }
});

test('pilotNameFromHeader: ignores anything after the first B record', () => {
  // Stopping at the fixes is what keeps the roster read to a few KB; a stray
  // HFPLTPILOT further down must not be picked up when the parser wouldn't.
  const text = igc(['AXTEST', 'HFDTE070726'], [
    'B1300004712000N00830000EA0100001000',
    'HFPLTPILOT:Too Late',
  ]);
  assert.equal(pilotNameFromHeader(text), null);
  assert.equal(new IgcFlight(text, 'From Filename').pilotName, 'From Filename');
});

test('cleanPilotLabel: tidies for display without changing identity', () => {
  assert.equal(cleanPilotLabel('Walter H Gutiérrez '), 'Walter H Gutiérrez');
  assert.equal(cleanPilotLabel('David Suder.676.148'), 'David Suder');
  assert.equal(slugifyPilot(cleanPilotLabel('David Suder.676.148')), slugifyPilot('David Suder'));
});
