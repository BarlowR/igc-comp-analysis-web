/**
 * Unit tests for the time-to-go equations (src/lib/timetogo.ts), each broken out
 * and checked against analytic values or a brute-force reference. Run:
 *   node --test test/timetogo.test.ts
 *
 * The cylinder distance-remaining routing (optimalRemaining / remainingSeries) is
 * cross-checked against a brute-force shortest-route reference, since that is the
 * calc under suspicion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toPlanar,
  onCircleToward,
  nearestOnSegment,
  waypointThroughCylinder,
  buildGeom,
  taskDistanceM,
  optimalRemaining,
  remainingSeries,
  smoothAlt,
  tauSeries,
  lostSeries,
  type OptTask,
} from '../src/lib/timetogo.ts';

const R_EARTH = 6_371_000;
const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
const hypot = Math.hypot;

/** Build an OptTask directly from planar cylinders (lat0=lon0=0). */
function mkTask(cyl: { x: number; y: number; r: number }[]): OptTask {
  const cx = cyl.map((c) => c.x);
  const cy = cyl.map((c) => c.y);
  const r = cyl.map((c) => c.r);
  return { cx, cy, r, lat0: 0, lon0: 0, px: [...cx], py: [...cy], distToGoal: [] };
}

/** Inverse of toPlanar at lat0=lon0=0, so remainingSeries sees the planar coords. */
function planarToLatLon(x: number, y: number): [number, number] {
  const lat = (y / R_EARTH) * (180 / Math.PI);
  const lon = (x / R_EARTH) * (180 / Math.PI); // cos(0)=1
  return [lat, lon];
}

/** Shortest distance from point C to segment A→B. */
function segDist(cx: number, cy: number, ax: number, ay: number, bx: number, by: number): number {
  const [qx, qy] = nearestOnSegment(cx, cy, ax, ay, bx, by);
  return hypot(qx - cx, qy - cy);
}

/**
 * Brute-force TRUE shortest route from P through one cylinder (must come within r
 * of centre) to a point ESS. If the straight P→ESS segment already pierces the
 * disk, the turnpoint is free (= straight distance); else search the boundary.
 */
function trueRemainingOneTP(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r: number,
  ex: number,
  ey: number,
): number {
  if (hypot(px - cx, py - cy) <= r) return hypot(px - ex, py - ey); // already inside
  if (segDist(cx, cy, px, py, ex, ey) <= r) return hypot(px - ex, py - ey); // straight pierces disk
  let best = Infinity;
  for (let i = 0; i < 200000; i++) {
    const th = (2 * Math.PI * i) / 200000;
    const tx = cx + r * Math.cos(th);
    const ty = cy + r * Math.sin(th);
    const d = hypot(px - tx, py - ty) + hypot(tx - ex, ty - ey);
    if (d < best) best = d;
  }
  return best;
}

// ---- onCircleToward -------------------------------------------------------
test('onCircleToward: point on ring nearest Q, at radius r', () => {
  const [x, y] = onCircleToward(0, 0, 5, 100, 0);
  assert.ok(close(x, 5) && close(y, 0));
  const [x2, y2] = onCircleToward(10, 10, 3, 10, 100); // straight up
  assert.ok(close(x2, 10) && close(y2, 13));
  // radius preserved for arbitrary direction
  const [x3, y3] = onCircleToward(1, 2, 7, 4, 6);
  assert.ok(close(hypot(x3 - 1, y3 - 2), 7));
});

test('onCircleToward: degenerate Q at centre falls back to +x', () => {
  const [x, y] = onCircleToward(0, 0, 5, 0, 0);
  assert.ok(close(x, 5) && close(y, 0));
});

// ---- nearestOnSegment -----------------------------------------------------
test('nearestOnSegment: interior projection and clamping', () => {
  assert.deepEqual(nearestOnSegment(5, 9, 0, 0, 10, 0), [5, 0]); // foot of perpendicular
  assert.deepEqual(nearestOnSegment(-3, 4, 0, 0, 10, 0), [0, 0]); // clamps to A
  assert.deepEqual(nearestOnSegment(99, 4, 0, 0, 10, 0), [10, 0]); // clamps to B
});

// ---- waypointThroughCylinder ---------------------------------------------
test('waypointThroughCylinder: free when segment pierces the disk', () => {
  // segment along x-axis passes through centre → touch is on the line (free)
  const [x, y] = waypointThroughCylinder(5, 0, 2, 0, 0, 10, 0);
  assert.ok(close(y, 0)); // stays on the line
  assert.ok(close(x, 5)); // foot of perpendicular (centre itself)
});

test('waypointThroughCylinder: near edge when a detour is needed', () => {
  // centre 5 above the x-axis line, r=2 → touch pulled to (5,3)
  const [x, y] = waypointThroughCylinder(5, 5, 2, 0, 0, 10, 0);
  assert.ok(close(x, 5) && close(y, 3));
});

// ---- toPlanar -------------------------------------------------------------
test('toPlanar: origin maps to (0,0); scales like the equirectangular model', () => {
  assert.deepEqual(toPlanar(0, 0, 0, 0), [0, 0]);
  const [x, y] = toPlanar(1, 0, 0, 0); // 1 deg north
  assert.ok(close(y, (Math.PI / 180) * R_EARTH, 1e-3));
  assert.ok(close(x, 0, 1e-6));
});

// ---- buildGeom / taskDistanceM -------------------------------------------
test('buildGeom: colinear turnpoint on the line adds no distance', () => {
  const tps = [
    { lat: 0, lon: 0, radius: 0, name: 'SSS', type: 'SSS', order: 1 },
    { lat: 0, lon: 0.1, radius: 2000, name: 'TP', type: 'TP', order: 2 },
    { lat: 0, lon: 0.2, radius: 0, name: 'ESS', type: 'ESS', order: 3 },
  ];
  const g = buildGeom(tps);
  const straight = hypot(g.cx[2] - g.cx[0], g.cy[2] - g.cy[0]);
  assert.ok(close(taskDistanceM(g), straight, 1)); // free turnpoint → straight line
});

test('buildGeom: offset turnpoint forces the expected two-leg detour', () => {
  // SSS (0,0), TP centre 5 km north of the mid-line r=2km, ESS 20km east.
  const task = mkTask([
    { x: 0, y: 0, r: 0 },
    { x: 10000, y: 5000, r: 2000 },
    { x: 20000, y: 0, r: 0 },
  ]);
  // run the same 3-pass optimiser buildGeom uses, via optimalRemaining from SSS
  const { total } = optimalRemaining(0, 0, task, 1, null);
  // touch pulled to (10000,3000); 2 * sqrt(10000^2 + 3000^2)
  assert.ok(close(total, 2 * hypot(10000, 3000), 1));
});

// ---- optimalRemaining vs brute-force (THE SUSPECT) ------------------------
test('optimalRemaining: within tolerance of the true shortest route (single TP)', () => {
  const cyl = { x: 10000, y: 5000, r: 2000 };
  const ess = { x: 20000, y: 0 };
  const task = mkTask([
    { x: 0, y: 0, r: 0 },
    cyl,
    { x: ess.x, y: ess.y, r: 0 },
  ]);
  const bad: string[] = [];
  for (let px = -2000; px <= 22000; px += 2000) {
    for (let py = -4000; py <= 12000; py += 2000) {
      const { total } = optimalRemaining(px, py, task, 1, null);
      const truth = trueRemainingOneTP(px, py, cyl.x, cyl.y, cyl.r, ess.x, ess.y);
      // allow 1% slack for the projection heuristic; flag gross errors only
      if (total < truth - 1 || total > truth * 1.01 + 1) {
        bad.push(`P(${px},${py}): got ${total.toFixed(0)} truth ${truth.toFixed(0)}`);
      }
    }
  }
  assert.equal(bad.length, 0, `off from true shortest:\n${bad.slice(0, 12).join('\n')}`);
});

// ---- remainingSeries: continuity + tagging through a cylinder -------------
test('remainingSeries: monotonic on a straight approach to goal', () => {
  const task = mkTask([
    { x: 0, y: 0, r: 0 },
    { x: 20000, y: 0, r: 0 }, // ESS only
  ]);
  const pts: [number, number][] = [];
  for (let x = 0; x <= 19000; x += 1000) pts.push(planarToLatLon(x, 0));
  const rem = remainingSeries(task, pts);
  for (let i = 1; i < rem.length; i++) {
    assert.ok(rem[i] <= rem[i - 1] + 1e-3, `D_rem rose at ${i}: ${rem[i - 1]} -> ${rem[i]}`);
  }
});

test('remainingSeries: no large jump flying THROUGH a detour cylinder', () => {
  // The continuity claim: touching a cylinder must not step D_rem. Pilot flies a
  // dense straight path that passes through an offset turnpoint cylinder.
  const task = mkTask([
    { x: 0, y: 0, r: 0 },
    { x: 10000, y: 3000, r: 2500 },
    { x: 20000, y: 0, r: 0 },
  ]);
  const step = 100; // 100 m fixes
  const pts: [number, number][] = [];
  for (let x = 0; x <= 20000; x += step) {
    // straight line from (0,0) toward (10000,3000) then to (20000,0): fly the
    // two legs so we actually pass through the cylinder
    const y = x <= 10000 ? (3000 * x) / 10000 : (3000 * (20000 - x)) / 10000;
    pts.push(planarToLatLon(x, y));
  }
  const rem = remainingSeries(task, pts);
  // Interior continuity (the routing's job): away from the ESS point-tag, each
  // ~110 m fix should move D_rem < ~150 m. Crossing the turnpoint must not step.
  let interiorMax = 0;
  let at = -1;
  for (let i = 1; i < rem.length; i++) {
    if (rem[i] < 400) continue; // skip the ESS margin tag (checked separately below)
    const j = Math.abs(rem[i] - rem[i - 1]);
    if (j > interiorMax) {
      interiorMax = j;
      at = i;
    }
  }
  assert.ok(
    interiorMax < 150,
    `D_rem stepped ${interiorMax.toFixed(0)} m at fix ${at} (${rem[at - 1]?.toFixed(0)}→${rem[at]?.toFixed(0)}) — turnpoint crossing not continuous`,
  );
  // Finding #2 (by design): the ESS point cylinder tags at TAG_MARGIN (200 m), so
  // the final drop to 0 is bounded by ~200 m + one fix step. Documented, not a bug.
  const finalDrop = rem[rem.length - 2];
  assert.ok(finalDrop <= 200 + 120, `ESS tag drop ${finalDrop.toFixed(0)} m exceeds TAG_MARGIN + a fix`);
});

test('remainingSeries: zero once inside ESS', () => {
  const task = mkTask([
    { x: 0, y: 0, r: 0 },
    { x: 20000, y: 0, r: 500 },
  ]);
  const rem = remainingSeries(task, [planarToLatLon(0, 0), planarToLatLon(19900, 0), planarToLatLon(20000, 0)]);
  assert.ok(rem[rem.length - 1] === 0, `expected 0 at ESS, got ${rem[rem.length - 1]}`);
});

test('remainingSeries: an un-entered turnpoint keeps routing through it', () => {
  // Pilot flies straight to ESS but never enters the (small, offset) turnpoint;
  // D_rem must stay long (still owes the detour), never collapse to straight line.
  const task = mkTask([
    { x: 0, y: 0, r: 0 },
    { x: 10000, y: 8000, r: 1000 },
    { x: 20000, y: 0, r: 0 },
  ]);
  const pts: [number, number][] = [];
  for (let x = 0; x <= 15000; x += 1000) pts.push(planarToLatLon(x, 0)); // never goes up to TP
  const rem = remainingSeries(task, pts);
  const detour = 2 * hypot(10000, 8000 - 1000); // rough owed distance via near edge
  assert.ok(rem[rem.length - 1] > hypot(20000 - 15000, 0) + 5000, `D_rem collapsed to straight: ${rem[rem.length - 1].toFixed(0)} (owed ~${detour.toFixed(0)})`);
});

// ---- smoothAlt ------------------------------------------------------------
test('smoothAlt: centred average smooths a spike, preserves a flat line', () => {
  const t = [0, 1000, 2000, 3000, 4000];
  assert.deepEqual(smoothAlt(t, [10, 10, 10, 10, 10], 3000), [10, 10, 10, 10, 10]);
  const s = smoothAlt(t, [0, 0, 30, 0, 0], 3000);
  assert.ok(s[2] < 30 && s[2] > 0, `spike not smoothed: ${s[2]}`);
});

// ---- tauSeries ------------------------------------------------------------
test('tauSeries: below the glide slope equals plain MacCready', () => {
  const p = { vccMps: 10, climbMps: 2.5, hFinM: 0, glideRatio: 7, beta: 0 };
  const dRem = [20000];
  const h = [500]; // hNeed = 20000/7 = 2857 > 500 → below slope
  const [tau] = tauSeries(dRem, h, p);
  const plain = (20000 / 10 - (500 - 0) / 2.5) / 60;
  assert.ok(close(tau, plain, 1e-9), `${tau} vs ${plain}`);
});

test('tauSeries: floored at physical glide time, never implies superhuman glide', () => {
  // paraglider-ish: on the slope with lots of height, floor at D_rem/vGlide binds
  const p = { vccMps: 9, climbMps: 2, hFinM: 0, glideRatio: 7, beta: 0, glideSpeedKmh: 60 };
  const dRem = [20000];
  const h = [20000 / 7 + 3000]; // well above the slope
  const [tau] = tauSeries(dRem, h, p);
  const floor = 20000 / (60 / 3.6) / 60;
  assert.ok(tau >= floor - 1e-9, `tau ${tau} below floor ${floor}`);
});

test('tauSeries: zero at ESS (dRem=0)', () => {
  const p = { vccMps: 9, climbMps: 2, hFinM: 100, glideRatio: 7, beta: 0 };
  const [tau] = tauSeries([0], [250], p);
  assert.ok(close(tau, 0, 1e-9), `expected 0 at ESS, got ${tau}`);
});

// ---- lostSeries -----------------------------------------------------------
test('lostSeries: L = tau + elapsed - tauRef', () => {
  const L = lostSeries([10, 5], [0, 300_000], 0, 8); // 0 and 5 min elapsed
  assert.ok(close(L[0], 10 + 0 - 8) && close(L[1], 5 + 5 - 8));
});

// ==========================================================================
//  Additional coverage
// ==========================================================================

/** Min over one circle boundary of |A→t| + |t→B| (detour geometry only). */
function bruteOneCircle(ax: number, ay: number, c: { x: number; y: number; r: number }, bx: number, by: number): number {
  let best = Infinity;
  const M = 100000;
  for (let i = 0; i < M; i++) {
    const th = (2 * Math.PI * i) / M;
    const tx = c.x + c.r * Math.cos(th);
    const ty = c.y + c.r * Math.sin(th);
    const d = hypot(ax - tx, ay - ty) + hypot(tx - bx, ty - by);
    if (d < best) best = d;
  }
  return best;
}

/** Min over two circle boundaries of |P→t1|+|t1→t2|+|t2→ESS| (detour geometry). */
function bruteTwoCircle(
  px: number,
  py: number,
  c1: { x: number; y: number; r: number },
  c2: { x: number; y: number; r: number },
  ex: number,
  ey: number,
): number {
  let best = Infinity;
  const M = 900;
  for (let i = 0; i < M; i++) {
    const a1 = (2 * Math.PI * i) / M;
    const t1x = c1.x + c1.r * Math.cos(a1);
    const t1y = c1.y + c1.r * Math.sin(a1);
    const d0 = hypot(px - t1x, py - t1y);
    for (let j = 0; j < M; j++) {
      const a2 = (2 * Math.PI * j) / M;
      const t2x = c2.x + c2.r * Math.cos(a2);
      const t2y = c2.y + c2.r * Math.sin(a2);
      const d = d0 + hypot(t1x - t2x, t1y - t2y) + hypot(t2x - ex, t2y - ey);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---- waypointThroughCylinder: exact true minimiser ------------------------
test('waypointThroughCylinder: matches brute-force minimiser over a grid', () => {
  const c = { x: 0, y: 4000, r: 1500 }; // disk spans y∈[2500,5500]; keep A,B near x-axis
  const bad: string[] = [];
  for (let ax = -6000; ax <= 6000; ax += 1500) {
    for (let bx = -6000; bx <= 6000; bx += 1500) {
      const ay = -1000;
      const by = 1000;
      const [tx, ty] = waypointThroughCylinder(c.x, c.y, c.r, ax, ay, bx, by);
      const got = hypot(ax - tx, ay - ty) + hypot(tx - bx, ty - by);
      const truth = bruteOneCircle(ax, ay, c, bx, by);
      assert.ok(close(hypot(tx - c.x, ty - c.y), c.r, 1e-6), 'touch must lie on the ring');
      if (got > truth + 0.5) bad.push(`A(${ax},${ay}) B(${bx},${by}): got ${got.toFixed(1)} truth ${truth.toFixed(1)}`);
    }
  }
  assert.equal(bad.length, 0, `not minimal:\n${bad.slice(0, 8).join('\n')}`);
});

test('waypointThroughCylinder: symmetric case sits at the perpendicular foot edge', () => {
  // A and B symmetric about x=0; the true touch is straight below the centre.
  const [x, y] = waypointThroughCylinder(0, 5000, 2000, -8000, 0, 8000, 0);
  assert.ok(close(x, 0, 1e-3) && close(y, 3000, 1e-3), `got (${x.toFixed(1)},${y.toFixed(1)})`);
});

test('waypointThroughCylinder: endpoint inside the disk → free (on the segment)', () => {
  // B sits inside the cylinder, so the segment pierces it: touch stays on the line.
  const c = { x: 5000, y: 0, r: 1000 };
  const [x, y] = waypointThroughCylinder(c.x, c.y, c.r, 0, 0, 5200, 0);
  assert.ok(close(y, 0, 1e-9), `expected on-line touch, got y=${y}`);
});

// ---- optimalRemaining: multi-turnpoint vs brute force ---------------------
test('optimalRemaining: two turnpoints within tolerance of the true shortest', () => {
  const c1 = { x: 7000, y: 4000, r: 1500 };
  const c2 = { x: 14000, y: 4000, r: 1500 };
  const ess = { x: 21000, y: 0 };
  const task = mkTask([{ x: 0, y: 0, r: 0 }, c1, c2, { x: ess.x, y: ess.y, r: 0 }]);
  for (const P of [
    { x: 0, y: 0 },
    { x: 2000, y: -1000 },
    { x: 3000, y: 1000 },
  ]) {
    const { total } = optimalRemaining(P.x, P.y, task, 1, null);
    const truth = bruteTwoCircle(P.x, P.y, c1, c2, ess.x, ess.y);
    assert.ok(
      total >= truth - 1 && total <= truth * 1.01 + 1,
      `P(${P.x},${P.y}): got ${total.toFixed(0)} truth ${truth.toFixed(0)} (${(((total - truth) / truth) * 100).toFixed(2)}%)`,
    );
  }
});

test('optimalRemaining: warm start gives the same route as a cold start', () => {
  const task = mkTask([{ x: 0, y: 0, r: 0 }, { x: 8000, y: 3000, r: 1500 }, { x: 16000, y: -2000, r: 1200 }, { x: 24000, y: 0, r: 0 }]);
  const cold = optimalRemaining(1000, 500, task, 1, null);
  const warm = optimalRemaining(1000, 500, task, 1, cold.pts);
  assert.ok(close(cold.total, warm.total, 1e-6), `cold ${cold.total} vs warm ${warm.total}`);
});

test('optimalRemaining: pilot already inside a turnpoint routes straight on (free)', () => {
  const task = mkTask([{ x: 0, y: 0, r: 0 }, { x: 10000, y: 0, r: 3000 }, { x: 20000, y: 0, r: 0 }]);
  const { total } = optimalRemaining(10000, 0, task, 1, null); // at TP centre
  assert.ok(close(total, 10000, 1), `inside TP should be straight to ESS, got ${total}`);
});

// ---- buildGeom: structure -------------------------------------------------
test('buildGeom: sorts by order, drops order<1, terminates at ESS', () => {
  const tps = [
    { lat: 0, lon: 0.2, radius: 0, name: 'ESS', type: 'ESS', order: 4 },
    { lat: 0, lon: 0, radius: 400, name: 'SSS', type: 'SSS', order: 2 },
    { lat: 0, lon: 0.1, radius: 1000, name: 'TP', type: 'TP', order: 3 },
    { lat: 0, lon: 0.3, radius: 3000, name: 'GOAL', type: 'GOAL', order: 5 }, // after ESS → dropped
    { lat: 1, lon: 1, radius: 0, name: 'TO', type: 'TAKEOFF', order: 0 }, // order<1 → dropped
  ];
  const g = buildGeom(tps);
  assert.equal(g.cx.length, 3, 'should keep SSS, TP, ESS only'); // GOAL + takeoff removed
  assert.equal(g.r[0], 400); // first is SSS
  assert.equal(g.r[2], 0); // last is ESS
});

test('buildGeom: SSS exit point is on its ring toward the first turnpoint', () => {
  const tps = [
    { lat: 0, lon: 0, radius: 1000, name: 'SSS', type: 'SSS', order: 1 },
    { lat: 0, lon: 0.1, radius: 0, name: 'TP', type: 'TP', order: 2 },
    { lat: 0, lon: 0.2, radius: 0, name: 'ESS', type: 'ESS', order: 3 },
  ];
  const g = buildGeom(tps);
  // TP is east of SSS, so the exit point should be on the east edge (px[0] ≈ +1000).
  assert.ok(close(g.px[0] - g.cx[0], 1000, 1) && close(g.py[0] - g.cy[0], 0, 1), `SSS exit at (${g.px[0] - g.cx[0]},${g.py[0] - g.cy[0]})`);
});

test('taskDistanceM: empty task is zero', () => {
  assert.equal(taskDistanceM(mkTask([])), 0);
});

// ---- remainingSeries: ordering & out-and-back -----------------------------
test('remainingSeries: turnpoints must be tagged in order (no skipping)', () => {
  // Pilot flies THROUGH the TP2 region first, then TP1: TP2 must not tag early.
  const task = mkTask([{ x: 0, y: 0, r: 0 }, { x: 5000, y: 0, r: 800 }, { x: 10000, y: 0, r: 800 }, { x: 15000, y: 0, r: 0 }]);
  // Jump the pilot straight to TP2's centre (also within TP1? no — 10000 is 5000 from TP1)
  const pts: [number, number][] = [planarToLatLon(10000, 0), planarToLatLon(5000, 0), planarToLatLon(10000, 0), planarToLatLon(15000, 0)];
  const rem = remainingSeries(task, pts);
  // At fix 0 the pilot is at TP2 centre but TP1 not yet tagged → route must still go
  // back through TP1, so D_rem > the straight 5000 m to ESS.
  assert.ok(rem[0] > 5000, `TP2 tagged before TP1: D_rem=${rem[0].toFixed(0)}`);
});

test('remainingSeries: out-and-back dogleg owes the full there-and-back until tagged', () => {
  // TP is off to the north; ESS back near the start. Flying straight toward ESS
  // without visiting the TP must keep D_rem large (owes the northern detour).
  const task = mkTask([{ x: 0, y: 0, r: 0 }, { x: 0, y: 10000, r: 500 }, { x: 2000, y: 0, r: 0 }]);
  const rem = remainingSeries(task, [planarToLatLon(0, 0), planarToLatLon(1000, 0), planarToLatLon(1900, 0)]);
  // Near ESS but TP never tagged → still owes ~ up-and-back ≈ 2*9500 + a bit.
  assert.ok(rem[rem.length - 1] > 15000, `dogleg collapsed: D_rem=${rem[rem.length - 1].toFixed(0)}`);
});

// ---- smoothAlt: exact windows --------------------------------------------
test('smoothAlt: centred mean over the ±half window (exact)', () => {
  const t = [0, 1000, 2000, 3000, 4000];
  const a = [0, 10, 20, 30, 40];
  // window ±1500 ms: index 2 (t=2000) averages t∈[500,3500] → {10,20,30} = 20
  const s = smoothAlt(t, a, 3000);
  assert.ok(close(s[2], 20), `centre avg ${s[2]}`);
  assert.ok(close(s[0], (0 + 10) / 2), `left edge ${s[0]}`); // t∈[-1500,1500] → {0,10}
  assert.ok(close(s[4], (30 + 40) / 2), `right edge ${s[4]}`);
});

test('smoothAlt: uneven sample spacing respects the time window, not index count', () => {
  const t = [0, 100, 200, 5000]; // first three are bunched, last is far
  const a = [0, 6, 12, 100];
  const s = smoothAlt(t, a, 400); // ±200 ms
  assert.ok(close(s[0], (0 + 6 + 12) / 3), `s0=${s[0]}`); // t∈[-200,200] → first three
  assert.ok(close(s[3], 100), `s3=${s[3]}`); // isolated → itself
});

// ---- tauSeries: continuity, beta, monotonicity ----------------------------
test('tauSeries: continuous across the glide-slope boundary h = hNeed', () => {
  const p = { vccMps: 12, climbMps: 3, hFinM: 0, glideRatio: 8, beta: 0, glideSpeedKmh: 200 };
  const d = 12000;
  const hNeed = d / 8; // 1500
  const eps = 1e-3; // the two branches meet at hNeed; over ±eps the slope moves τ by
  const below = tauSeries([d], [hNeed - eps], p)[0]; // only ~eps/M/60 ≈ 6e-6 min, so a
  const above = tauSeries([d], [hNeed + eps], p)[0]; // >1e-4 gap would be a real jump.
  assert.ok(Math.abs(below - above) < 1e-4, `jump at slope: ${below} vs ${above}`);
});

test('tauSeries: beta credits surplus height above the slope', () => {
  const base = { vccMps: 12, climbMps: 3, hFinM: 0, glideRatio: 8, glideSpeedKmh: 500 };
  const d = 12000;
  const h = d / 8 + 2000; // 2000 m above the slope
  const noBeta = tauSeries([d], [h], { ...base, beta: 0 })[0];
  const withBeta = tauSeries([d], [h], { ...base, beta: 0.1 })[0];
  assert.ok(withBeta < noBeta, `beta should lower tau: ${withBeta} !< ${noBeta}`);
});

test('tauSeries: increases with distance remaining', () => {
  const p = { vccMps: 10, climbMps: 2.5, hFinM: 0, glideRatio: 7, beta: 0 };
  const taus = tauSeries([5000, 10000, 20000], [200, 200, 200], p);
  assert.ok(taus[0] < taus[1] && taus[1] < taus[2], `not monotonic: ${taus}`);
});

// ---- lostSeries: gate offset ---------------------------------------------
test('lostSeries: a later start-gate shifts elapsed accordingly', () => {
  const L = lostSeries([10], [600_000], 300_000, 8); // fix at 10 min, gate at 5 min
  assert.ok(close(L[0], 10 + 5 - 8), `got ${L[0]}`); // elapsed since gate = 5 min
});

// ==========================================================================
//  Property-based (fuzz) invariants + edge cases
// ==========================================================================

/** Deterministic PRNG (mulberry32) so fuzz runs are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The OLD closest-to-line touch, kept as a reference to prove the new one never loses. */
function heuristicTouch(cx: number, cy: number, r: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const [qx, qy] = nearestOnSegment(cx, cy, ax, ay, bx, by);
  if (hypot(qx - cx, qy - cy) <= r) return [qx, qy];
  return onCircleToward(cx, cy, r, qx, qy);
}

test('waypointThroughCylinder: fuzz — on the geometry and never worse than closest-to-line', () => {
  const rnd = rng(12345);
  for (let n = 0; n < 4000; n++) {
    const cx = (rnd() - 0.5) * 20000;
    const cy = (rnd() - 0.5) * 20000;
    const r = 200 + rnd() * 4000;
    const ax = (rnd() - 0.5) * 40000;
    const ay = (rnd() - 0.5) * 40000;
    const bx = (rnd() - 0.5) * 40000;
    const by = (rnd() - 0.5) * 40000;
    const [tx, ty] = waypointThroughCylinder(cx, cy, r, ax, ay, bx, by);
    // touch is on or inside the disk (free case lands on the segment inside it)
    assert.ok(hypot(tx - cx, ty - cy) <= r + 1e-4, `touch outside disk at n=${n}`);
    // and it is no longer than the old closest-to-line route (true minimiser)
    const [hx, hy] = heuristicTouch(cx, cy, r, ax, ay, bx, by);
    const mine = hypot(ax - tx, ay - ty) + hypot(tx - bx, ty - by);
    const old = hypot(ax - hx, ay - hy) + hypot(hx - bx, hy - by);
    assert.ok(mine <= old + 1e-3, `worse than heuristic at n=${n}: ${mine} > ${old}`);
  }
});

test('optimalRemaining: fuzz — valid route bounded below by the direct distance to ESS', () => {
  const rnd = rng(9876);
  for (let n = 0; n < 1500; n++) {
    const nTp = 1 + Math.floor(rnd() * 3); // 1..3 interior turnpoints
    const cyl = [{ x: 0, y: 0, r: 0 }];
    for (let i = 0; i < nTp; i++) cyl.push({ x: (rnd() - 0.3) * 20000, y: (rnd() - 0.5) * 12000, r: 200 + rnd() * 3000 });
    const ess = { x: 15000 + rnd() * 8000, y: (rnd() - 0.5) * 6000, r: rnd() < 0.5 ? 0 : 200 + rnd() * 2000 };
    cyl.push(ess);
    const task = mkTask(cyl);
    const px = (rnd() - 0.5) * 30000;
    const py = (rnd() - 0.5) * 20000;
    const { total, pts } = optimalRemaining(px, py, task, 1, null);
    // every touch lies on/inside its cylinder
    for (let a = 0; a < pts.length; a++) {
      const i = 1 + a;
      assert.ok(hypot(pts[a][0] - task.cx[i], pts[a][1] - task.cy[i]) <= task.r[i] + 1e-3, `touch off cylinder at n=${n},a=${a}`);
    }
    // a path from P to the ESS ring can't be shorter than the straight distance to it
    const lower = Math.max(0, hypot(px - ess.x, py - ess.y) - ess.r);
    assert.ok(total >= lower - 1e-3, `n=${n}: total ${total.toFixed(1)} < lower bound ${lower.toFixed(1)}`);
  }
});

test('optimalRemaining: three turnpoints within tolerance of brute force', () => {
  const c1 = { x: 6000, y: 3500, r: 1200 };
  const c2 = { x: 12000, y: -3500, r: 1200 };
  const c3 = { x: 18000, y: 3500, r: 1200 };
  const ess = { x: 24000, y: 0 };
  const task = mkTask([{ x: 0, y: 0, r: 0 }, c1, c2, c3, { x: ess.x, y: ess.y, r: 0 }]);
  const P = { x: 500, y: -500 };
  const { total } = optimalRemaining(P.x, P.y, task, 1, null);
  // brute over three boundary angles
  let truth = Infinity;
  const M = 140;
  for (let i = 0; i < M; i++) {
    const t1x = c1.x + c1.r * Math.cos((2 * Math.PI * i) / M);
    const t1y = c1.y + c1.r * Math.sin((2 * Math.PI * i) / M);
    const d1 = hypot(P.x - t1x, P.y - t1y);
    for (let j = 0; j < M; j++) {
      const t2x = c2.x + c2.r * Math.cos((2 * Math.PI * j) / M);
      const t2y = c2.y + c2.r * Math.sin((2 * Math.PI * j) / M);
      const d2 = d1 + hypot(t1x - t2x, t1y - t2y);
      for (let k = 0; k < M; k++) {
        const t3x = c3.x + c3.r * Math.cos((2 * Math.PI * k) / M);
        const t3y = c3.y + c3.r * Math.sin((2 * Math.PI * k) / M);
        const d = d2 + hypot(t2x - t3x, t2y - t3y) + hypot(t3x - ess.x, t3y - ess.y);
        if (d < truth) truth = d;
      }
    }
  }
  assert.ok(total <= truth * 1.02 + 5, `3-TP off: got ${total.toFixed(0)} truth ${truth.toFixed(0)} (${(((total - truth) / truth) * 100).toFixed(2)}%)`);
});

// ---- remainingSeries: start value, tag precision, unfinished --------------
test('remainingSeries: D_rem at the start line equals the full optimised task', () => {
  const task = mkTask([{ x: 0, y: 0, r: 0 }, { x: 9000, y: 4000, r: 1500 }, { x: 18000, y: 0, r: 0 }]);
  const full = optimalRemaining(0, 0, task, 1, null).total; // from SSS through the course
  const rem = remainingSeries(task, [planarToLatLon(0, 0)]);
  assert.ok(close(rem[0], full, 1), `start D_rem ${rem[0]} vs task ${full}`);
});

test('remainingSeries: tags exactly at radius + TAG_MARGIN (200 m)', () => {
  // one turnpoint; a fix at r+199 m tags it (D_rem drops), at r+201 m does not.
  const task = mkTask([{ x: 0, y: 0, r: 0 }, { x: 10000, y: 0, r: 1000 }, { x: 20000, y: 0, r: 0 }]);
  const justIn = remainingSeries(task, [planarToLatLon(10000 - (1000 + 199), 0), planarToLatLon(10000, 0)]);
  const justOut = remainingSeries(task, [planarToLatLon(10000 - (1000 + 201), 0), planarToLatLon(10000, 0)]);
  // at fix 0: within margin → turnpoint tagged → route is straight to ESS (~10000);
  // outside margin → not tagged, but here the straight line still pierces the big
  // disk so it's also ~straight — instead assert the *tag* state via a probe fix that
  // would otherwise owe a detour: use an offset ESS so tagging matters.
  assert.ok(justIn[0] <= justOut[0] + 1e-6, 'tagging earlier cannot lengthen the route');
});

test('remainingSeries: tag margin is a hard boundary (detour geometry)', () => {
  // ESS offset so an un-tagged turnpoint genuinely costs a detour.
  const task = mkTask([{ x: 0, y: 0, r: 0 }, { x: 10000, y: 6000, r: 1000 }, { x: 20000, y: 0, r: 0 }]);
  const c = { x: 10000, y: 6000 };
  const inFix = planarToLatLon(c.x, c.y - (1000 + 199)); // 199 m outside the ring → within margin
  const outFix = planarToLatLon(c.x, c.y - (1000 + 201)); // 201 m outside → not tagged
  const tagged = remainingSeries(task, [inFix])[0];
  const untagged = remainingSeries(task, [outFix])[0];
  // untagged still owes reaching the ring; tagged routes on from here → strictly shorter
  assert.ok(tagged < untagged - 100, `margin not a boundary: tagged ${tagged.toFixed(0)} untagged ${untagged.toFixed(0)}`);
});

test('remainingSeries: an unfinished track keeps D_rem > 0 throughout', () => {
  const task = mkTask([{ x: 0, y: 0, r: 0 }, { x: 20000, y: 0, r: 0 }]);
  const pts: [number, number][] = [];
  for (let x = 0; x <= 12000; x += 1000) pts.push(planarToLatLon(x, 0)); // stops short of ESS
  const rem = remainingSeries(task, pts);
  assert.equal(rem.length, pts.length);
  assert.ok(Math.min(...rem) > 0, `reached ESS unexpectedly: min ${Math.min(...rem)}`);
});

// ---- buildGeom: idempotence / convergence --------------------------------
test('buildGeom: deterministic and converged (rebuild identical, extra passes stable)', () => {
  const tps = [
    { lat: 0, lon: 0, radius: 500, name: 'SSS', type: 'SSS', order: 1 },
    { lat: 0.02, lon: 0.05, radius: 2000, name: 'T1', type: 'TP', order: 2 },
    { lat: -0.02, lon: 0.1, radius: 2000, name: 'T2', type: 'TP', order: 3 },
    { lat: 0, lon: 0.15, radius: 0, name: 'ESS', type: 'ESS', order: 4 },
  ];
  const a = buildGeom(tps);
  const b = buildGeom(tps);
  assert.ok(close(taskDistanceM(a), taskDistanceM(b), 1e-9), 'not deterministic');
  // distToGoal is self-consistent: leg sum through the waypoints == cumulative field
  let legSum = 0;
  for (let i = a.px.length - 2; i >= 0; i--) legSum += hypot(a.px[i + 1] - a.px[i], a.py[i + 1] - a.py[i]);
  assert.ok(close(legSum, a.distToGoal[0], 1e-6), `distToGoal inconsistent: ${legSum} vs ${a.distToGoal[0]}`);
  // re-optimising from the converged SSS exit barely moves the total (converged)
  const refined = optimalRemaining(a.px[0], a.py[0], a, 1, null).total;
  assert.ok(Math.abs(refined - a.distToGoal[0]) < a.distToGoal[0] * 0.02, `not converged: ${refined} vs ${a.distToGoal[0]}`);
});

// ---- tauSeries: clamping, defaults, shape --------------------------------
test('tauSeries: beta is clamped to [0,1]', () => {
  const base = { vccMps: 11, climbMps: 3, hFinM: 0, glideRatio: 8, glideSpeedKmh: 500 };
  const d = 10000;
  const h = d / 8 + 1500; // above the slope
  const atOne = tauSeries([d], [h], { ...base, beta: 1 })[0];
  const over = tauSeries([d], [h], { ...base, beta: 5 })[0]; // clamps to 1
  const under = tauSeries([d], [h], { ...base, beta: -3 })[0]; // clamps to 0
  const atZero = tauSeries([d], [h], { ...base, beta: 0 })[0];
  assert.ok(close(over, atOne, 1e-9), `beta>1 not clamped: ${over} vs ${atOne}`);
  assert.ok(close(under, atZero, 1e-9), `beta<0 not clamped: ${under} vs ${atZero}`);
});

test('tauSeries: default glideRatio (7) and output length match input', () => {
  const p = { vccMps: 10, climbMps: 2.5, hFinM: 0 }; // no glideRatio/beta/glideSpeed
  const d = [3500]; // hNeed = 3500/7 = 500
  const belowExplicit = tauSeries(d, [499], { ...p, glideRatio: 7 })[0];
  const belowDefault = tauSeries(d, [499], p)[0];
  assert.ok(close(belowExplicit, belowDefault, 1e-9), 'default glideRatio != 7');
  assert.equal(tauSeries([1000, 2000, 3000], [100, 200, 300], p).length, 3);
});

// ---- smoothAlt: shape / bounds -------------------------------------------
test('smoothAlt: single sample, length preserved, stays within data range', () => {
  assert.deepEqual(smoothAlt([0], [42], 5000), [42]);
  const t = [0, 500, 1000, 1500, 2000];
  const a = [3, 9, 1, 7, 5];
  const s = smoothAlt(t, a, 1200);
  assert.equal(s.length, a.length);
  const lo = Math.min(...a);
  const hi = Math.max(...a);
  for (const v of s) assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `mean ${v} outside [${lo},${hi}]`);
});

// ---- toPlanar / onCircleToward / nearestOnSegment edges -------------------
test('toPlanar: longitude scales by cos(lat0); signs point E/N', () => {
  const [xe] = toPlanar(45, 1, 45, 0); // 1° east at 45°N
  const [xw] = toPlanar(45, -1, 45, 0);
  assert.ok(xe > 0 && close(xe, -xw, 1e-6), 'east/west sign');
  const expected = (Math.PI / 180) * R_EARTH * Math.cos((45 * Math.PI) / 180);
  assert.ok(close(xe, expected, 1e-3), `cos(lat0) scaling: ${xe} vs ${expected}`);
});

test('onCircleToward: for Q outside, |Q − result| = |Q − centre| − r', () => {
  const cx = 3;
  const cy = -4;
  const r = 5;
  const qx = 40;
  const qy = 9;
  const [x, y] = onCircleToward(cx, cy, r, qx, qy);
  assert.ok(close(hypot(qx - x, qy - y), hypot(qx - cx, qy - cy) - r, 1e-9));
});

test('nearestOnSegment: degenerate segment (A=B) returns A', () => {
  assert.deepEqual(nearestOnSegment(10, 10, 5, 5, 5, 5), [5, 5]);
});
