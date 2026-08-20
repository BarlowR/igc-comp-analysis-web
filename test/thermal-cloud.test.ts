/**
 * Unit tests for src/lib/thermal-cloud.ts — the resample + per-frame query
 * behind the Thermal Cloud popup.
 *   node --test test/thermal-cloud.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCloudModel, frameAt, trackAt, STEP_MS } from '../src/lib/thermal-cloud';
import type { MapTrack } from '../src/lib/competition';

const T0 = 1_700_000_000_000;

/** A track climbing at `climb` m/s, drifting east at `vx` m/s, sampled every `dt` s. */
function track(pilot: string, opts: { climb: number; vx?: number; dt?: number; n?: number; lat?: number; alt0?: number }): MapTrack {
  const { climb, vx = 0, dt = 12, n = 60, lat = 47.8, alt0 = 1500 } = opts;
  const points: [number, number][] = [];
  const times: number[] = [];
  const alt: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = i * dt;
    points.push([lat, -120 + (vx * s) / (111_320 * Math.cos((lat * Math.PI) / 180))]);
    times.push(T0 + s * 1000);
    alt.push(alt0 + climb * s);
  }
  return { pilot, points, times, alt };
}

test('resamples a 12 s track onto the 5 s grid with a 10 s centred vario', () => {
  const m = buildCloudModel([track('A', { climb: 2 })]);
  assert.equal(m.tracks.length, 1);
  const ct = m.tracks[0];
  assert.equal(ct.t0 % STEP_MS, 0);
  // Interior samples: vario equals the true climb.
  assert.ok(Math.abs(ct.v[10] - 2) < 1e-3);
  // East drift is zero, so x stays put; altitude rises 10 m per step.
  assert.ok(Math.abs(ct.alt[11] - ct.alt[10] - 10) < 1e-3);
  // 90th percentile of a constant positive vario is that vario.
  assert.equal(m.vmax, 2);
});

test('trackAt interpolates between grid samples and is null outside the track', () => {
  const m = buildCloudModel([track('A', { climb: 1, vx: 10 })]);
  const ct = m.tracks[0];
  const a = trackAt(ct, ct.t0 + 2500)!;
  assert.ok(Math.abs(a.x - (ct.x[0] + ct.x[1]) / 2) < 1e-3);
  assert.equal(trackAt(ct, ct.t0 - 1), null);
});

test('frameAt keeps nearby samples and drops the far-away pilot', () => {
  const near = track('Near', { climb: 1.5, alt0: 1100 });
  const far = track('Far', { climb: 3, lat: 47.9 }); // ~11 km north
  const me = track('Me', { climb: 0.5 });
  const m = buildCloudModel([me, near, far]);
  const t = T0 + 400_000;
  const f = frameAt(m, 'Me', t);
  assert.ok(f.anchor);
  assert.equal(f.bestNearby?.pilot, 'Near');
  assert.ok(Math.abs(f.bestNearby!.v - 1.5) < 1e-3);
  assert.ok(f.air.every((s) => s.pilot !== 'Far'));
  assert.ok(f.air.some((s) => s.pilot === 'Near'));
  // Trailing window is 3 min: nothing older.
  assert.ok(f.air.every((s) => s.ageS <= 180));
  // Best / avg are my own climb (a steady 0.5); Near is the best around.
  assert.ok(f.best !== null && Math.abs(f.best - 0.5) < 1e-3);
  assert.ok(f.avg !== null && Math.abs(f.avg - 0.5) < 1e-3);
  // Far is still a grey pilot dot even though its air is out of range.
  assert.equal(f.others.length, 2);
});

test('best climb in vicinity needs someone actually climbing', () => {
  const m = buildCloudModel([track('Me', { climb: -1 }), track('Sinker', { climb: -2 })]);
  const f = frameAt(m, 'Me', T0 + 200_000);
  assert.equal(f.bestNearby, null);
});
