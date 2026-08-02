/**
 * Tests for src/lib/competition.ts.
 *  - Pure helpers (nameFromFile, gradientColor) — exact.
 *  - Integration: rebuild a real archived day from its task.xctsk + IGC files and
 *    (a) reproduce the stored day.json day-constants, (b) cross-check the M / V_cc
 *    / h_fin / tauRef formulas independently of the stored output.
 * Runs under the extensionless-.ts resolve hook (see test/support). node --test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Competition,
  nameFromFile,
  gradientColor,
  metricsFor,
  COMP_SUBSET,
  HIKE_AND_FLY_SUBSET,
} from '../src/lib/competition.ts';

const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);
const median = (xs: number[]): number => {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

// ---- pure helpers ---------------------------------------------------------
test('nameFromFile: .igc stripped, underscores → spaces, title-cased', () => {
  assert.equal(nameFromFile('colin_rathbun.igc'), 'Colin Rathbun');
  assert.equal(nameFromFile('jane_doe.IGC'), 'Jane Doe');
});

test('nameFromFile: trailing _YYYY-MM-DD… id dropped; empty falls back to filename', () => {
  assert.equal(nameFromFile('enes_mentese_2026-07-19_073.igc'), 'Enes Mentese');
  assert.equal(nameFromFile('.igc'), '.igc');
});

test('gradientColor: null direction / non-finite value → null', () => {
  assert.equal(gradientColor(5, 0, 10, null), null);
  assert.equal(gradientColor(NaN, 0, 10, 'most_positive'), null);
});

test('gradientColor: least_positive greens the min, most_positive greens the max, most_negative reds the max', () => {
  assert.equal(gradientColor(0, 0, 10, 'least_positive'), 'rgb(0,230,0)');
  assert.equal(gradientColor(10, 0, 10, 'least_positive'), 'rgb(230,230,230)');
  assert.equal(gradientColor(5, 0, 10, 'least_positive'), 'rgb(115,230,115)');
  assert.equal(gradientColor(10, 0, 10, 'most_positive'), 'rgb(0,230,0)');
  assert.equal(gradientColor(10, 0, 10, 'most_negative'), 'rgb(230,0,0)');
  assert.equal(gradientColor(5, 5, 5, 'least_positive'), 'rgb(0,230,0)'); // degenerate range → norm 0
});

// ---- metric sets ----------------------------------------------------------
test('metricsFor: xc is the full set, hike-and-fly a strict subset of it', () => {
  assert.equal(metricsFor('xc'), COMP_SUBSET);
  assert.equal(metricsFor('hike-and-fly'), HIKE_AND_FLY_SUBSET);
  assert.ok(HIKE_AND_FLY_SUBSET.length < COMP_SUBSET.length, 'hike-and-fly should be the smaller set');

  // Every hike-and-fly column must be a column the XC set already defines, key,
  // gradient and label alike. A key that no longer exists in Stats renders as a
  // full column of '—', which looks like missing data rather than a typo.
  const xcByKey = new Map(COMP_SUBSET.map((c) => [c.key, c]));
  for (const col of HIKE_AND_FLY_SUBSET) {
    assert.deepEqual(xcByKey.get(col.key), col, `${col.key} diverges from the XC column`);
  }
  assert.equal(HIKE_AND_FLY_SUBSET[0].key, 'name', 'the pilot name must lead the table');
});

// ---- integration: rebuild a real archived day -----------------------------
const DAY_DIR = fileURLToPath(new URL('../dist/archive/2026-canadian-nationals/day6/', import.meta.url));
const DAY_JSON = fileURLToPath(new URL('../dist/archive/2026-canadian-nationals/day6.json', import.meta.url));

test('Competition: reproduces archived day6 constants and satisfies the τ formulas', { timeout: 240_000 }, (t) => {
  if (!existsSync(DAY_DIR) || !existsSync(DAY_JSON)) {
    t.skip('archive not built (run `npm run build`)');
    return;
  }
  const meta = JSON.parse(readFileSync(DAY_DIR + 'meta.json', 'utf8'));
  const comp = new Competition(readFileSync(DAY_DIR + meta.taskFile, 'utf8'), meta.utcOffsetMinutes ?? null);
  for (const name of meta.igcFiles as string[]) {
    comp.addPilot(readFileSync(DAY_DIR + name, 'utf8'), nameFromFile(name));
  }

  const map = comp.buildMapData();
  const ttg = map.timeToGo;
  assert.ok(ttg, 'timeToGo should be present (day6 has finishers)');
  if (!ttg) return;

  // some pilots completed; constants are finite and sane
  assert.ok(comp.pilots.some((p) => p.completed), 'expected at least one finisher');
  assert.ok(ttg.M > 0 && ttg.Vcc > 0 && ttg.dTask > 0, `bad constants: ${JSON.stringify(ttg)}`);
  assert.ok(Number.isFinite(ttg.hFin) && Number.isFinite(ttg.hRef));
  // Measured par glide: physically plausible, and not the sparse-day fallback
  // (60 km/h / 7.0) — day6 has plenty of finisher gliding to measure from.
  assert.ok(ttg.Vg > 8 && ttg.Vg < 25, `implausible par glide speed ${ttg.Vg} m/s`);
  assert.ok(ttg.g > 3 && ttg.g < 15, `implausible par glide ratio ${ttg.g}`);
  assert.ok(Math.abs(ttg.Vg - 60 / 3.6) > 1e-9 || Math.abs(ttg.g - 7) > 1e-9, 'glide params look like the fallback');

  // (a) exact reproduction of the stored build output
  const stored = JSON.parse(readFileSync(DAY_JSON, 'utf8')).map;
  for (const k of ['M', 'Vcc', 'Vg', 'g', 'pace', 'hFin', 'dTask', 'hRef', 'tauRef'] as const) {
    assert.ok(close(ttg[k], stored.timeToGo[k], Math.abs(stored.timeToGo[k]) * 1e-9 + 1e-9), `${k}: ${ttg[k]} vs stored ${stored.timeToGo[k]}`);
  }
  assert.equal(map.startMs, stored.startMs);
  assert.equal(map.turnpoints.length, stored.turnpoints.length);

  // (b) independent formula checks (par = 10 fastest finishers)
  const finishers = comp.pilots
    .filter((p) => p.completed && num(p.stats.completion_time) > 0)
    .sort((a, b) => num(a.stats.completion_time) - num(b.stats.completion_time));
  const par = finishers.slice(0, 10);
  const mCheck = median(par.map((p) => num(p.stats.comp_average_climb_rate)));
  const medComp = median(par.map((p) => num(p.stats.completion_time)));
  const hFinCheck = Math.min(...finishers.map((p) => num(p.stats.comp_finish_msl)).filter(Number.isFinite));
  assert.ok(close(ttg.M, mCheck, 1e-9), `M ${ttg.M} vs median-climb ${mCheck}`);
  assert.ok(close(ttg.Vcc, ttg.dTask / medComp, 1e-6), `Vcc ${ttg.Vcc} vs dTask/medComp ${ttg.dTask / medComp}`);
  assert.ok(close(ttg.hFin, hFinCheck, 1e-9), `hFin ${ttg.hFin} vs min-finish ${hFinCheck}`);
  // tauRef = pace-fitted τ at the reference start state — which by construction
  // is exactly the par pilots' actual median gate→ESS duration in minutes.
  const owedRef = Math.max(0, ttg.dTask / ttg.g - (ttg.hRef - ttg.hFin));
  const tauRefCheck = (ttg.pace * (ttg.dTask / ttg.Vg + owedRef / ttg.M)) / 60;
  assert.ok(close(ttg.tauRef, tauRefCheck, 1e-6), `tauRef ${ttg.tauRef} vs formula ${tauRefCheck}`);
  assert.ok(close(ttg.tauRef, medComp / 60, 1e-6), `tauRef ${ttg.tauRef} vs median par duration ${medComp / 60}`);
  assert.ok(ttg.pace > 0.4 && ttg.pace < 1.3, `implausible pace fit ${ttg.pace}`);

  // τ ≈ 0 at the ESS crossing for a finisher
  const fin = map.tracks.find((tr) => tr.completionMs != null && tr.tau);
  assert.ok(fin, 'expected a finisher track with τ');
  if (fin && fin.tau) {
    let i = 0;
    while (i < fin.times.length && fin.times[i] < fin.completionMs!) i++;
    i = Math.min(i, fin.tau.length - 1);
    assert.ok(Math.abs(fin.tau[i]) < 0.1, `τ at ESS = ${fin.tau[i]} (expected ≈0)`);
  }

  // stats table columns follow COMP_SUBSET
  const table = comp.buildStatsTable();
  assert.deepEqual(table.headers, COMP_SUBSET.map((c) => c.label));
});

// ---- duplicate tracklogs --------------------------------------------------
const DUP_DIR = fileURLToPath(new URL('../dist/archive/chelan-us-open-2026/day1/', import.meta.url));

test('Competition: one row per pilot when a day holds two tracklogs for them', { timeout: 120_000 }, (t) => {
  // chelan-us-open day 1 has two real cases: Mike Steed's 344-byte stub beside
  // his actual 126 km flight, and Robert Barlow's flight logged twice by two
  // instruments. Without per-pilot dedup, each would produce two rows in the
  // stats table.
  const files = [
    'mike_steed_2026-06-21_01.171.igc',
    'mike_steed_2026-06-21_02.171.igc',
    'robert_barlow_2026-06-21_01.369.igc',
    'robert_barlow_2026-06-21_02.369.igc',
  ];
  if (!existsSync(DUP_DIR) || files.some((f) => !existsSync(DUP_DIR + f))) {
    t.skip('archive not built (run `npm run build`)');
    return;
  }
  const task = readFileSync(DUP_DIR + 'task.xctsk', 'utf8');

  const load = (order: string[]): Competition => {
    const comp = new Competition(task, -420);
    for (const f of order) comp.addPilot(readFileSync(DUP_DIR + f, 'utf8'), nameFromFile(f));
    return comp;
  };

  const comp = load(files);
  assert.equal(comp.pilots.filter((p) => p.name === 'Mike Steed').length, 1);
  assert.equal(comp.pilots.filter((p) => p.name === 'Robert Barlow').length, 1);

  // The stub records no distance, so the real flight must be the one kept.
  const steed = comp.pilots.find((p) => p.name === 'Mike Steed')!;
  assert.ok(num(steed.stats.comp_total_distance) > 1000, `kept the stub: ${steed.stats.comp_total_distance}`);

  // And the choice can't depend on the order files happen to be listed in.
  const reversed = load([...files].reverse());
  for (const name of ['Mike Steed', 'Robert Barlow']) {
    const a = comp.pilots.find((p) => p.name === name)!;
    const b = reversed.pilots.find((p) => p.name === name)!;
    assert.equal(num(a.stats.comp_total_distance), num(b.stats.comp_total_distance), `${name} differs by input order`);
  }
});

// ---- hike and fly ---------------------------------------------------------
// Same tracklogs, both kinds, so every difference below is the kind's doing and
// not the day's. A real hike-and-fly day isn't needed to pin the wiring down:
// which columns come out, and that the par/Time Lost model doesn't run.
test('Competition: hike-and-fly ships the basic metric set and no Time Lost data', { timeout: 120_000 }, (t) => {
  // Two of the day's finishers, so the XC half of the comparison has the ESS
  // crossings the par model needs — otherwise it would omit timeToGo for want of
  // data and prove nothing about the kind.
  const files = ['russell_ogden_2026-06-21_01.51.igc', 'chaeden_luebberke_2026-06-21_01.7.igc'];
  if (!existsSync(DUP_DIR) || files.some((f) => !existsSync(DUP_DIR + f))) {
    t.skip('archive not built (run `npm run build`)');
    return;
  }
  const task = readFileSync(DUP_DIR + 'task.xctsk', 'utf8');
  const load = (kind: 'xc' | 'hike-and-fly'): ReturnType<Competition['buildResults']> => {
    const comp = new Competition(task, -420, kind);
    for (const f of files) comp.addPilot(readFileSync(DUP_DIR + f, 'utf8'), nameFromFile(f));
    return comp.buildResults();
  };

  const hnf = load('hike-and-fly');
  assert.deepEqual(hnf.table.headers, HIKE_AND_FLY_SUBSET.map((c) => c.label));
  assert.equal(hnf.map.taskKind, 'hike-and-fly');
  // No par model: no day constants, and no per-track τ to plot against them.
  assert.equal(hnf.map.timeToGo, null);
  assert.ok(hnf.map.tracks.length > 0, 'tracks should still be built');
  for (const tr of hnf.map.tracks) assert.equal(tr.tau, undefined, `${tr.pilot} carries τ`);
  // An empty decomposition is what leaves the breakdown panel off the table.
  assert.equal(hnf.timeLoss.winner, null);
  assert.deepEqual(hnf.timeLoss.rows, []);
  // The climb-rate distribution is kept — it reads the same on either kind.
  assert.equal(hnf.climb.completed.length + hnf.climb.incomplete.length, files.length);

  // The same day as an XC comp: full columns, and the par model runs (these
  // pilots include a finisher, so timeToGo is populated).
  const xc = load('xc');
  assert.deepEqual(xc.table.headers, COMP_SUBSET.map((c) => c.label));
  assert.equal(xc.map.taskKind, 'xc');
  assert.ok(xc.map.timeToGo, 'xc should still build the par constants');

  // Only the presentation changes: the underlying stats are computed identically,
  // so a column both kinds show has to hold the same number.
  const colOf = (cols: typeof COMP_SUBSET, key: string): number => {
    const i = cols.findIndex((c) => c.key === key);
    assert.ok(i >= 0, `no ${key} column`);
    return i;
  };
  const hnfDist = colOf(HIKE_AND_FLY_SUBSET, 'comp_total_distance');
  const xcDist = colOf(COMP_SUBSET, 'comp_total_distance');
  assert.ok(hnf.table.completed.length + hnf.table.incomplete.length > 0, 'expected rows to compare');
  for (const group of ['completed', 'incomplete'] as const) {
    for (const row of hnf.table[group]) {
      const same = xc.table[group].find((r) => r[0].text === row[0].text);
      assert.equal(row[hnfDist].text, same?.[xcDist].text, `${row[0].text}: distance differs between kinds`);
    }
  }
});
