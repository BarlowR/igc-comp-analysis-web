/**
 * Unit tests for src/lib/math.ts — the pandas/numpy-port numeric helpers that
 * underpin the whole igc.ts stats pipeline (climb rate, thermal detection,
 * distances), plus optimizeTaskRoute (the map's "optimized task" line). NaN
 * semantics must stay faithful to pandas, so they are pinned explicitly.
 *   node --test test/math.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine,
  diff,
  shift,
  divide,
  scale,
  cumsum,
  clip,
  where,
  cumsumBool,
  and,
  not,
  nanmean,
  optimizeTaskRoute,
} from '../src/lib/math.ts';
import { buildGeom, taskDistanceM } from '../src/lib/timetogo.ts';

const EARTH = 6_371_000;
const DEG = Math.PI / 180;
const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

// ---- haversine ------------------------------------------------------------
test('haversine: zero distance, degree scales, symmetry', () => {
  assert.equal(haversine(0, 0, 0, 0), 0);
  const oneDeg = DEG * EARTH; // 1° along a great circle
  assert.ok(close(haversine(0, 0, 1, 0), oneDeg, 1e-3), 'one degree of latitude');
  assert.ok(close(haversine(0, 0, 0, 1), oneDeg, 1e-3), 'one degree of longitude at equator');
  // symmetric in its endpoints
  assert.ok(close(haversine(47.1, 8.2, 46.9, 8.5), haversine(46.9, 8.5, 47.1, 8.2), 1e-9));
  // a degree of longitude shrinks by cos(lat) away from the equator
  assert.ok(haversine(60, 0, 60, 1) < haversine(0, 0, 0, 1));
});

// ---- diff / shift ---------------------------------------------------------
test('diff: first `periods` are NaN, rest are x[i]-x[i-periods]', () => {
  assert.deepEqual(diff([1, 3, 6, 10]), [NaN, 2, 3, 4]);
  assert.deepEqual(diff([1, 3, 6, 10], 2), [NaN, NaN, 5, 7]);
  assert.deepEqual(diff([]), []);
});

test('shift: pulls values forward by `periods`, NaN-filling the head', () => {
  assert.deepEqual(shift([1, 2, 3]), [NaN, 1, 2]);
  assert.deepEqual(shift([1, 2, 3], 2), [NaN, NaN, 1]);
});

// ---- divide / scale -------------------------------------------------------
test('divide: element-wise, ÷0 → Infinity, NaN propagates', () => {
  assert.deepEqual(divide([6, 9], [3, 3]), [2, 3]);
  assert.deepEqual(divide([1], [0]), [Infinity]);
  assert.deepEqual(divide([NaN], [2]), [NaN]);
});

test('scale: multiplies every element', () => {
  assert.deepEqual(scale([1, 2, 3], 2), [2, 4, 6]);
  assert.deepEqual(scale([4, 6], 0.5), [2, 3]);
});

// ---- cumsum (skipna) ------------------------------------------------------
test('cumsum: running total, NaN contributes 0 but keeps the slot', () => {
  assert.deepEqual(cumsum([1, 2, 3]), [1, 3, 6]);
  assert.deepEqual(cumsum([1, NaN, 3]), [1, 1, 4]);
  assert.deepEqual(cumsum([]), []);
});

// ---- clip -----------------------------------------------------------------
test('clip: lower/upper bounds independently, NaN passes through', () => {
  assert.deepEqual(clip([-1, 5, 10], 0, 7), [0, 5, 7]);
  assert.deepEqual(clip([-1, 5, 10], 0, undefined), [0, 5, 10]); // lower only
  assert.deepEqual(clip([-1, 5, 10], undefined, 7), [-1, 5, 7]); // upper only
  assert.deepEqual(clip([NaN, 5], 0, 1), [NaN, 1]);
});

// ---- where / cumsumBool / and / not --------------------------------------
test('where: keep on true, else `other` (default 0)', () => {
  assert.deepEqual(where([1, 2, 3], [true, false, true]), [1, 0, 3]);
  assert.deepEqual(where([1, 2, 3], [false, false, true], -1), [-1, -1, 3]);
});

test('cumsumBool: cumulative count of true flags', () => {
  assert.deepEqual(cumsumBool([true, false, true, true]), [1, 1, 2, 3]);
  assert.deepEqual(cumsumBool([false, false]), [0, 0]);
});

test('and / not: element-wise boolean logic', () => {
  assert.deepEqual(and([true, true, false], [true, false, false]), [true, false, false]);
  assert.deepEqual(not([true, false, true]), [false, true, false]);
});

// ---- nanmean --------------------------------------------------------------
test('nanmean: mean ignoring NaN; all-NaN and empty are NaN', () => {
  assert.equal(nanmean([1, 2, 3]), 2);
  assert.equal(nanmean([1, NaN, 3]), 2);
  assert.ok(Number.isNaN(nanmean([NaN, NaN])));
  assert.ok(Number.isNaN(nanmean([])));
});

// ---- optimizeTaskRoute ----------------------------------------------------
test('optimizeTaskRoute: trivial sizes', () => {
  assert.deepEqual(optimizeTaskRoute([]), []);
  assert.deepEqual(optimizeTaskRoute([{ lat: 47, lon: 8, radius: 1000 }]), [[47, 8]]);
});

test('optimizeTaskRoute: zero-radius cylinders stay at their centres', () => {
  const tps = [
    { lat: 47.0, lon: 8.0, radius: 0 },
    { lat: 47.1, lon: 8.2, radius: 0 },
    { lat: 47.2, lon: 8.1, radius: 0 },
  ];
  const route = optimizeTaskRoute(tps);
  for (let i = 0; i < tps.length; i++) {
    assert.ok(close(route[i][0], tps[i].lat, 1e-9) && close(route[i][1], tps[i].lon, 1e-9), `moved point ${i}`);
  }
});

test('optimizeTaskRoute: each touch lies on its cylinder ring (metres)', () => {
  const tps = [
    { lat: 47.0, lon: 8.0, radius: 800 },
    { lat: 47.05, lon: 8.15, radius: 2000 },
    { lat: 47.0, lon: 8.3, radius: 600 },
  ];
  const route = optimizeTaskRoute(tps);
  for (let i = 0; i < tps.length; i++) {
    const dm = haversine(tps[i].lat, tps[i].lon, route[i][0], route[i][1]);
    assert.ok(close(dm, tps[i].radius, 1.5), `point ${i} off its ring: ${dm.toFixed(1)} vs ${tps[i].radius}`);
  }
});

test('optimizeTaskRoute: agrees with timetogo buildGeom on a detour task', () => {
  // Same cylinders through two independent optimisers → same route length.
  const pts = [
    { lat: 47.0, lon: 8.0, radius: 400 },
    { lat: 47.06, lon: 8.12, radius: 2000 },
    { lat: 46.96, lon: 8.24, radius: 2000 },
    { lat: 47.0, lon: 8.36, radius: 300 },
  ];
  const route = optimizeTaskRoute(pts);
  let lenA = 0;
  for (let i = 1; i < route.length; i++) lenA += haversine(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]);
  const geom = buildGeom(pts.map((p, i) => ({ lat: p.lat, lon: p.lon, radius: p.radius, name: `t${i}`, type: i === 0 ? 'SSS' : i === pts.length - 1 ? 'ESS' : 'TP', order: i + 1 })));
  const lenB = taskDistanceM(geom);
  assert.ok(close(lenA, lenB, 5), `optimizers disagree: optimizeTaskRoute ${lenA.toFixed(1)} vs buildGeom ${lenB.toFixed(1)}`);
});
