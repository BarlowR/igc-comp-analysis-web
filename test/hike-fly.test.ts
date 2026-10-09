/**
 * Tests for the hiking/flying split: src/lib/hike-fly.ts (flight vs vehicle
 * ride) and the hike-and-fly path through IgcFlight.buildCompMetrics that uses
 * it. Synthetic tracks first, so each expected value follows from the script
 * that built the track; then one archived X Red Rocks day as the real thing.
 * Runs under the extensionless-.ts resolve hook (see test/support). node --test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectAirSegments, hikingHeightGained } from '../src/lib/hike-fly.ts';
import { IgcFlight } from '../src/lib/igc.ts';
import { parseXcTask, type XcTask } from '../src/lib/xctsk.ts';
import { Competition, nameFromFile, HIKE_AND_FLY_SUBSET } from '../src/lib/competition.ts';

const M_PER_DEG_LAT = 111_195;
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/** A 1 Hz track due north up the 8°E meridian from 47°N, built leg by leg. */
class Script {
  northM: number[] = [0];
  alt: number[] = [1000];

  /** `seconds` of travel at `speed` m/s, climbing `climb` m/s. `roll` adds a
   * rolling road's rise and fall, which is what a real drive's GPS height has. */
  leg(seconds: number, speed: number, climb = 0, roll = 0): this {
    const n0 = this.northM[this.northM.length - 1];
    const a0 = this.alt[this.alt.length - 1];
    for (let s = 1; s <= seconds; s++) {
      this.northM.push(n0 + speed * s);
      this.alt.push(a0 + climb * s + roll * Math.sin((2 * Math.PI * s) / 120));
    }
    return this;
  }

  /** Seconds elapsed at the end of the script so far. */
  get now(): number {
    return this.northM.length - 1;
  }

  columns(): { timeMs: number[]; lat: number[]; lon: number[]; gnssAlt: number[] } {
    const t0 = Date.UTC(2026, 6, 7, 13, 0, 0);
    return {
      timeMs: this.northM.map((_, i) => t0 + i * 1000),
      lat: this.northM.map((m) => 47 + m / M_PER_DEG_LAT),
      lon: this.northM.map(() => 8),
      gnssAlt: this.alt,
    };
  }

  /** The same track as IGC text, first fix at 13:00:00Z. */
  igc(): string {
    const p = (n: number, w: number): string => String(Math.trunc(n)).padStart(w, '0');
    const recs = this.northM.map((m, i) => {
      const t = 13 * 3600 + i;
      const latmm = Math.round((m / M_PER_DEG_LAT) * 60 * 1000);
      const alt = p(Math.round(this.alt[i]), 5);
      return `B${p(t / 3600, 2)}${p((t % 3600) / 60, 2)}${p(t % 60, 2)}47${p(latmm, 5)}N00800000EA${alt}${alt}`;
    });
    return ['AXTEST', 'HFDTE070726', 'HFPLTPILOT:Test Pilot', ...recs, 'GABC'].join('\n');
  }
}

const HIKE = 1.5; // m/s
const GLIDE = 10; // m/s over the ground, sinking 1.2: a glide ratio of 8

// ---- flight vs vehicle ----------------------------------------------------
test('detectAirSegments: a glide is a flight, a drive is a vehicle, a hike is neither', () => {
  const s = new Script().leg(600, HIKE, 0.3);
  const launch = s.now;
  s.leg(300, GLIDE, -1.2);
  const landing = s.now;
  s.leg(600, HIKE, 0.1);
  const highwayStart = s.now;
  s.leg(300, 28, 0, 30); // highway speed
  s.leg(300, 0);
  const roadStart = s.now;
  s.leg(600, 12, 0, 30); // a slow road: no height gained, no glide angle, no turns
  s.leg(300, 0);

  const segs = detectAirSegments(s.columns());
  assert.deepEqual(segs.map((g) => g.kind), ['flight', 'vehicle', 'vehicle']);
  // The detector walks launch back and landing forward to the nearest slow fix.
  assert.ok(Math.abs(segs[0].launch - launch) <= 15, `launch at ${segs[0].launch}, flown from ${launch}`);
  assert.ok(Math.abs(segs[0].landing - landing) <= 15, `landing at ${segs[0].landing}, landed at ${landing}`);
  assert.ok(Math.abs(segs[1].launch - highwayStart) <= 15);
  assert.ok(Math.abs(segs[2].launch - roadStart) <= 15);
});

test('detectAirSegments: a track too short for the detector has no segments', () => {
  assert.deepEqual(detectAirSegments({ timeMs: [0, 1000], lat: [47, 47], lon: [8, 8], gnssAlt: [1000, 1000] }), []);
});

// ---- height gained on foot --------------------------------------------------
test('hikingHeightGained: GPS jitter on foot is not a climb, and a flight is not a hike', () => {
  // Hike 360 m up at 0.3 m/s, stand on launch for half an hour, glide 360 m
  // down, walk on flat ground for ten minutes. The true gain on foot is 360 m.
  const s = new Script().leg(1200, HIKE, 0.3).leg(1800, 0);
  const launch = s.now;
  s.leg(300, GLIDE, -1.2);
  const landing = s.now;
  s.leg(600, HIKE, 0);
  const { timeMs, gnssAlt } = s.columns();
  // A tracker's GPS height wanders by a few metres from second to second.
  let seed = 7;
  const jittered = gnssAlt.map((a) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return a + (seed / 2 ** 31 - 0.5) * 8;
  });
  const onFoot = timeMs.map((_, i) => i <= launch || i >= landing);

  const gained = hikingHeightGained(timeMs, jittered, onFoot, 0);
  assert.ok(Math.abs(gained - 360) <= 20, `gained ${gained} m on foot, scripted 360`);
  // The old sum of positive 5 s deltas counts the jitter: well over double.
  let naive = 0;
  for (let i = 5; i < timeMs.length; i++) if (onFoot[i] && jittered[i] > jittered[i - 5]) naive += (jittered[i] - jittered[i - 5]) / 5;
  assert.ok(naive > 800, `the naive sum gives ${naive} m`);
  // Measured from the landing, the flat walk gains nothing.
  assert.ok(hikingHeightGained(timeMs, jittered, onFoot, landing) <= 10);
});

// ---- the hike-and-fly window ----------------------------------------------

/** Start cylinder at the first fix, goal 5.56 km north of it; both r=400 m; gate 13:00Z. */
function startToGoal(): XcTask {
  return parseXcTask(
    JSON.stringify({
      taskType: 'CLASSIC',
      sss: { type: 'RACE', direction: 'EXIT', timeGates: ['13:00:00Z'] },
      goal: { type: 'CYLINDER' },
      turnpoints: [
        { radius: 400, type: 'SSS', waypoint: { lat: 47, lon: 8, altSmoothed: 1000, description: '', name: 'START' } },
        { radius: 400, waypoint: { lat: 47.05, lon: 8, altSmoothed: 1000, description: '', name: 'GOAL' } },
      ],
    }),
  );
}

/** Wait at the start, hike 1800 m up, glide 3000 m down, then rest eight minutes
 * 4800 m out — 360 m short of the goal cylinder. */
function hikeFlyRest(): Script {
  return new Script().leg(120, 0).leg(1200, HIKE, 0.3).leg(300, GLIDE, -1.2).leg(480, 0);
}

test('hike and fly: a rest after landing does not end the task, and the time splits exactly', () => {
  const text = hikeFlyRest().leg(600, HIKE).igc(); // walks on into goal

  const f = new IgcFlight(text);
  f.buildCompMetrics(startToGoal(), 'hike-and-fly');
  assert.equal(f.stats.completed, true);
  assert.equal(f.stats.comp_remaining_distance, null);
  assert.equal(f.landingMs, null);
  assert.equal(f.stats.comp_flights, 1);
  assert.ok(Math.abs(num(f.stats.comp_secs_flying) - 300) <= 30, `flew ${f.stats.comp_secs_flying} s, scripted 300`);
  assert.ok(Math.abs(num(f.stats.comp_distance_flown) - 3000) <= 300, `flew ${f.stats.comp_distance_flown} m, scripted 3000`);
  assert.equal(
    num(f.stats.comp_seconds_after_gate) + num(f.stats.comp_secs_hiking) + num(f.stats.comp_secs_flying),
    f.stats.completion_time,
  );
  // A straight glide is all gliding, and the two flying states leave nothing over.
  assert.equal(num(f.stats.comp_secs_thermalling) + num(f.stats.comp_secs_gliding), f.stats.comp_secs_flying);
  assert.ok(num(f.stats.comp_secs_thermalling) <= 30, `thermalled ${f.stats.comp_secs_thermalling} s on a straight glide`);
  // Scripted at 1.5 m/s (5.4 km/h), but the eight-minute rest is time on foot too.
  const kmh = num(f.stats.comp_hiking_speed_kmh);
  assert.equal(kmh, (num(f.stats.comp_distance_hiked) / num(f.stats.comp_secs_hiking)) * 3.6);
  assert.ok(kmh > 3 && kmh < 5.4, `hiking speed ${kmh} km/h`);

  // The same track scored as an XC task stops at that rest: it is the landing
  // cut that hike and fly must not use.
  const xc = new IgcFlight(text);
  xc.buildCompMetrics(startToGoal());
  assert.equal(xc.stats.completed, false);
  assert.equal(xc.stats.comp_secs_flying, undefined);
});

test('hike and fly: the track is cut where the pilot gets into a vehicle', () => {
  const s = hikeFlyRest();
  const rideStart = s.now;
  const text = s.leg(120, 28, 0, 30).leg(300, 0).igc(); // driven through the goal cylinder

  const f = new IgcFlight(text);
  f.buildCompMetrics(startToGoal(), 'hike-and-fly');
  assert.equal(f.stats.completed, false, 'a drive into goal is not a finish');
  assert.ok(f.landingMs !== null);
  const cutS = (f.landingMs - Date.UTC(2026, 6, 7, 13, 0, 0)) / 1000;
  assert.ok(Math.abs(cutS - rideStart) <= 15, `cut at ${cutS} s, ride began at ${rideStart} s`);
  assert.equal(f.stats.comp_flights, 1, 'the ride is not counted as a flight');
  // Cut 4800 m out; the goal cylinder's edge is 360 m further on.
  const left = num(f.stats.comp_remaining_distance);
  assert.ok(Math.abs(left - 360) <= 30, `${left} m remaining, scripted 360`);
});

// ---- a real day -----------------------------------------------------------
const DAY = fileURLToPath(new URL('../public/archive/x-red-rocks-2025/day640/', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../src/archive-manifest.json', import.meta.url));

test('hike and fly: X Red Rocks 2025 day 640 splits into hiking and flying', { timeout: 240_000 }, (t) => {
  if (!existsSync(DAY + 'task.xctsk')) {
    t.skip('archive day not present');
    return;
  }
  const entry = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { comp: string; day: string; igcFiles: string[] }[]).find(
    (e) => e.comp === 'x-red-rocks-2025' && e.day === 'day640',
  )!;
  const comp = new Competition(readFileSync(DAY + 'task.xctsk', 'utf8'), -360, 'hike-and-fly', 'filename');
  for (const f of entry.igcFiles) comp.addPilot(readFileSync(DAY + f, 'utf8'), nameFromFile(f));

  // The field rides a shuttle to the start and stops there before the race.
  // The landing cut used to end every track at that stop, for no finishers.
  const finishers = comp.pilots.filter((p) => p.completed);
  assert.equal(finishers.length, 11);
  for (const p of finishers) {
    const s = p.stats;
    const total = num(s.comp_seconds_after_gate) + num(s.comp_secs_hiking) + num(s.comp_secs_flying);
    assert.ok(Math.abs(total - num(s.completion_time)) < 1e-6, `${p.name}: time does not split exactly`);
    // One to three flights each, and hours of both: the 50-minute shuttle
    // would be a fourth "flight" if it were counted.
    assert.ok(num(s.comp_flights) >= 1 && num(s.comp_flights) <= 3, `${p.name}: ${s.comp_flights} flights`);
    assert.ok(num(s.comp_secs_flying) > 2 * 3600 && num(s.comp_secs_flying) < 4 * 3600, `${p.name}: flew ${s.comp_secs_flying} s`);
    assert.ok(num(s.comp_secs_hiking) > 2 * 3600, `${p.name}: hiked ${s.comp_secs_hiking} s`);
    assert.ok(Math.abs(num(s.comp_secs_thermalling) + num(s.comp_secs_gliding) - num(s.comp_secs_flying)) < 1e-6);
    // Every column the table shows is a real stat: a mistyped key would
    // render as a full column of '—'. Remaining distance is the one a
    // finisher has no value for.
    for (const col of HIKE_AND_FLY_SUBSET.slice(1)) {
      if (col.key === 'comp_remaining_distance') assert.equal(s[col.key], null);
      else assert.ok(Number.isFinite(num(s[col.key])), `${p.name}: no value for ${col.key}`);
    }
    assert.ok(num(s.comp_hiking_speed_kmh) > 2 && num(s.comp_hiking_speed_kmh) < 8, `${p.name}: ${s.comp_hiking_speed_kmh} km/h`);
  }
  // The one non-finisher landed out with course still ahead of him.
  const dnf = comp.pilots.filter((p) => !p.completed);
  assert.equal(dnf.length, 1);
  assert.ok(num(dnf[0].stats.comp_remaining_distance) > 1000, `${dnf[0].name}: ${dnf[0].stats.comp_remaining_distance} m remaining`);
});
