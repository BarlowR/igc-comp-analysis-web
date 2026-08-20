/**
 * Tests for src/lib/results-codec.ts — the day.json / saved-results wire codec.
 * Every decode here goes through JSON.parse(JSON.stringify(...)) first, because
 * that round-trip (NaN → null, dropped undefineds) is the path every real
 * payload takes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeResults, decodeResults, packBits, unpackBits, RESULTS_FORMAT } from '../src/lib/results-codec.ts';
import type { Results, MapTrack } from '../src/lib/competition.ts';

const wire = (r: Results): unknown => JSON.parse(JSON.stringify(encodeResults(r)));

function makeResults(tracks: MapTrack[], overrides: Partial<Results['map']> = {}): Results {
  return {
    table: { headers: ['Pilot'], dirs: [null], completed: [], incomplete: [] },
    climb: { completed: [], incomplete: [] },
    timeLoss: {
      winner: null,
      rows: [],
      topCount: 0,
      contextScale: { avgClimbRate: 1, avgAltitude: 1, totalDistance: 1 },
    },
    map: {
      turnpoints: [{ lat: 40.1, lon: -111.6, radius: 400, name: 'SSS', type: 'SSS', order: 1 }],
      tracks,
      taskKind: 'xc',
      utcOffsetMinutes: -420,
      startMs: 1_700_000_000_000,
      route: [
        [40.123456789, -111.987654321],
        [40.2, -111.5],
      ],
      timeToGo: {
        M: 2.5,
        Vg: 11.2,
        g: 7.3,
        pace: 0.91,
        tauRef: 95.4,
        par: { a: [1_700_000_100_000, 0.2], b: [1_700_005_000_000, -0.1] },
        Vcc: 9.9,
        hFin: 1400,
        dTask: 55_000,
        hRef: 2600,
      },
      ...overrides,
    },
  };
}

// ---- bitmask --------------------------------------------------------------

test('packBits/unpackBits: round-trips every length and pattern', () => {
  for (const n of [0, 1, 5, 7, 8, 9, 16, 47, 100]) {
    // A pattern that exercises both values at every position.
    const bits = Array.from({ length: n }, (_, i) => (i * 7) % 3 === 0);
    assert.deepEqual(unpackBits(packBits(bits), n), bits, `length ${n}`);
  }
});

test('packBits: ~6 bits per character', () => {
  const s = packBits(new Array<boolean>(600).fill(true));
  assert.ok(s.length <= 100, `600 bits took ${s.length} chars`);
});

// ---- track packing --------------------------------------------------------

test('codec: full track round-trips through JSON', () => {
  const track: MapTrack = {
    pilot: 'Ada Lovelace',
    points: [
      [40.12345671234, -111.65432198765],
      [40.1240001, -111.6550002],
      [40.1250009, -111.6560008],
    ],
    times: [1_700_000_000_000, 1_700_000_004_000, 1_700_000_009_000],
    alt: [2000.4, 2010.6, 2021.2],
    tau: [95.4, 94.1, 92.8],
    finalGlide: [false, true, true],
    completionMs: 1_700_000_009_000,
    startCrossMs: 1_700_000_000_000,
  };
  const out = decodeResults(wire(makeResults([track]))).map.tracks[0];

  assert.equal(out.pilot, track.pilot);
  assert.equal(out.points.length, 3);
  out.points.forEach(([lat, lon], i) => {
    assert.ok(Math.abs(lat - track.points[i][0]) <= 5e-8, `lat[${i}]`);
    assert.ok(Math.abs(lon - track.points[i][1]) <= 5e-8, `lon[${i}]`);
  });
  assert.deepEqual(out.times, track.times, 'delta-coded times reproduce exactly');
  assert.deepEqual(out.alt, [2000, 2011, 2021], 'altitudes round to whole metres');
  assert.deepEqual(out.tau, track.tau);
  assert.deepEqual(out.finalGlide, track.finalGlide);
  assert.equal(out.completionMs, track.completionMs);
  assert.equal(out.startCrossMs, track.startCrossMs);
});

test('codec: whole-second times ship as second-deltas on the wire', () => {
  const track: MapTrack = {
    pilot: 'P',
    points: [[40, -111], [40.001, -111.001]],
    times: [1_700_000_000_000, 1_700_000_004_000],
    alt: [1000, 1001],
  };
  const w = wire(makeResults([track])) as {
    map: { tracks: { t: { d: number[]; m?: number }; lat: { d: number[]; s?: number } }[] };
  };
  assert.deepEqual(w.map.tracks[0].t, { d: [1_700_000_000, 4], m: 1000 });
  assert.deepEqual(w.map.tracks[0].lat, { d: [400_000_000, 10_000], s: 1e7 });
});

test('codec: sub-second times stay exact through the millisecond path', () => {
  const track: MapTrack = {
    pilot: 'P',
    points: [[40, -111], [40.001, -111.001], [40.002, -111.002]],
    times: [1_700_000_000_000, 1_700_000_004_500, 1_700_000_009_250],
    alt: [1000, 1001, 1002],
  };
  const out = decodeResults(wire(makeResults([track]))).map.tracks[0];
  assert.deepEqual(out.times, track.times);
});

test('codec: a non-finite time stamp falls back to absolute times', () => {
  const track: MapTrack = {
    pilot: 'P',
    points: [[40, -111], [40.001, -111.001], [40.002, -111.002]],
    times: [1_700_000_000_000, NaN, 1_700_000_008_000],
    alt: [1000, 1001, 1002],
  };
  const out = decodeResults(wire(makeResults([track]))).map.tracks[0];
  assert.equal(out.times[0], 1_700_000_000_000);
  assert.ok(Number.isNaN(out.times[1]), 'NaN survives (as it did pre-codec, via null)');
  assert.equal(out.times[2], 1_700_000_008_000);
});

test('codec: absent optional track fields stay absent', () => {
  const track: MapTrack = {
    pilot: 'P',
    points: [[40, -111], [40.001, -111.001]],
    times: [1, 2],
    alt: [1000, 1001],
  };
  const out = decodeResults(wire(makeResults([track]))).map.tracks[0];
  assert.equal(out.tau, undefined);
  assert.equal(out.finalGlide, undefined);
  assert.equal(out.completionMs, undefined);
  assert.equal(out.startCrossMs, undefined);
});

// ---- map-level fields -----------------------------------------------------

test('codec: strips the par-fit diagnostics, keeps the shipped constants and par', () => {
  const r = makeResults([]);
  const w = wire(r) as { map: { timeToGo: Record<string, unknown> } };
  assert.deepEqual(Object.keys(w.map.timeToGo).sort(), ['M', 'Vg', 'g', 'pace', 'par', 'tauRef']);

  const ttg = decodeResults(w).map.timeToGo;
  assert.ok(ttg);
  assert.equal(ttg!.M, 2.5);
  assert.equal(ttg!.tauRef, 95.4);
  assert.deepEqual(ttg!.par, r.map.timeToGo!.par);
  assert.equal(ttg!.Vcc, undefined);
  assert.equal(ttg!.dTask, undefined);
});

test('codec: route, turnpoints, kind, offsets and startMs survive', () => {
  const r = makeResults([]);
  const out = decodeResults(wire(r)).map;
  assert.equal(out.taskKind, 'xc');
  assert.equal(out.utcOffsetMinutes, -420);
  assert.equal(out.startMs, r.map.startMs);
  assert.deepEqual(out.turnpoints, r.map.turnpoints);
  assert.equal(out.route!.length, 2);
  assert.ok(Math.abs(out.route![0][0] - 40.123456789) <= 5e-8);
});

test('codec: null timeToGo (hike-and-fly / free) passes through', () => {
  const out = decodeResults(wire(makeResults([], { timeToGo: null })));
  assert.equal(out.map.timeToGo, null);
});

// ---- versioning -----------------------------------------------------------

test('decodeResults: passes a pre-codec plain payload through unchanged', () => {
  const legacy = { table: {}, climb: {}, timeLoss: {}, map: { tracks: [] } };
  assert.equal(decodeResults(legacy), legacy);
});

test('decodeResults: refuses a format it does not know', () => {
  assert.throws(() => decodeResults({ fmt: RESULTS_FORMAT + 1 }), /newer/);
});
