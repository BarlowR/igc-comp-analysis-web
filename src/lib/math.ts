/**
 * Numeric helpers ported from utils/math_utils.py and the pandas/numpy
 * column operations used throughout igc_lib.py.
 *
 * The Python implementation works on pandas DataFrames; here every "column"
 * is a plain `number[]` (NaN represents pandas NaN). The helpers below
 * reproduce the exact semantics of `diff(periods=n)`, `cumsum`, `.where()`,
 * `.clip()` and boolean masks that NaN-compares to False.
 */

const DEGREES_TO_RADS = Math.PI / 180.0;
const EARTH_RADIUS_M = 6371000; // matches haversine() in math_utils.py

/** Great-circle distance in metres between two lat/lon points (decimal degrees). */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const lat1r = lat1 * DEGREES_TO_RADS;
  const lon1r = lon1 * DEGREES_TO_RADS;
  const lat2r = lat2 * DEGREES_TO_RADS;
  const lon2r = lon2 * DEGREES_TO_RADS;
  const dlon = lon2r - lon1r;
  const dlat = lat2r - lat1r;
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dlon / 2) ** 2;
  const c = 2 * Math.asin(Math.sqrt(a));
  return c * EARTH_RADIUS_M;
}

// WGS84 ellipsoid, for the near-cylinder-boundary checks in insideCylinder().
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

/** WGS84 ellipsoid distance in metres (Vincenty inverse). */
export function vincenty(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const L = (lon2 - lon1) * DEGREES_TO_RADS;
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(lat1 * DEGREES_TO_RADS));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(lat2 * DEGREES_TO_RADS));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 1;
  let sigma = 0;
  let cosSqAlpha = 1;
  let cos2SigmaM = 0;
  for (let iter = 0; iter < 100; iter++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
    if (sinSigma === 0) return 0; // coincident points
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    const prev = lambda;
    lambda =
      L +
      (1 - C) *
        WGS84_F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - prev) < 1e-12) break;
  }

  const uSq = (cosSqAlpha * (WGS84_A ** 2 - WGS84_B ** 2)) / WGS84_B ** 2;
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return WGS84_B * A * (sigma - deltaSigma);
}

/**
 * Turnpoint cylinder test as official scoring performs it: cylinders carry a
 * tolerance band of 0.1% of the radius (min 5 m — the GAP rule), and distances
 * are measured on the WGS84 ellipsoid. Pilots' instruments direct them to shave
 * big cylinders to within metres of the boundary, so on a 44 km cylinder the
 * sphere-vs-ellipsoid disagreement (~0.1% of the distance) plus a strict
 * `<= radius` puts a real share of the field "outside" a cylinder they tagged.
 * The ellipsoid distance costs ~20x the spherical one, so it is only consulted
 * inside the band where the two can disagree.
 */
export function insideCylinder(
  lat: number,
  lon: number,
  cLat: number,
  cLon: number,
  radius: number,
): boolean {
  const tol = Math.max(5, radius * 0.001);
  const d = haversine(lat, lon, cLat, cLon);
  const band = radius * 0.006 + tol;
  if (Math.abs(d - radius) > band) return d <= radius + tol;
  return vincenty(lat, lon, cLat, cLon) <= radius + tol;
}

/** pandas Series.diff(periods): out[i] = x[i] - x[i-periods], NaN for the first `periods`. */
export function diff(x: number[], periods = 1): number[] {
  const out = new Array<number>(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = i >= periods ? x[i] - x[i - periods] : NaN;
  }
  return out;
}

/** pandas Series.shift(periods): out[i] = x[i-periods], NaN for the first `periods`. */
export function shift(x: number[], periods = 1): number[] {
  const out = new Array<number>(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = i >= periods ? x[i - periods] : NaN;
  }
  return out;
}

/** Element-wise a / b (NaN propagates, like numpy). */
export function divide(a: number[], b: number[]): number[] {
  return a.map((v, i) => v / b[i]);
}

/** Element-wise a * scalar. */
export function scale(a: number[], k: number): number[] {
  return a.map((v) => v * k);
}

/**
 * pandas Series.cumsum (skipna=True): NaN entries contribute 0 to the running
 * total. We only ever read the final value, so emitting the running total at
 * every index (rather than re-inserting NaNs) is faithful for our use.
 */
export function cumsum(x: number[]): number[] {
  const out = new Array<number>(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isNaN(x[i])) acc += x[i];
    out[i] = acc;
  }
  return out;
}

/** numpy clip with optional lower/upper bounds; NaN passes through unchanged. */
export function clip(x: number[], lower?: number, upper?: number): number[] {
  return x.map((v) => {
    if (Number.isNaN(v)) return v;
    let r = v;
    if (lower !== undefined && r < lower) r = lower;
    if (upper !== undefined && r > upper) r = upper;
    return r;
  });
}

/** Series.where(mask, other): keep value where mask true, else `other`. */
export function where(x: number[], mask: boolean[], other = 0): number[] {
  return x.map((v, i) => (mask[i] ? v : other));
}

/** Boolean cumulative count (cumsum over a boolean mask). */
export function cumsumBool(mask: boolean[]): number[] {
  const out = new Array<number>(mask.length);
  let acc = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) acc += 1;
    out[i] = acc;
  }
  return out;
}

/** Logical AND of two boolean masks. */
export function and(a: boolean[], b: boolean[]): boolean[] {
  return a.map((v, i) => v && b[i]);
}

/** Logical NOT of a boolean mask. */
export function not(a: boolean[]): boolean[] {
  return a.map((v) => !v);
}

/** Mean ignoring NaN (pandas Series.mean default skipna=True). */
export function nanmean(x: number[]): number {
  let sum = 0;
  let n = 0;
  for (const v of x) {
    if (!Number.isNaN(v)) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : NaN;
}

// --- optimized task route ---------------------------------------------------

/** A task turnpoint as a cylinder: centre (decimal degrees) + radius in metres. */
export interface TaskCylinder {
  lat: number;
  lon: number;
  radius: number;
}

/**
 * Shortest route that touches every turnpoint cylinder in order — the "optimized
 * task" line that competition scoring uses, rather than straight lines through
 * the cylinder centres.
 *
 * Each turnpoint is a circle (centre + radius). The optimal crossing point of an
 * intermediate cylinder is the point on its circle minimising the combined
 * distance to its two neighbours; the first/last points minimise distance to
 * their single neighbour. We relax all points jointly until they stop moving.
 *
 * Work happens in a local equirectangular projection (metres) anchored at the
 * first centre — accurate to well under a metre over task-sized areas, and the
 * only frame in which the radii are true circles. Returns one [lat, lon] per
 * input cylinder, in order.
 */
export function optimizeTaskRoute(cylinders: TaskCylinder[]): [number, number][] {
  if (cylinders.length === 0) return [];
  if (cylinders.length === 1) return [[cylinders[0].lat, cylinders[0].lon]];

  const lat0 = cylinders[0].lat;
  const cosLat0 = Math.cos(lat0 * DEGREES_TO_RADS);
  const mPerDegLat = EARTH_RADIUS_M * DEGREES_TO_RADS;
  const mPerDegLon = mPerDegLat * cosLat0;

  // Project centres to local metres.
  const cx = cylinders.map((c) => (c.lon - cylinders[0].lon) * mPerDegLon);
  const cy = cylinders.map((c) => (c.lat - lat0) * mPerDegLat);
  const r = cylinders.map((c) => c.radius);

  // Start each point at its centre, then relax toward the neighbours.
  const px = cx.slice();
  const py = cy.slice();

  const n = cylinders.length;
  const last = n - 1;
  for (let iter = 0; iter < 200; iter++) {
    let maxMove = 0;
    for (let i = 0; i < n; i++) {
      if (r[i] <= 0) continue; // a zero-radius cylinder is just its centre
      let nx: number, ny: number;
      if (i === 0) {
        [nx, ny] = closestOnCircle(cx[i], cy[i], r[i], px[i + 1], py[i + 1]);
      } else if (i === last) {
        [nx, ny] = closestOnCircle(cx[i], cy[i], r[i], px[i - 1], py[i - 1]);
      } else {
        [nx, ny] = bestOnCircle(cx[i], cy[i], r[i], px[i - 1], py[i - 1], px[i + 1], py[i + 1]);
      }
      maxMove = Math.max(maxMove, Math.hypot(nx - px[i], ny - py[i]));
      px[i] = nx;
      py[i] = ny;
    }
    if (maxMove < 0.1) break; // converged to within 10 cm
  }

  return px.map((x, i) => [py[i] / mPerDegLat + lat0, x / mPerDegLon + cylinders[0].lon]);
}

/** Point on the circle (cx, cy, r) nearest to (tx, ty). */
function closestOnCircle(cx: number, cy: number, r: number, tx: number, ty: number): [number, number] {
  const dx = tx - cx;
  const dy = ty - cy;
  const d = Math.hypot(dx, dy);
  if (d === 0) return [cx + r, cy]; // target at centre: pick an arbitrary edge point
  return [cx + (dx / d) * r, cy + (dy / d) * r];
}

/**
 * Point on the circle (cx, cy, r) minimising dist(A, X) + dist(X, B). The cost
 * over the angle is unimodal on the relevant arc, so we coarse-scan then refine
 * with a few rounds of golden-section-style narrowing.
 */
function bestOnCircle(
  cx: number,
  cy: number,
  r: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): [number, number] {
  const cost = (theta: number) => {
    const x = cx + r * Math.cos(theta);
    const y = cy + r * Math.sin(theta);
    return Math.hypot(ax - x, ay - y) + Math.hypot(bx - x, by - y);
  };

  // Coarse scan over the full circle for the best starting angle.
  let best = 0;
  let bestCost = Infinity;
  const STEPS = 72;
  for (let k = 0; k < STEPS; k++) {
    const theta = (k / STEPS) * 2 * Math.PI;
    const c = cost(theta);
    if (c < bestCost) {
      bestCost = c;
      best = theta;
    }
  }

  // Refine within ±one coarse step by repeated bracketing.
  let lo = best - (2 * Math.PI) / STEPS;
  let hi = best + (2 * Math.PI) / STEPS;
  for (let i = 0; i < 40; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (cost(m1) < cost(m2)) hi = m2;
    else lo = m1;
  }
  const theta = (lo + hi) / 2;
  return [cx + r * Math.cos(theta), cy + r * Math.sin(theta)];
}
