/**
 * Data layer for the Thermal Cloud pane (scripts/thermal-cloud.ts): turns the
 * replay page's tracks into a fixed-rate local-frame model and answers the
 * per-frame "what's in the air around this pilot" query — the air samples to
 * draw, every pilot's position and tail, the pinned pilot's 30 s best/average,
 * and the best climber nearby. No Three.js here — this is plain numbers, so it
 * runs in the unit tests.
 *
 * The day JSON ships each track thinned to ≤1500 fixes (competition.ts
 * `downsample`), which on a long task is one fix every ~10–12 s. The spec wants
 * ≥1 sample / 5 s, so each track is resampled onto a common 5 s grid by linear
 * interpolation. That meets the density but can't recover detail the thinning
 * dropped: vario here is a 10 s centred difference over interpolated altitude,
 * so it reads a little smoother than a vario instrument would. Full-resolution
 * tracks would need a separate fetch, which is a v2 option.
 */
import type { MapTrack } from './competition';

/** Sample spacing of the resampled grid (ms). */
export const STEP_MS = 5_000;
/** A gap between consecutive source fixes longer than this is a hole, not a
 * segment to interpolate across. */
const MAX_GAP_MS = 60_000;

/** Per-frame inclusion window around the anchor (spec). */
export const TRAIL_MS = 180_000;
export const NEAR_HORIZ_M = 1_000;
export const NEAR_VERT_M = 450;
/** Grey pilot tail / anchor trail lengths. */
export const TAIL_MS = 75_000;
export const ANCHOR_TRAIL_MS = 120_000;
/** Window for the trailing stats (best / average / best nearby). */
export const STAT_MS = 30_000;
/** Tighter radius for the "best climb in vicinity" pick — a pilot a kilometre
 * off is in the cloud for context, but is not in the same thermal. */
export const VICINITY_HORIZ_M = 500;
export const VICINITY_VERT_M = 200;

export interface CloudTrack {
  pilot: string;
  /** Epoch ms of grid sample 0. Sample i is at t0 + i * STEP_MS. */
  t0: number;
  /** Local east / north (m) and GPS altitude (m). NaN in a gap. */
  x: Float32Array;
  y: Float32Array;
  alt: Float32Array;
  /** Vertical speed (m/s), 10 s centred difference. NaN where undefined. */
  v: Float32Array;
}

export interface CloudModel {
  tracks: CloudTrack[];
  /** Local-frame origin (deg). */
  lat0: number;
  lon0: number;
  altLo: number;
  altHi: number;
  /** 90th percentile of the day's positive vario; the colour/alpha ramp's top. */
  vmax: number;
}

/** One sphere in the cloud for the current frame. */
export interface AirSample {
  pilot: string;
  x: number;
  y: number;
  alt: number;
  v: number;
  /** Seconds before the playhead (0 = now). */
  ageS: number;
}

export interface PilotNow {
  pilot: string;
  x: number;
  y: number;
  alt: number;
  v: number;
  /** Oldest → newest, newest last. */
  tail: { x: number; y: number; alt: number }[];
}

export interface Frame {
  anchor: PilotNow | null;
  others: PilotNow[];
  air: AirSample[];
  /** The anchor's own vario over the last STAT_MS: best single sample and
   * mean. Null with no anchor or no samples. */
  best: number | null;
  avg: number | null;
  /** The other pilot with the highest mean vario over the last STAT_MS within
   * VICINITY_HORIZ_M / VICINITY_VERT_M of the anchor — only if that mean is
   * actually a climb (> 0). Null when nobody near is going up. */
  bestNearby: { pilot: string; v: number } | null;
}

const R = 6_371_000;
const D2R = Math.PI / 180;

export function buildCloudModel(tracks: MapTrack[]): CloudModel {
  // Origin: mean of every first fix — close enough for a comp-day's airspace,
  // and the frame only has to be consistent, not geodetically exact.
  let lat0 = 0;
  let lon0 = 0;
  let n = 0;
  for (const tr of tracks) {
    if (!tr.points.length) continue;
    lat0 += tr.points[0][0];
    lon0 += tr.points[0][1];
    n++;
  }
  if (n) {
    lat0 /= n;
    lon0 /= n;
  }
  const kx = R * D2R * Math.cos(lat0 * D2R);
  const ky = R * D2R;

  const out: CloudTrack[] = [];
  let altLo = Infinity;
  let altHi = -Infinity;
  const positives: number[] = [];
  for (const tr of tracks) {
    const ct = resample(tr, lat0, lon0, kx, ky);
    if (!ct) continue;
    out.push(ct);
    for (let i = 0; i < ct.alt.length; i++) {
      const a = ct.alt[i];
      if (a === a) {
        if (a < altLo) altLo = a;
        if (a > altHi) altHi = a;
      }
      const v = ct.v[i];
      if (v > 0) positives.push(v);
    }
  }
  if (!Number.isFinite(altLo)) {
    altLo = 0;
    altHi = 1000;
  }
  positives.sort((a, b) => a - b);
  const vmax = positives.length ? Math.max(0.5, positives[Math.floor(positives.length * 0.9)]) : 3;
  return { tracks: out, lat0, lon0, altLo, altHi, vmax: Math.round(vmax * 10) / 10 };
}

function resample(tr: MapTrack, lat0: number, lon0: number, kx: number, ky: number): CloudTrack | null {
  const { times, points, alt } = tr;
  const m = times.length;
  if (m < 2) return null;
  const t0 = Math.ceil(times[0] / STEP_MS) * STEP_MS;
  const tEnd = Math.floor(times[m - 1] / STEP_MS) * STEP_MS;
  const n = Math.floor((tEnd - t0) / STEP_MS) + 1;
  if (n < 3) return null;
  const x = new Float32Array(n).fill(NaN);
  const y = new Float32Array(n).fill(NaN);
  const a = new Float32Array(n).fill(NaN);
  const v = new Float32Array(n).fill(NaN);
  let j = 0; // source index: times[j] <= t < times[j+1]
  for (let i = 0; i < n; i++) {
    const t = t0 + i * STEP_MS;
    while (j < m - 2 && times[j + 1] <= t) j++;
    const ta = times[j];
    const tb = times[j + 1];
    if (t < ta || t > tb || tb - ta > MAX_GAP_MS || !Number.isFinite(alt[j]) || !Number.isFinite(alt[j + 1])) continue;
    const f = tb > ta ? (t - ta) / (tb - ta) : 0;
    const lat = points[j][0] + (points[j + 1][0] - points[j][0]) * f;
    const lon = points[j][1] + (points[j + 1][1] - points[j][1]) * f;
    x[i] = (lon - lon0) * kx;
    y[i] = (lat - lat0) * ky;
    a[i] = alt[j] + (alt[j + 1] - alt[j]) * f;
  }
  // Centred difference over 10 s (one grid step either side). Ends and gap
  // edges fall back to a one-sided 5 s difference so a climb doesn't lose its
  // first and last sample.
  for (let i = 0; i < n; i++) {
    if (a[i] !== a[i]) continue;
    const prev = i > 0 ? a[i - 1] : NaN;
    const next = i < n - 1 ? a[i + 1] : NaN;
    if (prev === prev && next === next) v[i] = (next - prev) / (2 * STEP_MS / 1000);
    else if (next === next) v[i] = (next - a[i]) / (STEP_MS / 1000);
    else if (prev === prev) v[i] = (a[i] - prev) / (STEP_MS / 1000);
  }
  return { pilot: tr.pilot, t0, x, y, alt: a, v };
}

/** Position of a track at epoch ms `t`, interpolated between grid samples. */
export function trackAt(ct: CloudTrack, t: number): { x: number; y: number; alt: number; v: number } | null {
  const f = (t - ct.t0) / STEP_MS;
  const n = ct.x.length;
  if (f < 0 || f > n - 1) return null;
  const i = Math.floor(f);
  const k = f - i;
  if (k === 0 || i >= n - 1) return sampleAt(ct, i);
  const a = sampleAt(ct, i);
  const b = sampleAt(ct, i + 1);
  if (!a || !b) return a ?? b;
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    alt: a.alt + (b.alt - a.alt) * k,
    v: a.v + (b.v - a.v) * k,
  };
}

function sampleAt(ct: CloudTrack, i: number): { x: number; y: number; alt: number; v: number } | null {
  const x = ct.x[i];
  if (x !== x) return null;
  const v = ct.v[i];
  return { x, y: ct.y[i], alt: ct.alt[i], v: v === v ? v : 0 };
}

function pilotNow(ct: CloudTrack, t: number, tailMs: number): PilotNow | null {
  const now = trackAt(ct, t);
  if (!now) return null;
  const tail: PilotNow['tail'] = [];
  const first = Math.max(0, Math.ceil((t - tailMs - ct.t0) / STEP_MS));
  const last = Math.min(ct.x.length - 1, Math.floor((t - ct.t0) / STEP_MS));
  for (let i = first; i <= last; i++) {
    const x = ct.x[i];
    if (x !== x) continue;
    tail.push({ x, y: ct.y[i], alt: ct.alt[i] });
  }
  tail.push({ x: now.x, y: now.y, alt: now.alt });
  return { pilot: ct.pilot, ...now, tail };
}

/**
 * Everything the scene needs at playhead `t`: the anchor, every other pilot's
 * dot + tail, and the air samples — each fix in the trailing 3 min that sat
 * within 1 km / 450 m of where the anchor was at that same moment.
 */
export function frameAt(model: CloudModel, anchorName: string, t: number): Frame {
  const anchorTrack = model.tracks.find((c) => c.pilot === anchorName) ?? null;
  const anchor = anchorTrack ? pilotNow(anchorTrack, t, ANCHOR_TRAIL_MS) : null;
  const others: PilotNow[] = [];
  const air: AirSample[] = [];
  let best: number | null = null;
  let avgSum = 0;
  let avgN = 0;
  let pSum = 0;
  let pN = 0;
  let bestNearby: Frame['bestNearby'] = null;

  // Anchor position per grid step over the window, so each sample compares
  // against the anchor's concurrent position rather than where they are now.
  const steps = Math.round(TRAIL_MS / STEP_MS);
  const tLast = Math.floor(t / STEP_MS) * STEP_MS;
  const aPos: ({ x: number; y: number; alt: number } | null)[] = new Array(steps + 1);
  for (let s = 0; s <= steps; s++) aPos[s] = anchorTrack ? trackAt(anchorTrack, tLast - s * STEP_MS) : null;

  for (const ct of model.tracks) {
    const isAnchor = ct === anchorTrack;
    if (!isAnchor) {
      const pn = pilotNow(ct, t, TAIL_MS);
      if (pn) others.push(pn);
    }
    if (!anchorTrack) continue;
    pSum = 0;
    pN = 0;
    for (let s = 0; s <= steps; s++) {
      const ts = tLast - s * STEP_MS;
      const i = (ts - ct.t0) / STEP_MS;
      if (i < 0 || i >= ct.x.length || !Number.isInteger(i)) continue;
      const x = ct.x[i];
      if (x !== x) continue;
      const ap = aPos[s];
      if (!ap) continue;
      const y = ct.y[i];
      const alt = ct.alt[i];
      const dx = x - ap.x;
      const dy = y - ap.y;
      const d2 = dx * dx + dy * dy;
      const dAlt = Math.abs(alt - ap.alt);
      if (d2 > NEAR_HORIZ_M * NEAR_HORIZ_M || dAlt > NEAR_VERT_M) continue;
      const v = ct.v[i];
      if (v !== v) continue;
      if (t - ts <= STAT_MS) {
        if (isAnchor) {
          if (best == null || v > best) best = v;
          avgSum += v;
          avgN++;
        } else if (d2 <= VICINITY_HORIZ_M * VICINITY_HORIZ_M && dAlt <= VICINITY_VERT_M) {
          pSum += v;
          pN++;
        }
      }
      air.push({ pilot: ct.pilot, x, y, alt, v, ageS: (t - ts) / 1000 });
    }
    if (!isAnchor && pN && pSum / pN > 0 && (bestNearby == null || pSum / pN > bestNearby.v)) {
      bestNearby = { pilot: ct.pilot, v: pSum / pN };
    }
  }
  return {
    anchor,
    others,
    air,
    best,
    avg: avgN ? avgSum / avgN : null,
    bestNearby,
  };
}
