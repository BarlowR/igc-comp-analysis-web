/**
 * Hiking vs flying for a hike-and-fly track.
 *
 * The launch/landing detection itself is the `hike-fly-detect` package (speed
 * moving averages, see its README). It answers "is this fix moving like
 * something airborne", and a car answers yes: the X Red Rocks trackers ride a
 * shuttle to the start and a retrieve home, and both come back as segments.
 * This module is the layer that tells those apart, so the caller can crop the
 * track at a ride instead of scoring it — see IgcFlight.rideIndex.
 *
 * The split needs no terrain data because a glider has few ways to stay up: it
 * climbs above where it started, it comes down at a glider's glide angle, or it
 * works a slope in beats, turning all the time. A segment that does none of
 * those is following a road.
 */

import { analyzeTrack } from 'hike-fly-detect';
import { haversine } from './math';

export interface AirSegment {
  /** Index pair into the track's columns. Fix i is in the segment when launch < i < landing. */
  launch: number;
  landing: number;
  kind: 'flight' | 'vehicle';
}

/** Slower than this over the whole segment (m/s) is a run or a GPS jump, not a flight. */
const MIN_AIR_SPEED_MPS = 3;
/** A road-following segment shorter than this (m) is too little evidence to end
 * a pilot's race on: a hop off launch or a GPS jump looks the same. */
const MIN_RIDE_PATH_M = 3000;
/** Smoothed ground speed (m/s, ~97 km/h) no paraglider holds, tailwind included. */
const HIGHWAY_SPEED_MPS = 27;
/** Seconds at highway speed, and the share of the segment, that make it a drive.
 * The share is what spares a long flight on a windy day its few fast seconds. */
const HIGHWAY_MIN_S = 30;
const HIGHWAY_MIN_SHARE = 0.05;
/** Height (m) above both launch and landing that only lift gives. */
const MIN_HEIGHT_GAINED_M = 100;
/** Path metres per metre descended. Sled rides in the archive run 15–20; roads start at 23. */
const MAX_GLIDE_RATIO = 22;
/** Full turns per km of path. Ridge soaring below launch height runs 1.4 and up,
 * a road along a valley under 1. A road up a mountain switchbacks its way to
 * 1.3, so a segment that ends well above its launch is held to the higher bar. */
const MIN_SOARING_TURNS_PER_KM = 1.0;
const MIN_SOARING_UP_TURNS_PER_KM = 1.5;
/** Net height gain (m) that makes a segment an ascent. */
const MIN_ASCENT_M = 100;
/** Headings are taken between fixes at least this far apart, so GPS jitter
 * isn't read as turning and a 5 s logger is read the same as a 1 s one. */
const HEADING_STEP_MS = 5000;
const HEADING_STEP_M = 15;
/** A heading change across a longer hole in the log says nothing about turning. */
const HEADING_MAX_GAP_MS = 20000;

/**
 * Run the detector over a track and label each segment it finds. Segments too
 * slow to be either a flight or a ride are dropped, which leaves those fixes on
 * foot. Indexes point into the columns passed in.
 */
export function detectAirSegments(track: {
  timeMs: number[];
  lat: number[];
  lon: number[];
  gnssAlt: number[];
}): AirSegment[] {
  const { timeMs, lat, lon, gnssAlt: alt } = track;
  if (timeMs.length < 5) return []; // the detector's own minimum

  const { segments, hma } = analyzeTrack({ timeMs, lat, lon, alt });
  const out: AirSegment[] = [];
  for (const { launch, landing } of segments) {
    let pathM = 0;
    let highwayS = 0;
    let maxAlt = -Infinity;
    let turnedRad = 0;
    let from = launch; // last fix a heading was taken from
    let heading: number | null = null;
    for (let i = launch + 1; i <= landing; i++) {
      pathM += haversine(lat[i], lon[i], lat[i - 1], lon[i - 1]);
      if (hma[i] >= HIGHWAY_SPEED_MPS) highwayS += (timeMs[i] - timeMs[i - 1]) / 1000;
      if (alt[i] > maxAlt) maxAlt = alt[i];

      const stepMs = timeMs[i] - timeMs[from];
      if (stepMs < HEADING_STEP_MS) continue;
      const north = lat[i] - lat[from];
      const east = (lon[i] - lon[from]) * Math.cos((lat[i] * Math.PI) / 180);
      if (Math.hypot(north, east) * 111_000 < HEADING_STEP_M) continue;
      const next = Math.atan2(east, north);
      if (heading !== null && stepMs < HEADING_MAX_GAP_MS) {
        const change = Math.abs(next - heading);
        turnedRad += change > Math.PI ? 2 * Math.PI - change : change;
      }
      heading = next;
      from = i;
    }
    const durationS = (timeMs[landing] - timeMs[launch]) / 1000;
    if (!(durationS > 0) || pathM / durationS < MIN_AIR_SPEED_MPS) continue;

    const highway = highwayS >= HIGHWAY_MIN_S && highwayS >= HIGHWAY_MIN_SHARE * durationS;
    const gainedM = maxAlt - Math.max(alt[launch], alt[landing]);
    const descentM = alt[launch] - alt[landing];
    const glides = descentM > 0 && pathM / descentM <= MAX_GLIDE_RATIO;
    const turnsPerKm = turnedRad / (2 * Math.PI) / (pathM / 1000);
    const minTurns = -descentM >= MIN_ASCENT_M ? MIN_SOARING_UP_TURNS_PER_KM : MIN_SOARING_TURNS_PER_KM;
    const followsRoad = gainedM < MIN_HEIGHT_GAINED_M && !glides && turnsPerKm < minTurns;
    const vehicle = highway || (followsRoad && pathM >= MIN_RIDE_PATH_M);
    out.push({ launch, landing, kind: vehicle ? 'vehicle' : 'flight' });
  }
  return out;
}

/** Seconds of centred moving average applied to the height on foot. */
const HIKING_SMOOTH_S = 120;
/** A rise on foot is counted once it is this tall (m) before the next fall. */
const HIKING_CLIMB_M = 10;

/**
 * Height gained on foot from `from` to the end of the track.
 *
 * The flying gain is the sum of positive 5-second deltas, like the XC
 * "Total Meters Climbed", and the GPS height is steady enough for that in the
 * air, where a climb is 1–5 m/s. On foot a climb is 0–0.3 m/s, under the GPS
 * jitter, and that sum counts the positive half of the jitter for every second
 * on the ground: on X Red Rocks days it roughly doubles the true gain, and a
 * noisy tracker or an hour sat still can triple it. So each contiguous run of
 * fixes on foot is smoothed over two minutes, and a rise is banked only once
 * it is 10 m tall. Against the trackers' pressure altitude this lands within
 * ±10 % for most of the field. A run never spans a flight, so a launch or a
 * landing is not a hiking climb.
 */
export function hikingHeightGained(
  timeMs: number[],
  alt: number[],
  onFoot: boolean[],
  from: number,
): number {
  let gained = 0;
  let i = Math.max(from, 0);
  while (i < timeMs.length) {
    if (!onFoot[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < timeMs.length && onFoot[end]) end++;
    gained += bankedRise(smooth(timeMs, alt, i, end, HIKING_SMOOTH_S * 1000), HIKING_CLIMB_M);
    i = end;
  }
  return gained;
}

/** Centred moving average of alt[start, end) over a window of `windowMs`. */
function smooth(timeMs: number[], alt: number[], start: number, end: number, windowMs: number): number[] {
  const out: number[] = [];
  let lo = start;
  let hi = start;
  let sum = 0;
  for (let i = start; i < end; i++) {
    while (hi < end && timeMs[hi] <= timeMs[i] + windowMs / 2) sum += alt[hi++];
    while (timeMs[lo] < timeMs[i] - windowMs / 2) sum -= alt[lo++];
    out.push(sum / (hi - lo));
  }
  return out;
}

/** Sum of the rises in `alt` that reach `minRise` before the height falls back by as much. */
function bankedRise(alt: number[], minRise: number): number {
  if (alt.length === 0) return 0;
  let gained = 0;
  let base = alt[0];
  let peak = alt[0];
  for (const a of alt) {
    if (a > peak) peak = a;
    else if (a < peak - minRise) {
      gained += peak - base;
      base = peak = a;
    }
    if (a < base) base = peak = a;
  }
  return gained + (peak - base);
}
