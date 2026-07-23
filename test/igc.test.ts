/**
 * Unit tests for src/lib/igc.ts — IGC B-record parsing, outlier/duplicate
 * handling, and the per-fix derived metrics (vspeed, distance, climb/glide
 * masks). Fixtures are synthetic so every expected value is hand-computable.
 *   node --test test/igc.test.ts
 * (igc.ts's only relative import is a `type`, stripped at runtime, so it loads
 * directly; competition-level stats are covered in competition.test.ts.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IgcFlight } from '../src/lib/igc.ts';

const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
const p = (n: number, w: number): string => String(Math.trunc(n)).padStart(w, '0');

/**
 * One B record: B HHMMSS DDMMmmm N DDDMMmmm E A PPPPP GGGGG (35 chars).
 * `latmm`/`lonmm` are minutes×1000, so lat = latDeg + (latmm/1000)/60.
 */
function bRec(o: {
  h?: number; m?: number; s?: number;
  latDeg?: number; latmm?: number; ns?: 'N' | 'S';
  lonDeg?: number; lonmm?: number; ew?: 'E' | 'W';
  palt?: number; galt?: number;
}): string {
  const { h = 13, m = 0, s = 0, latDeg = 47, latmm = 0, ns = 'N', lonDeg = 8, lonmm = 0, ew = 'E', palt = 1000, galt = 1000 } = o;
  return 'B' + p(h, 2) + p(m, 2) + p(s, 2) + p(latDeg, 2) + p(latmm, 5) + ns + p(lonDeg, 3) + p(lonmm, 5) + ew + 'A' + p(palt, 5) + p(galt, 5);
}

function igc(records: string[], opts: { date?: string; pilot?: string } = {}): string {
  const { date = '070726', pilot = 'Test Pilot' } = opts;
  return ['AXTEST', 'HFDTE' + date, 'HFPLTPILOT:' + pilot, ...records, 'GABC'].join('\n');
}

// ---- parsing --------------------------------------------------------------
test('parse: decodes coordinates and altitude; first fix is dropped (NaN Δt)', () => {
  const f = new IgcFlight(
    igc([
      bRec({ s: 0, latmm: 12000, lonmm: 30000, galt: 1000 }),
      bRec({ s: 10, latmm: 12345, lonmm: 30000, galt: 1234 }),
      bRec({ s: 20, latDeg: 47, latmm: 13000, lonmm: 31000, galt: 1250 }),
    ]),
    'Ada',
  );
  // buildComputedMetrics drops the first fix (its time delta is NaN), leaving 2.
  assert.equal(f.fixes.lat.length, 2);
  assert.ok(close(f.fixes.lat[0], 47 + 12.345 / 60), `lat ${f.fixes.lat[0]}`);
  assert.ok(close(f.fixes.lon[0], 8 + 30 / 60), `lon ${f.fixes.lon[0]}`); // 8.5
  assert.equal(f.fixes.gnssAlt[0], 1234);
  // Δt between the two surviving fixes is 10 s.
  assert.ok(close(f.df.secondsDelta[1][1], 10), `Δt ${f.df.secondsDelta[1][1]}`);
});

test('parse: S/W hemispheres flip the sign', () => {
  const f = new IgcFlight(
    igc([
      bRec({ s: 0 }),
      bRec({ s: 10, latDeg: 12, latmm: 30000, ns: 'S', lonDeg: 100, lonmm: 30000, ew: 'W' }),
    ]),
  );
  assert.ok(close(f.fixes.lat[0], -(12 + 0.5)), `S lat ${f.fixes.lat[0]}`);
  assert.ok(close(f.fixes.lon[0], -(100 + 0.5)), `W lon ${f.fixes.lon[0]}`);
});

test('parse: header date and pilot name', () => {
  const f = new IgcFlight(igc([bRec({ s: 0 }), bRec({ s: 10 })], { date: '070726', pilot: 'Jane Roe' }));
  assert.equal(f.day.getFullYear(), 2026);
  assert.equal(f.day.getMonth(), 6); // July (0-based)
  assert.equal(f.day.getDate(), 7);
  assert.equal(f.pilotName, 'Jane Roe');
});

test('parse: non-advancing (duplicate-time) fixes are dropped', () => {
  const f = new IgcFlight(
    igc([bRec({ s: 0 }), bRec({ s: 10 }), bRec({ s: 10, galt: 1099 }), bRec({ s: 20 })]),
  );
  // first dropped (NaN Δt) and the duplicate-time fix dropped (Δt = 0) → 2 left.
  assert.equal(f.fixes.timeMs.length, 2);
  assert.ok(f.df.secondsDelta[1][1] > 0);
});

test('parse: UTC-midnight rollover keeps time moving forward', () => {
  const f = new IgcFlight(
    igc([bRec({ h: 23, m: 59, s: 40 }), bRec({ h: 23, m: 59, s: 50 }), bRec({ h: 0, m: 0, s: 10 })]),
  );
  // Without rollover the last fix would look 23h59m40s earlier and be dropped.
  assert.equal(f.fixes.timeMs.length, 2);
  assert.ok(close(f.df.secondsDelta[1][1], 20), `rollover Δt ${f.df.secondsDelta[1][1]}`);
});

// ---- derived metrics ------------------------------------------------------
function steady(n: number, opts: { dLatmm: number; dGalt: number }): IgcFlight {
  const recs: string[] = [];
  for (let i = 0; i < n; i++) {
    recs.push(bRec({ m: Math.floor((i * 5) / 60), s: (i * 5) % 60, latmm: i * opts.dLatmm, galt: 2000 + i * opts.dGalt }));
  }
  return new IgcFlight(igc(recs));
}

test('metrics: vspeed and distance match the constant flight profile', () => {
  const f = steady(12, { dLatmm: 0, dGalt: 10 }); // stationary, +10 m per 5 s fix = +2 m/s
  const i = 8; // interior index, past the 5-fix window
  assert.ok(close(f.df.vspeed[5][i], 2, 1e-6), `vspeed ${f.df.vspeed[5][i]}`);
  assert.ok(f.df.distance[1][i] < 1, `stationary distance ${f.df.distance[1][i]}`);
});

test('metrics: stationary climb ⇒ stoppedAndClimbing; moving descent ⇒ sinkingOnGlide', () => {
  // 40 stationary climbing fixes: past the 30-fix window, distance≈0 (<200) and
  // vspeed>0 ⇒ stopped & climbing.
  const climb = steady(40, { dLatmm: 0, dGalt: 10 });
  assert.equal(climb.df.stoppedAndClimbing[35], true, 'expected stopped & climbing');
  assert.equal(climb.df.onGlide[35], false);

  // 40 moving, descending fixes (~185 m/fix): distance≫200 ⇒ on glide, vspeed<0 ⇒ sinking.
  const glide = steady(40, { dLatmm: 100, dGalt: -5 });
  assert.equal(glide.df.sinkingOnGlide[35], true, 'expected sinking on glide');
  assert.equal(glide.df.stoppedToClimb[35], false);
});
