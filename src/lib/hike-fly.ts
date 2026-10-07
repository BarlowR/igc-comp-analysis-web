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
