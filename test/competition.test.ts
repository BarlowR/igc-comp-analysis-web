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
import { Competition, nameFromFile, gradientColor, COMP_SUBSET } from '../src/lib/competition.ts';

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

  // (a) exact reproduction of the stored build output
  const stored = JSON.parse(readFileSync(DAY_JSON, 'utf8')).map;
  for (const k of ['M', 'Vcc', 'hFin', 'dTask', 'hRef', 'tauRef'] as const) {
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
  // tauRef = (dTask/Vcc − (hRef − hFin)/M)/60
  const tauRefCheck = (ttg.dTask / ttg.Vcc - (ttg.hRef - ttg.hFin) / ttg.M) / 60;
  assert.ok(close(ttg.tauRef, tauRefCheck, 1e-6), `tauRef ${ttg.tauRef} vs formula ${tauRefCheck}`);

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
