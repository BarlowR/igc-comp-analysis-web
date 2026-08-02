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
import { parseXcTask, type XcTask } from '../src/lib/xctsk.ts';

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
  // UTC accessors: the header date is a UTC date, and f.day is UTC midnight.
  assert.equal(f.day.getUTCFullYear(), 2026);
  assert.equal(f.day.getUTCMonth(), 6); // July (0-based)
  assert.equal(f.day.getUTCDate(), 7);
  assert.equal(f.pilotName, 'Jane Roe');
});

test('parse: fix times are true UTC instants, not the parsing machine local time', () => {
  // The archive's day JSON is built on one machine and read on another, and the
  // clock is rendered from these numbers (formatClock + the day's UTC offset).
  // Anything derived from the local Date constructor would make the expected
  // value here depend on process.env.TZ.
  const f = new IgcFlight(igc([bRec({ h: 19, m: 30, s: 0 }), bRec({ h: 19, m: 30, s: 10 })]));
  assert.equal(f.fixes.timeMs[0], Date.UTC(2026, 6, 7, 19, 30, 10));
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

// ---- where the scored task ends -------------------------------------------
// buildCompMetrics finishes at the turnpoint that declares itself the ESS, and
// at the LAST turnpoint when none does — a hike and fly has no ESS cylinder
// before goal, so the goal is the finish. Synthetic tasks, so the flight is a
// straight line through cylinders at known latitudes.

/** Cylinders (r=400 m) at 47.0/47.1/47.2/47.3 °N on 8°E; gate 13:00Z. */
function taskAt(types: (string | null)[]): XcTask {
  return parseXcTask(
    JSON.stringify({
      taskType: 'CLASSIC',
      sss: { type: 'RACE', direction: 'EXIT', timeGates: ['13:00:00Z'] },
      goal: { type: 'CYLINDER' },
      turnpoints: types.map((type, i) => ({
        radius: 400,
        ...(type ? { type } : {}),
        waypoint: { lat: 47 + i * 0.1, lon: 8, altSmoothed: 1000, description: '', name: `TP${i}` },
      })),
    }),
  );
}

/**
 * Sits in the start cylinder, then flies straight up the 8°E meridian to 47.35
 * at 0.005°/fix — so 47.1/47.2/47.3 are hit exactly, and there are fixes beyond
 * the last one for COMPLETED to land on.
 *
 * The four stationary fixes matter: buildComputedMetrics drops the first fix, so
 * a flight that leaves the SSS immediately would have no "inside the cylinder"
 * fix left to start from.
 */
function crossingFlight(): string {
  const recs: string[] = [];
  const at = (i: number, lat: number): string =>
    bRec({ h: 13, m: Math.floor((i * 5) / 60), s: (i * 5) % 60, latDeg: 47, latmm: Math.round(lat * 60 * 1000), galt: 2000 });
  for (let i = 0; i < 4; i++) recs.push(at(i, 0)); // holding in the start cylinder
  for (let i = 0; i <= 70; i++) recs.push(at(4 + i, i * 0.005));
  return igc(recs, { date: '070726' });
}

test('task end: an explicit ESS finishes there, not at the goal behind it', () => {
  // The XC shape: an ESS cylinder at the second-to-last turnpoint, goal last.
  const f = new IgcFlight(crossingFlight());
  f.buildCompMetrics(taskAt(['SSS', null, 'ESS', null]));
  assert.equal(f.stats.completed, true);
  // Finish is TP2 (47.2), so scoring stops there rather than running on to TP3.
  const lat = f.compDf!.lat;
  assert.ok(lat[lat.length - 1] < 47.25, `scored past the ESS: ended at ${lat[lat.length - 1]}`);
  assert.ok(lat[lat.length - 1] > 47.19, `stopped short of the ESS: ${lat[lat.length - 1]}`);
});

test('task end: no ESS (hike and fly) finishes at the goal, not a turnpoint early', () => {
  const f = new IgcFlight(crossingFlight());
  f.buildCompMetrics(taskAt(['SSS', null, null, null]));
  assert.equal(f.stats.completed, true);
  // With no ESS the last turnpoint (47.3) is the finish; the old
  // second-to-last rule would have called it done at 47.2, ~11 km short.
  const lat = f.compDf!.lat;
  assert.ok(lat[lat.length - 1] > 47.29, `finished a turnpoint early: ended at ${lat[lat.length - 1]}`);
});

test('task end: a nameless turnpoint is not a finished task', () => {
  // Regression: reading "finished" off a missing waypoint NAME rather than the
  // turnpoint index scored every such task complete at the first fix.
  const task = taskAt(['SSS', null, 'ESS', null]);
  for (const tp of task.turnpoints) tp.name = '';
  const f = new IgcFlight(crossingFlight());
  f.buildCompMetrics(task);
  assert.equal(f.stats.completed, true); // completes on geometry, as before
  const lat = f.compDf!.lat;
  assert.ok(lat[lat.length - 1] < 47.25, `nameless turnpoints ended it early: ${lat[lat.length - 1]}`);
});
