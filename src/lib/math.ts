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
