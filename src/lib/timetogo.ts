/**
 * Time-to-go metric (build-time + client). Ports analysis/progress_prototype.py,
 * using the FAI/airscore task-optimisation model (`find_closest`).
 *
 * `buildGeom` optimises the whole task route ONCE (airscore `find_shortest_route`:
 * 3 refinement passes, each turnpoint placed at the point on its cylinder nearest
 * the line joining its neighbours' current points, or left inside when that line
 * already crosses the cylinder). `remainingSeries` then computes D_rem per fix by
 * RE-OPTIMISING the shortest route from the pilot's current position through the
 * un-tagged cylinders to ESS (warm-started from the previous fix). Re-optimising
 * each fix is what keeps D_rem continuous across cylinder tags — a cylinder you
 * sit on the edge of is touched for free, so there is no step even at a huge
 * cylinder — while still penalising off-course flying (the route lengthens as you
 * drift sideways).
 *
 * `tauSeries` turns D_rem + smoothed height into "time-to-go at par" (minutes),
 * with a final-glide cap on the height credit (see its doc). `lostSeries` detrends
 * that into "minutes behind the par ghost".
 */
import type { MapTurnpoint } from './competition';

const R_EARTH = 6_371_000;
// Tag margin (m): a cylinder counts as reached when a fix comes within radius +
// this. Downsampled tracks can graze a turnpoint edge with the nearest fix a few
// metres outside even though the flown path went in (e.g. an 8 m miss on a 3 km
// cylinder for a pilot who made goal), which would otherwise strand their D_rem.
const TAG_MARGIN_M = 200;

/** Equirectangular projection to local metres about (lat0, lon0). */
export function toPlanar(lat: number, lon: number, lat0: number, lon0: number): [number, number] {
  const x = ((lon - lon0) * Math.PI) / 180 * Math.cos((lat0 * Math.PI) / 180) * R_EARTH;
  const y = ((lat - lat0) * Math.PI) / 180 * R_EARTH;
  return [x, y];
}

export interface OptTask {
  cx: number[]; // cylinder centres in local metres (index 0 = SSS, last = ESS)
  cy: number[];
  r: number[];
  lat0: number;
  lon0: number;
  px: number[]; // optimised point on each cylinder (the shortest-route waypoints)
  py: number[];
  distToGoal: number[]; // optimised distance from optimised point i to ESS
}

/** Point on cylinder (cx,cy,r) nearest the point Q; unit direction falls back to +x. */
export function onCircleToward(cx: number, cy: number, r: number, qx: number, qy: number): [number, number] {
  const dx = qx - cx;
  const dy = qy - cy;
  const d = Math.hypot(dx, dy);
  return d > 1e-9 ? [cx + (r * dx) / d, cy + (r * dy) / d] : [cx + r, cy];
}

/** Closest point on segment A→B to point C (t clamped to [0,1]). */
export function nearestOnSegment(
  cx: number,
  cy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): [number, number] {
  const abx = bx - ax;
  const aby = by - ay;
  const l2 = abx * abx + aby * aby;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((cx - ax) * abx + (cy - ay) * aby) / l2)) : 0;
  return [ax + t * abx, ay + t * aby];
}

/**
 * Waypoint on cylinder (cx,cy,r) for a route A → (touch) → B: the point on the
 * cylinder that minimises the flown distance |A→t| + |t→B| (the true shortest
 * route through the cylinder), NOT the point closest to the straight A–B line.
 *
 * When the A–B segment already pierces the disk the turnpoint costs nothing —
 * the touch is the on-line point (free). Otherwise the minimum lies on the near
 * arc; we bracket it with a coarse scan and ternary-search that bracket. Using
 * the true minimiser (vs the old closest-to-line heuristic, which over-sends a
 * pilot beside the turnpoint straight to the perpendicular foot) keeps D_rem at
 * the genuine shortest remaining distance — worst case ~3.5% shorter.
 */
export function waypointThroughCylinder(
  cx: number,
  cy: number,
  r: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): [number, number] {
  const [qx, qy] = nearestOnSegment(cx, cy, ax, ay, bx, by);
  if (Math.hypot(qx - cx, qy - cy) <= r) return [qx, qy]; // segment pierces disk → free
  const f = (th: number): number => {
    const tx = cx + r * Math.cos(th);
    const ty = cy + r * Math.sin(th);
    return Math.hypot(ax - tx, ay - ty) + Math.hypot(tx - bx, ty - by);
  };
  // Coarse scan brackets the global minimum (one min / one max on the circle),
  // then ternary-search the ±1-bin window around it to sub-metre precision.
  const N = 16;
  let bi = 0;
  let bf = Infinity;
  for (let i = 0; i < N; i++) {
    const v = f((2 * Math.PI * i) / N);
    if (v < bf) {
      bf = v;
      bi = i;
    }
  }
  let lo = (2 * Math.PI * (bi - 1)) / N;
  let hi = (2 * Math.PI * (bi + 1)) / N;
  for (let it = 0; it < 40; it++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  const th = (lo + hi) / 2;
  return [cx + r * Math.cos(th), cy + r * Math.sin(th)];
}

/**
 * Build the ESS-terminated task and optimise the shortest route through the
 * cylinders (airscore `find_shortest_route`, 3 passes). Goal turnpoints after ESS
 * are dropped — the timed race ends at ESS; goal is only a completed-or-not flag.
 */
export function buildGeom(turnpoints: MapTurnpoint[]): OptTask {
  const tps = turnpoints.filter((tp) => tp.order >= 1).sort((a, b) => a.order - b.order);
  const essI = tps.findIndex((tp) => tp.type === 'ESS');
  const route = tps.slice(0, (essI >= 0 ? essI : tps.length - 1) + 1);
  const lat0 = route[0].lat;
  const lon0 = route[0].lon;
  const cx: number[] = [];
  const cy: number[] = [];
  const r: number[] = [];
  for (const tp of route) {
    const [x, y] = toPlanar(tp.lat, tp.lon, lat0, lon0);
    cx.push(x);
    cy.push(y);
    r.push(tp.radius);
  }
  const n = cx.length;

  // Optimise: start each waypoint at its centre, then run 3 Gauss-Seidel passes.
  const px = [...cx];
  const py = [...cy];
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      if (r[i] <= 0) {
        px[i] = cx[i];
        py[i] = cy[i];
        continue;
      }
      if (i === 0) {
        // SSS: exit point, on the ring toward the first real turnpoint.
        [px[i], py[i]] = onCircleToward(cx[i], cy[i], r[i], px[Math.min(1, n - 1)], py[Math.min(1, n - 1)]);
      } else if (i === n - 1) {
        // ESS: entry point, on the ring toward the previous turnpoint.
        [px[i], py[i]] = onCircleToward(cx[i], cy[i], r[i], px[i - 1], py[i - 1]);
      } else {
        // Interior: closest point on segment(prev, next) to the centre, or the near
        // edge toward it when that segment doesn't already cross the cylinder.
        [px[i], py[i]] = waypointThroughCylinder(cx[i], cy[i], r[i], px[i - 1], py[i - 1], px[i + 1], py[i + 1]);
      }
    }
  }

  const distToGoal = new Array<number>(n).fill(0);
  for (let i = n - 2; i >= 0; i--) {
    distToGoal[i] = distToGoal[i + 1] + Math.hypot(px[i + 1] - px[i], py[i + 1] - py[i]);
  }
  return { cx, cy, r, lat0, lon0, px, py, distToGoal };
}

/** Optimised task distance (SSS → ESS), for calibrating par cross-country speed. */
export function taskDistanceM(t: OptTask): number {
  return t.distToGoal[0] ?? 0;
}

/**
 * Shortest route length from (fx, fy) through cylinders k..last (ESS), and its
 * touch points (so the next fix can warm-start). Same `find_closest` refinement
 * as buildGeom but with the pilot's live position as the fixed start. Because a
 * cylinder the fix sits on the edge of is touched for free, this is continuous
 * across cylinder boundaries — no step when a (possibly huge) cylinder is tagged.
 */
export function optimalRemaining(
  fx: number,
  fy: number,
  t: OptTask,
  k: number,
  warm: [number, number][] | null,
): { total: number; pts: [number, number][] } {
  const { cx, cy, r } = t;
  const n = cx.length;
  const m = n - k;
  const tx: number[] = [];
  const ty: number[] = [];
  if (warm && warm.length === m) {
    for (const [wx, wy] of warm) {
      tx.push(wx);
      ty.push(wy);
    }
  } else {
    for (let i = k; i < n; i++) {
      tx.push(cx[i]);
      ty.push(cy[i]);
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let a = 0; a < m; a++) {
      const i = k + a;
      if (r[i] <= 0) {
        tx[a] = cx[i];
        ty[a] = cy[i];
        continue;
      }
      const ax = a === 0 ? fx : tx[a - 1];
      const ay = a === 0 ? fy : ty[a - 1];
      if (a === m - 1) {
        [tx[a], ty[a]] = onCircleToward(cx[i], cy[i], r[i], ax, ay); // ESS: toward prev
        continue;
      }
      [tx[a], ty[a]] = waypointThroughCylinder(cx[i], cy[i], r[i], ax, ay, tx[a + 1], ty[a + 1]);
    }
  }
  let total = m > 0 ? Math.hypot(tx[0] - fx, ty[0] - fy) : 0;
  for (let a = 1; a < m; a++) total += Math.hypot(tx[a] - tx[a - 1], ty[a] - ty[a - 1]);
  const pts: [number, number][] = tx.map((x, a) => [x, ty[a]]);
  return { total, pts };
}

/**
 * Metres still to fly to ESS at each fix (`points` are [lat, lon]): the shortest
 * route re-optimised from the pilot's current position through the un-tagged
 * cylinders. A cylinder is tagged when the pilot comes within its radius.
 */
export function remainingSeries(t: OptTask, points: [number, number][]): number[] {
  const n = t.cx.length;
  const out: number[] = [];
  let k = 1; // next cylinder to tag (0 = SSS start)
  let warm: [number, number][] | null = null;
  for (const [lat, lon] of points) {
    const [px, py] = toPlanar(lat, lon, t.lat0, t.lon0);
    let advanced = false;
    while (k < n && Math.hypot(px - t.cx[k], py - t.cy[k]) <= t.r[k] + TAG_MARGIN_M) {
      k += 1;
      advanced = true;
    }
    if (k >= n) {
      out.push(0); // inside ESS → speed section done
      warm = null;
      continue;
    }
    const res = optimalRemaining(px, py, t, k, advanced ? null : warm);
    warm = res.pts;
    out.push(res.total);
  }
  return out;
}

/** Centred moving average of altitude over a ±winMs/2 window (times are epoch-ms). */
export function smoothAlt(times: number[], alt: number[], winMs = 7_000): number[] {
  const n = alt.length;
  const out = new Array<number>(n);
  const half = winMs / 2;
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    while (times[i] - times[lo] > half) {
      sum -= alt[lo];
      lo += 1;
    }
    while (hi < n && times[hi] - times[i] <= half) {
      sum += alt[hi];
      hi += 1;
    }
    out[i] = sum / (hi - lo); // `hi` is EXCLUSIVE, so hi - lo is the window count
  }
  return out;
}

// ---- time-to-go (τ) and detrended time-lost (L) --------------------------

export interface TauParams {
  vccMps: number; // par cross-country speed, m/s
  climbMps: number; // par climb rate M, m/s
  hFinM: number; // finish datum, m MSL (median ESS altitude)
  glideRatio?: number; // final-glide cap, default 7 (i.e. gradient 1/7)
  beta?: number; // surplus height discount in [0, 1], default 0
  glideSpeedKmh?: number; // physical final-glide ground-speed cap, default 60 km/h
}

let betaWarned = false;

/**
 * Time-to-go at par (minutes), with a final-glide cap on the altitude credit.
 * Height is credited at 1/M only up to what's needed to glide to goal
 * (h_need = h_fin + D_rem/glideRatio); surplus above that slope is discounted by
 * `beta`.
 *
 *   hNeed  = hFinM + dRem/glideRatio
 *   credit = min(h, hNeed) − hFinM + beta·max(h − hNeed, 0)
 *   tau    = max( ( dRem/vccMps − credit/climbMps ) / 60,  dRem/vGlide/60 )
 *
 * The `max(…)` is a PHYSICAL FLOOR at the pure-glide time dRem/vGlide (vGlide =
 * glideSpeedKmh, default 60 km/h). Without it, on the glide slope τ collapses to
 * dRem/Vg with the MacCready-inverted Vg = V_cc·M/(M − g·V_cc): fine for sailplanes
 * (g≈1/40) but for paraglider glide ratios (g≈1/7) the denominator collapses and Vg
 * runs to 60–180 km/h or diverges, over-crediting final glide. Flooring at a real
 * glide ground speed caps that over-credit; a pilot on glide is never scored faster
 * than vGlide can carry them.
 *
 * Intended behaviour:
 *  - Below the glide slope (h ≤ hNeed) this is IDENTICAL to the plain formula
 *    ( dRem/V_cc − (h − h_fin)/M )/60 — mid-race values do not change at all (the
 *    floor does not bind there, since V_cc < vGlide ⇒ dRem/V_cc > dRem/vGlide).
 *  - Approaching/on the slope the height credit would push τ below the physical
 *    glide time; the floor holds it at dRem/vGlide, so surplus height is worth
 *    nothing and topping up after glide is made reads as pure time loss.
 *  - hNeed shrinks with dRem, so a pilot who deviates falls back below the slope
 *    and full credit is automatically restored.
 */
export function tauSeries(dRem: number[], hSmooth: number[], p: TauParams): number[] {
  const glideRatio = p.glideRatio ?? 7;
  const rawBeta = p.beta ?? 0;
  if (rawBeta > 0.3 && !betaWarned) {
    console.warn(`tauSeries: beta=${rawBeta} > 0.3 is not meaningful; height should not be over-credited.`);
    betaWarned = true;
  }
  const beta = Math.min(1, Math.max(0, rawBeta));
  const vGlideMps = (p.glideSpeedKmh ?? 60) / 3.6;
  const out = new Array<number>(dRem.length);
  for (let i = 0; i < dRem.length; i++) {
    const d = dRem[i];
    const hNeed = p.hFinM + d / glideRatio;
    const h = hSmooth[i];
    const credit = Math.min(h, hNeed) - p.hFinM + beta * Math.max(h - hNeed, 0);
    const tauCredit = (d / p.vccMps - credit / p.climbMps) / 60;
    out[i] = Math.max(tauCredit, d / vGlideMps / 60); // floor at physical glide time
  }
  return out;
}

/**
 * Detrended "minutes behind the par ghost": L = tau + (t − t_gate)/60 − tauRef,
 * with ONE fleet anchor `tauRefMin`. The clock is the shared race clock (gateMs =
 * 0); do NOT anchor per-pilot. A trace therefore starts at its pilot's gate
 * crossing at a nonzero L that is their start quality (late start adds minutes;
 * height above hRef subtracts (h − hRef)/M/60).
 */
export function lostSeries(tau: number[], timesMs: number[], gateMs: number, tauRefMin: number): number[] {
  const out = new Array<number>(tau.length);
  for (let i = 0; i < tau.length; i++) out[i] = tau[i] + (timesMs[i] - gateMs) / 60_000 - tauRefMin;
  return out;
}
