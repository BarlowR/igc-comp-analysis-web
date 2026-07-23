/**
 * Unit tests for src/lib/xctsk.ts — parseXcTask flattens an XContest .xctsk
 * (plain JSON) into the app's Turnpoint/XcTask shape, with defaults for absent
 * fields. node --test test/xctsk.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXcTask } from '../src/lib/xctsk.ts';

const SAMPLE = JSON.stringify({
  earthModel: 'WGS84',
  taskType: 'CLASSIC',
  sss: { type: 'RACE', direction: 'EXIT', timeGates: ['13:00:00Z'] },
  goal: { type: 'LINE' },
  turnpoints: [
    { radius: 400, type: 'TAKEOFF', waypoint: { altSmoothed: 700, description: 'launch', lat: 47.1, lon: 8.1, name: 'TO' } },
    { radius: 1000, type: 'SSS', waypoint: { altSmoothed: 690, description: 'start', lat: 47.2, lon: 8.2, name: 'START' } },
    { radius: 2000, waypoint: { altSmoothed: 500, description: 'turn', lat: 47.3, lon: 8.3, name: 'T1' } }, // no type
    { radius: 400, type: 'ESS', waypoint: { altSmoothed: 300, description: 'end', lat: 47.4, lon: 8.4, name: 'GOAL' } },
  ],
});

test('parseXcTask: maps top-level fields', () => {
  const t = parseXcTask(SAMPLE);
  assert.equal(t.earthModel, 'WGS84');
  assert.equal(t.taskType, 'CLASSIC');
  assert.equal(t.sss.type, 'RACE');
  assert.deepEqual(t.sss.timeGates, ['13:00:00Z']);
  assert.deepEqual(t.goal, { type: 'LINE' });
});

test('parseXcTask: flattens waypoint, assigns order by index, defaults type to null', () => {
  const t = parseXcTask(SAMPLE);
  assert.equal(t.turnpoints.length, 4);
  assert.deepEqual(
    t.turnpoints.map((tp) => tp.order),
    [0, 1, 2, 3],
  );
  const tp2 = t.turnpoints[2];
  assert.equal(tp2.type, null); // no type field → null
  assert.equal(tp2.radius, 2000);
  assert.equal(tp2.altSmoothed, 500);
  assert.equal(tp2.description, 'turn');
  assert.equal(tp2.lat, 47.3);
  assert.equal(tp2.lon, 8.3);
  assert.equal(tp2.name, 'T1');
  assert.equal(t.turnpoints[0].type, 'TAKEOFF');
  assert.equal(t.turnpoints[3].type, 'ESS');
});

test('parseXcTask: empty/minimal input falls back to defaults', () => {
  const t = parseXcTask('{}');
  assert.equal(t.earthModel, '');
  assert.equal(t.taskType, '');
  assert.deepEqual(t.goal, {});
  assert.deepEqual(t.sss, { timeGates: [] });
  assert.deepEqual(t.turnpoints, []);
});
