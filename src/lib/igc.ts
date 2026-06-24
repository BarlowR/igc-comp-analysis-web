/**
 * Port of igc_lib.py — IGC flight-log parsing and competition metric analysis.
 *
 * Data is held column-wise: the `Columns` object below mirrors the pandas
 * DataFrame `self.dataframe` / `self.comp_dataframe`. Every helper from math.ts
 * matches a pandas/numpy operation so the computed `stats` match the Python
 * tool's output.
 */

import {
  haversine,
  diff,
  shift,
  divide,
  scale,
  cumsum,
  cumsumBool,
  clip,
  where,
  and,
  not,
  nanmean,
} from './math';
import type { XcTask } from './xctsk';

const MS_TO_KMH = 3.6;
const FORWARD_TRAVEL_THRESHOLD = 200; // FORWARD_TRAVEL_THRESHOLD_20S in Python
const CLIMBING_THRESHOLD = -0.5;
const TIME_INTERVALS = [1, 5, 20, 30] as const;

/** Raw, parsed B-record fixes (column-oriented). */
interface Fixes {
  timeMs: number[]; // epoch milliseconds
  lat: number[];
  lon: number[];
  validity: string[];
  pressureAlt: number[];
  gnssAlt: number[];
}

/** Per-fix derived columns (subset that the competition stats actually need). */
interface Columns {
  timeMs: number[];
  lat: number[];
  lon: number[];
  gnssAlt: number[];
  // per-interval derived
  altDelta: Record<number, number[]>;
  secondsDelta: Record<number, number[]>;
  vspeed: Record<number, number[]>;
  distance: Record<number, number[]>;
  // categorical masks
  stoppedToClimb: boolean[];
  onGlide: boolean[];
  climbing: boolean[];
  sinking: boolean[];
  stoppedAndNotClimbing: boolean[];
  stoppedAndClimbing: boolean[];
  climbingOnGlide: boolean[];
  sinkingOnGlide: boolean[];
  // per-second time
  timeClimbingS: number[];
  timeGlidingS: number[];
  // cumulative (filled by calcCumulative)
  totalMetersClimbed: number[];
  thermalMetersClimbed: number[];
  glideMetersClimbed: number[];
  stoppedAndNotClimbingS: number[];
  stoppedAndClimbingS: number[];
  climbingOnGlideS: number[];
  sinkingOnGlideS: number[];
  cumulativeTimeClimbingS: number[];
  cumulativeTimeGlidingS: number[];
  cumulativeDistance: number[];
  // task progress (comp only)
  nextWaypointName: string[];
}

export type Stats = Record<string, number | boolean | null>;

export class IgcFlight {
  pilotName = 'Unknown Pilot';
  day: Date = new Date(); // mutated on midnight rollover, mirroring Python self.day
  /** The flight's first (launch) day, captured before any UTC-midnight rollover. */
  private firstDay: Date | null = null;
  private lastHour: number | null = null;

  fixes: Fixes = { timeMs: [], lat: [], lon: [], validity: [], pressureAlt: [], gnssAlt: [] };
  df!: Columns;
  compDf: Columns | null = null;
  stats: Stats = {};
  /** Index (in the comp window) of the fix where the pilot exited the SSS. */
  private sssExitIdx: number | null = null;

  constructor(text: string, fallbackName = 'Unknown Pilot') {
    this.pilotName = fallbackName;
    this.parse(text);
    this.filterOutliers();
    this.buildComputedMetrics();
  }

  // ---- parsing -----------------------------------------------------------

  private parse(text: string): void {
    const lines = text.split(/\r?\n/);
    let inContents = false;

    for (const line of lines) {
      if (line.length === 0) continue;

      if (!inContents) {
        // header section: read date + pilot, stop when first B-record appears
        if (line.startsWith('HFDTE')) {
          // "HFDTE050225" or "HFDTEDATE:080624,01"
          let dateStr: string;
          const colon = line.indexOf('DATE:');
          if (colon !== -1) dateStr = line.slice(colon + 5, colon + 11);
          else dateStr = line.slice(5, 11);
          this.day = parseIgcDate(dateStr);
        } else if (line.startsWith('HFPLTPILOT')) {
          this.pilotName = line.split(':')[1] ?? this.pilotName;
        }

        if (line[0] === 'B') {
          inContents = true;
          this.parseBFix(line);
        }
        continue;
      }

      // contents section
      if (line[0] === 'B') {
        this.parseBFix(line);
      } else if (['E', 'L', 'F', 'K'].includes(line[0])) {
        continue; // interleaved records, ignore
      } else {
        break; // footer reached
      }
    }
  }

  private parseBFix(line: string): void {
    // B HHMMSS DDMMmmmN DDDMMmmmE V PPPPP GGGGG
    const hour = parseInt(line.slice(1, 3), 10);
    const minute = parseInt(line.slice(3, 5), 10);
    const sec = parseInt(line.slice(5, 7), 10);

    if (this.firstDay === null) this.firstDay = this.day; // launch day, pre-rollover
    if (this.lastHour === 23 && hour === 0) {
      this.day = new Date(this.day.getTime() + 24 * 3600 * 1000);
    }
    this.lastHour = hour;

    const t = new Date(
      this.day.getFullYear(),
      this.day.getMonth(),
      this.day.getDate(),
      hour,
      minute,
      sec,
    );

    const latDeg = parseInt(line.slice(7, 9), 10);
    const latMin = parseInt(line.slice(9, 14), 10) / 1000;
    const north = line[14] === 'N';
    let lat = latDeg + latMin / 60;
    lat *= north ? 1 : -1;

    const lonDeg = parseInt(line.slice(15, 18), 10);
    const lonMin = parseInt(line.slice(18, 23), 10) / 1000;
    const east = line[23] === 'E';
    let lon = lonDeg + lonMin / 60;
    lon *= east ? 1 : -1;

    this.fixes.timeMs.push(t.getTime());
    this.fixes.lat.push(lat);
    this.fixes.lon.push(lon);
    this.fixes.validity.push(line[24]);
    this.fixes.pressureAlt.push(parseInt(line.slice(25, 30), 10));
    this.fixes.gnssAlt.push(parseInt(line.slice(30, 35), 10));
  }

  // ---- outlier filtering -------------------------------------------------

  private filterOutliers(): void {
    const n = this.fixes.timeMs.length;
    if (n < 200) return; // small/test datasets are left untouched

    // Filter 1: valid fixes only, Filter 2: realistic altitude.
    let keep = this.fixes.gnssAlt.map(
      (a, i) => this.fixes.validity[i] === 'A' && a >= -100 && a <= 10000,
    );
    this.applyMask(keep);

    // Filter 4: drop fixes implying > 200 km/h instantaneous ground speed.
    keep = this.fixes.timeMs.map((tm, i) => {
      if (i === 0) return true; // NaN delta kept, like pandas isna()
      const dt = (tm - this.fixes.timeMs[i - 1]) / 1000;
      if (!(dt > 0)) return true;
      const dist = haversine(
        this.fixes.lat[i],
        this.fixes.lon[i],
        this.fixes.lat[i - 1],
        this.fixes.lon[i - 1],
      );
      return (dist / dt) * 3.6 <= 200;
    });
    this.applyMask(keep);

    // Filter 5: drop fixes implying > ±20 m/s vertical speed.
    keep = this.fixes.gnssAlt.map((alt, i) => {
      if (i === 0) return true;
      const dt = (this.fixes.timeMs[i] - this.fixes.timeMs[i - 1]) / 1000;
      if (!(dt > 0)) return true;
      const vspeed = (alt - this.fixes.gnssAlt[i - 1]) / dt;
      return vspeed >= -20 && vspeed <= 20;
    });
    this.applyMask(keep);
  }

  private applyMask(keep: boolean[]): void {
    const f = this.fixes;
    this.fixes = {
      timeMs: f.timeMs.filter((_, i) => keep[i]),
      lat: f.lat.filter((_, i) => keep[i]),
      lon: f.lon.filter((_, i) => keep[i]),
      validity: f.validity.filter((_, i) => keep[i]),
      pressureAlt: f.pressureAlt.filter((_, i) => keep[i]),
      gnssAlt: f.gnssAlt.filter((_, i) => keep[i]),
    };
  }

  // ---- per-fix metrics ---------------------------------------------------

  private buildComputedMetrics(): void {
    // Drop rows where time does not strictly advance (df[seconds_delta > 0]).
    const rawDelta = diff(this.fixes.timeMs, 1).map((d) => d / 1000);
    const keep = rawDelta.map((d) => d > 0); // NaN -> false drops the first row
    this.applyMask(keep);

    this.df = this.computeColumns(this.fixes);
    this.calcCumulative(this.df);
  }

  /** Build all per-fix derived columns (shared by main + competition windows). */
  private computeColumns(fx: Fixes): Columns {
    const lat = fx.lat;
    const lon = fx.lon;
    const gnssAlt = fx.gnssAlt;

    const altDelta: Record<number, number[]> = {};
    const secondsDelta: Record<number, number[]> = {};
    const vspeed: Record<number, number[]> = {};
    const distance: Record<number, number[]> = {};

    for (const ti of TIME_INTERVALS) {
      altDelta[ti] = diff(gnssAlt, ti);
      secondsDelta[ti] = diff(fx.timeMs, ti).map((d) => d / 1000);
      vspeed[ti] = divide(altDelta[ti], secondsDelta[ti]);
      const prevLat = shift(lat, ti);
      const prevLon = shift(lon, ti);
      distance[ti] = lat.map((la, i) => haversine(la, lon[i], prevLat[i], prevLon[i]));
    }

    // NaN comparisons resolve to false, matching pandas boolean masks.
    const stoppedToClimb = distance[30].map((d) => d < FORWARD_TRAVEL_THRESHOLD);
    const onGlide = not(stoppedToClimb);
    const climbing = vspeed[5].map((v) => v >= CLIMBING_THRESHOLD);
    const sinking = not(climbing);

    const stoppedAndNotClimbing = and(stoppedToClimb, sinking);
    const stoppedAndClimbing = and(stoppedToClimb, climbing);
    const climbingOnGlide = and(onGlide, climbing);
    const sinkingOnGlide = and(onGlide, sinking);

    const timeClimbingS = where(secondsDelta[1], stoppedToClimb, 0);
    const timeGlidingS = where(secondsDelta[1], onGlide, 0);

    return {
      timeMs: fx.timeMs,
      lat,
      lon,
      gnssAlt,
      altDelta,
      secondsDelta,
      vspeed,
      distance,
      stoppedToClimb,
      onGlide,
      climbing,
      sinking,
      stoppedAndNotClimbing,
      stoppedAndClimbing,
      climbingOnGlide,
      sinkingOnGlide,
      timeClimbingS,
      timeGlidingS,
      // cumulative columns filled by calcCumulative
      totalMetersClimbed: [],
      thermalMetersClimbed: [],
      glideMetersClimbed: [],
      stoppedAndNotClimbingS: [],
      stoppedAndClimbingS: [],
      climbingOnGlideS: [],
      sinkingOnGlideS: [],
      cumulativeTimeClimbingS: [],
      cumulativeTimeGlidingS: [],
      cumulativeDistance: [],
      nextWaypointName: [],
    };
  }

  /** Port of _calculate_cumulative_metrics. */
  private calcCumulative(c: Columns): void {
    // altitude_gain_m = (delta_5s / 5).clip(lower=0)
    const altGain = clip(scale(c.altDelta[5], 1 / 5), 0, undefined);

    c.totalMetersClimbed = cumsum(altGain);
    c.thermalMetersClimbed = cumsum(where(altGain, c.stoppedAndClimbing, 0));
    c.glideMetersClimbed = cumsum(where(altGain, c.climbingOnGlide, 0));

    c.stoppedAndNotClimbingS = cumsumBool(c.stoppedAndNotClimbing);
    c.stoppedAndClimbingS = cumsumBool(c.stoppedAndClimbing);
    c.climbingOnGlideS = cumsumBool(c.climbingOnGlide);
    c.sinkingOnGlideS = cumsumBool(c.sinkingOnGlide);

    c.cumulativeTimeClimbingS = cumsum(c.timeClimbingS);
    c.cumulativeTimeGlidingS = cumsum(c.timeGlidingS);
    c.cumulativeDistance = cumsum(scale(c.distance[20], 1 / 20));
  }

  // ---- competition window ------------------------------------------------

  /** Port of build_computed_comp_metrics + _track_task_progress. */
  buildCompMetrics(task: XcTask): void {
    const startMs = this.compStartMs(task);

    // Python copies the full-flight dataframe (with all per-fix columns already
    // computed) and *filters* by time — it does NOT recompute the per-fix
    // columns. So the first ~30 window rows keep deltas/distances that
    // reference positions before the start gate. We replicate that by slicing,
    // then only recomputing the cumulative metrics over the window.
    let startIdx = this.df.timeMs.findIndex((t) => t >= startMs);
    if (startIdx === -1) startIdx = this.df.timeMs.length; // empty window
    const comp = sliceColumns(this.df, startIdx);

    this.calcCumulative(comp);
    this.trackTaskProgress(comp, task);

    // Crop to (and including) the first COMPLETED row, if reached.
    const goalIdx = comp.nextWaypointName.findIndex((nm) => nm === 'COMPLETED');
    const cropped = goalIdx !== -1 ? sliceColumns(comp, 0, goalIdx + 1) : comp;

    this.compDf = cropped;
    this.calculateStats(cropped);

    // Start-gate crossing: altitude (MSL) and seconds after the gate opened at
    // the fix where the pilot exited the SSS cylinder.
    const exitIdx = this.sssExitIdx;
    if (exitIdx !== null && exitIdx < cropped.timeMs.length) {
      this.stats.comp_start_msl = cropped.gnssAlt[exitIdx];
      this.stats.comp_seconds_after_gate = (cropped.timeMs[exitIdx] - startMs) / 1000;
    } else {
      this.stats.comp_start_msl = null;
      this.stats.comp_seconds_after_gate = null;
    }
  }

  private compStartMs(task: XcTask): number {
    const gate = task.sss.timeGates[0]; // e.g. "19:30:00Z"
    const [h, m, s] = gate.replace('Z', '').split(':').map((p) => parseInt(p, 10));
    // Anchor to the launch day, not the post-rollover `this.day`: for tasks that
    // cross UTC midnight, `this.day` has been advanced during fix parsing, which
    // would push the gate a day past the whole flight and empty the window.
    const day = this.firstDay ?? this.day;
    return new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      h,
      m,
      s,
    ).getTime();
  }

  /** Walk the turnpoint cylinders to label each fix with the next waypoint. */
  private trackTaskProgress(c: Columns, task: XcTask): void {
    const tps = task.turnpoints;
    c.nextWaypointName = new Array<string>(c.timeMs.length).fill('');
    this.sssExitIdx = null;

    let nextIdx = 0;
    if (tps[0]?.type === 'TAKEOFF') nextIdx = 1;
    let entryTime: number | null = null;

    for (let i = 0; i < c.timeMs.length; i++) {
      // Reached the end of the task (ESS is second-to-last turnpoint).
      if (nextIdx >= tps.length - 1) {
        c.nextWaypointName[i] = 'COMPLETED';
        continue;
      }

      const tp = tps[nextIdx];
      const dist = haversine(c.lat[i], c.lon[i], tp.lat, tp.lon);
      const inCylinder = dist <= tp.radius;

      if (inCylinder && entryTime === null) entryTime = c.timeMs[i];

      if (tp.type === 'SSS') {
        // Start: advance once we have entered and then exited the cylinder.
        if (entryTime !== null && !inCylinder) {
          nextIdx += 1;
          entryTime = null;
          if (this.sssExitIdx === null) this.sssExitIdx = i;
        }
      } else {
        // Regular turnpoint: advance on entry.
        if (inCylinder && entryTime !== null) {
          nextIdx += 1;
          entryTime = null;
        }
      }

      // nextIdx advances to at most tps.length-1 (the goal); COMPLETED is
      // emitted on the following iteration by the guard above.
      c.nextWaypointName[i] = tps[nextIdx].name;
    }
  }

  // ---- stats -------------------------------------------------------------

  /** Port of calculate_stats(comp=True). All keys are prefixed `comp_`. */
  private calculateStats(c: Columns): void {
    const s: Stats = this.stats;
    const p = 'comp_';
    const n = c.timeMs.length;
    const last = <T>(a: T[]): T => a[a.length - 1];

    // Initialise every key to 0 (mirrors the Python defaults).
    const keys = [
      'total_meters_climbed', 'thermal_meters_climbed', 'glide_meters_climbed',
      'average_altitude', 'total_distance', 'total_time_climbing_s',
      'total_time_gliding_s', 'total_time_stopped_and_not_climbing_s',
      'total_time_stopped_and_climbing_s', 'total_time_climbing_on_glide_s',
      'percentage_time_climbing_on_glide_s', 'total_time_sinking_on_glide_s',
      'percentage_time_sinking_on_glide_s', 'seconds_maintaining',
      'seconds_>5ms_climb', 'altitude_gain_total', 'altitude_>5ms_climb',
      'percentage_time_>5ms_climb', 'average_climb_rate',
    ];
    for (const k of keys) s[p + k] = 0;
    for (let cr = 1; cr <= 5; cr++) {
      s[`${p}seconds_${cr}ms_climb`] = 0;
      s[`${p}altitude_${cr}ms_climb`] = 0;
      s[`${p}percentage_altitude_${cr}ms_climb`] = 0;
      s[`${p}percentage_time_${cr}ms_climb`] = 0;
    }

    if (n === 0) {
      s.completed = false;
      s.completion_time = null;
      return;
    }

    const v5 = c.vspeed[5];

    s[`${p}total_meters_climbed`] = last(c.totalMetersClimbed);
    s[`${p}thermal_meters_climbed`] = last(c.thermalMetersClimbed);
    s[`${p}glide_meters_climbed`] = last(c.glideMetersClimbed);
    s[`${p}average_altitude`] = nanmean(c.gnssAlt);
    s[`${p}total_distance`] = last(c.cumulativeDistance);
    s[`${p}total_time_climbing_s`] = last(c.cumulativeTimeClimbingS);
    const totalGliding = last(c.cumulativeTimeGlidingS);
    s[`${p}total_time_gliding_s`] = totalGliding;
    s[`${p}total_time_stopped_and_not_climbing_s`] = last(c.stoppedAndNotClimbingS);
    s[`${p}total_time_stopped_and_climbing_s`] = last(c.stoppedAndClimbingS);
    const climbingOnGlide = last(c.climbingOnGlideS);
    s[`${p}total_time_climbing_on_glide_s`] = climbingOnGlide;
    s[`${p}percentage_time_climbing_on_glide_s`] = (climbingOnGlide * 100) / totalGliding;
    const sinkingOnGlide = last(c.sinkingOnGlideS);
    s[`${p}total_time_sinking_on_glide_s`] = sinkingOnGlide;
    s[`${p}percentage_time_sinking_on_glide_s`] = (sinkingOnGlide * 100) / totalGliding;

    s[`${p}seconds_maintaining`] = count(v5, (v) => v > -0.5 && v < 0.5);
    const secGt5 = count(v5, (v) => v >= 5.5);
    s[`${p}seconds_>5ms_climb`] = secGt5;
    const secClimbing = count(v5, (v) => v >= 0.5);
    s[`${p}seconds_climbing_total`] = secClimbing;
    const altGain = sumWhere(v5, (v) => v >= 0.5);
    s[`${p}altitude_gain_total`] = altGain;
    s[`${p}altitude_>5ms_climb`] = sumWhere(v5, (v) => v >= 5.5);
    s[`${p}percentage_time_>5ms_climb`] = secClimbing ? secGt5 / secClimbing : 0;

    const thermalV5 = v5.filter((_, i) => c.stoppedAndClimbing[i]);
    s[`${p}average_climb_rate`] = thermalV5.length > 0 ? nanmean(thermalV5) : 0;

    for (let cr = 1; cr <= 5; cr++) {
      const sec = count(v5, (v) => v >= cr - 0.5 && v < cr + 0.5);
      const alt = sumWhere(v5, (v) => v >= cr - 0.5 && v < cr + 0.5);
      s[`${p}seconds_${cr}ms_climb`] = sec;
      s[`${p}altitude_${cr}ms_climb`] = alt;
      s[`${p}percentage_altitude_${cr}ms_climb`] = altGain ? alt / altGain : 0;
      s[`${p}percentage_time_${cr}ms_climb`] = secClimbing ? sec / secClimbing : 0;
    }

    const completedIdx = c.nextWaypointName.findIndex((nm) => nm === 'COMPLETED');
    const completed = completedIdx !== -1;
    s.completed = completed;
    s.completion_time = completed
      ? (c.timeMs[completedIdx] - c.timeMs[0]) / 1000
      : null;
  }
}

// ---- module-private helpers ---------------------------------------------

/** Slice every column of a Columns object to [start, end), returning a new one. */
function sliceColumns(c: Columns, start: number, end?: number): Columns {
  const n = (a: number[]) => a.slice(start, end);
  const b = (a: boolean[]) => a.slice(start, end);
  const rec = (m: Record<number, number[]>) => {
    const out: Record<number, number[]> = {};
    for (const ti of TIME_INTERVALS) out[ti] = m[ti].slice(start, end);
    return out;
  };
  return {
    timeMs: n(c.timeMs),
    lat: n(c.lat),
    lon: n(c.lon),
    gnssAlt: n(c.gnssAlt),
    altDelta: rec(c.altDelta),
    secondsDelta: rec(c.secondsDelta),
    vspeed: rec(c.vspeed),
    distance: rec(c.distance),
    stoppedToClimb: b(c.stoppedToClimb),
    onGlide: b(c.onGlide),
    climbing: b(c.climbing),
    sinking: b(c.sinking),
    stoppedAndNotClimbing: b(c.stoppedAndNotClimbing),
    stoppedAndClimbing: b(c.stoppedAndClimbing),
    climbingOnGlide: b(c.climbingOnGlide),
    sinkingOnGlide: b(c.sinkingOnGlide),
    timeClimbingS: n(c.timeClimbingS),
    timeGlidingS: n(c.timeGlidingS),
    totalMetersClimbed: n(c.totalMetersClimbed),
    thermalMetersClimbed: n(c.thermalMetersClimbed),
    glideMetersClimbed: n(c.glideMetersClimbed),
    stoppedAndNotClimbingS: n(c.stoppedAndNotClimbingS),
    stoppedAndClimbingS: n(c.stoppedAndClimbingS),
    climbingOnGlideS: n(c.climbingOnGlideS),
    sinkingOnGlideS: n(c.sinkingOnGlideS),
    cumulativeTimeClimbingS: n(c.cumulativeTimeClimbingS),
    cumulativeTimeGlidingS: n(c.cumulativeTimeGlidingS),
    cumulativeDistance: n(c.cumulativeDistance),
    nextWaypointName: c.nextWaypointName.slice(start, end),
  };
}

function parseIgcDate(ddmmyy: string): Date {
  const dd = parseInt(ddmmyy.slice(0, 2), 10);
  const mm = parseInt(ddmmyy.slice(2, 4), 10);
  const yy = parseInt(ddmmyy.slice(4, 6), 10);
  return new Date(2000 + yy, mm - 1, dd);
}

function count(arr: number[], pred: (v: number) => boolean): number {
  let n = 0;
  for (const v of arr) if (!Number.isNaN(v) && pred(v)) n++;
  return n;
}

function sumWhere(arr: number[], pred: (v: number) => boolean): number {
  let sum = 0;
  for (const v of arr) if (!Number.isNaN(v) && pred(v)) sum += v;
  return sum;
}
