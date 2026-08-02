/**
 * Port of comp_analysis.py — orchestrates multiple pilots against one task and
 * builds the data for the stats table and the climb-rate distribution chart.
 */

import { IgcFlight, type Stats } from './igc';
import { parseXcTask, DEFAULT_TASK_KIND, type XcTask, type TaskKind } from './xctsk';
import { buildGeom, taskDistanceM, remainingSeries, smoothAlt, tauSeries } from './timetogo';

/** Derive a readable fallback pilot name from an IGC filename. */
export function nameFromFile(filename: string): string {
  return (
    filename
      .replace(/\.igc$/i, '')
      .replace(/_\d{4}-\d{2}-\d{2}.*$/, '') // strip trailing date/id segment
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || filename
  );
}
import { haversine } from './math';

export type GradientDir = 'least_positive' | 'most_positive' | 'most_negative' | null;

/** One column of the stats table: a stats key, its shading, and its heading. */
export interface MetricColumn {
  key: string;
  dir: GradientDir;
  label: string;
}

/** Mirror of COMP_SUBSET: [stats key] -> [gradient direction, display label]. */
export const COMP_SUBSET: MetricColumn[] = [
  { key: 'name', dir: null, label: 'Pilot Name' },
  { key: 'completion_time', dir: 'least_positive', label: 'Completion Time (s)' },
  { key: 'comp_start_msl', dir: 'most_positive', label: 'Start Altitude MSL (m)' },
  { key: 'comp_finish_msl', dir: 'most_positive', label: 'Finish Altitude MSL (m)' },
  { key: 'comp_seconds_after_gate', dir: 'least_positive', label: 'Start After Gate (s)' },
  { key: 'comp_total_time_climbing_s', dir: 'least_positive', label: 'Total Climbing (s)' },
  { key: 'comp_average_climb_rate', dir: 'most_positive', label: 'Average Climb Rate (m/s)' },
  { key: 'comp_total_meters_climbed', dir: null, label: 'Total Meters Climbed (m)' },
  { key: 'comp_thermal_meters_climbed', dir: null, label: 'Thermal Meters Climbed (m)' },
  { key: 'comp_glide_meters_climbed', dir: 'most_positive', label: 'Altitude Gain on Glide (m)' },
  { key: 'comp_total_time_stopped_and_climbing_s', dir: 'least_positive', label: 'Stopped and Climbing (s)' },
  { key: 'comp_total_time_stopped_and_not_climbing_s', dir: 'most_negative', label: 'Stopped and Not Climbing (s)' },
  { key: 'comp_total_distance', dir: 'least_positive', label: 'Total Distance Flown (m)' },
  { key: 'comp_total_time_gliding_s', dir: 'least_positive', label: 'Total Gliding (s)' },
  { key: 'comp_percentage_time_climbing_on_glide_s', dir: 'most_positive', label: 'Climbing on Glide (%)' },
  { key: 'comp_average_altitude', dir: 'most_positive', label: 'Average Altitude (m)' },
];

/**
 * Hike and fly: deliberately the smallest set that still describes the day.
 *
 * The columns dropped from COMP_SUBSET aren't unavailable — every `comp_*` stat
 * is still computed the same way — they're withheld because a hiked leg reads as
 * flying with none of the flying: the pilot is on the ground gaining height at
 * walking pace, which lands in the stopped/climbing states and drags the
 * thermal, glide and start-height metrics away from anything comparable between
 * pilots. What's left holds up either way: how long the task took, how far and
 * how high they flew, and the climbing they did (rate excluded — see above).
 * Add columns here as the metrics are made hike-aware, one at a time.
 */
export const HIKE_AND_FLY_SUBSET: MetricColumn[] = [
  { key: 'name', dir: null, label: 'Pilot Name' },
  { key: 'completion_time', dir: 'least_positive', label: 'Completion Time (s)' },
  { key: 'comp_total_distance', dir: 'least_positive', label: 'Total Distance Flown (m)' },
  { key: 'comp_total_meters_climbed', dir: null, label: 'Total Meters Climbed (m)' },
  { key: 'comp_average_altitude', dir: 'most_positive', label: 'Average Altitude (m)' },
];

/** The stats-table columns for a task kind. */
export function metricsFor(kind: TaskKind): MetricColumn[] {
  return kind === 'hike-and-fly' ? HIKE_AND_FLY_SUBSET : COMP_SUBSET;
}

const CLIMB_RATE_LABELS = ['1ms', '2ms', '3ms', '4ms', '5ms', '>5ms'];
export const CLIMB_RATE_TICKS = ['1 m/s', '2 m/s', '3 m/s', '4 m/s', '5 m/s', '>5 m/s'];

// Time Lost glide parameters. Vg (ground speed while gliding) and g (ground
// glide ratio, ≡ Vg/sink) are MEASURED per day from the par pilots' gliding
// fixes — see measureGlide() — like M already is from their climbs. These
// constants are only the fallback for a day too sparse to measure (and the
// sink threshold that classifies a fix as gliding).
const DEFAULT_GLIDE_SPEED_KMH = 60;
const DEFAULT_GLIDE_RATIO = 7;
/** A fix is gliding when smoothed dh/dt < −this (m/s); climbing when > +this. */
const GLIDE_SINK_THRESHOLD_MPS = 0.3;
/** Don't trust Vg/g measured from less than this much total gliding. */
const MIN_GLIDE_SAMPLE_S = 600;

export interface PilotRow {
  name: string;
  completed: boolean;
  stats: Stats;
  /** Track coordinates ([lat, lon] pairs) for the map view. */
  track: [number, number][];
  /** Epoch-ms timestamp for each track point, aligned with `track`. */
  trackTimes: number[];
  /** GPS altitude (m) for each track point, aligned with `track`. */
  trackAlt: number[];
  /** Epoch-ms of the SSS start gate for this flight. */
  startGateMs: number | null;
}

export interface MapTurnpoint {
  lat: number;
  lon: number;
  radius: number;
  name: string;
  type: string | null;
  order: number;
}

export interface MapTrack {
  pilot: string;
  completed: boolean;
  points: [number, number][];
  /** Epoch-ms timestamp for each point, aligned with `points`. */
  times: number[];
  /** GPS altitude (m) for each point, aligned with `points`. */
  alt: number[];
  /** Time Lost at par (minutes) at each point, aligned with `points`; absent if
   * the day has no usable ESS/finisher data. See timetogo.ts. */
  tau?: number[];
  /** Epoch-ms of the ESS crossing (scored completion), or null if not a finisher. */
  completionMs?: number | null;
  /** Epoch-ms of the SSS crossing (scored start); the Time Lost plot cuts the
   * pre-start hold off before this. Null falls back to drawing from the first fix. */
  startCrossMs?: number | null;
  /** Per fix: is the pilot above the glide slope (on final glide = "altitude is
   * useless" regime)? Aligned with `points`. Highlighted in the chart. */
  finalGlide?: boolean[];
}

export interface MapData {
  turnpoints: MapTurnpoint[];
  tracks: MapTrack[];
  /**
   * XC comp or hike and fly. This is the one place the kind travels to the
   * client — the results JSON is built from a Competition, so every consumer
   * reads it from here rather than being told separately. It gates the Time Lost
   * chart in the 3D viewer, and it is why `timeToGo` and `tau` are absent on a
   * hike-and-fly day.
   */
  taskKind: TaskKind;
  /** Minutes to add to UTC for local task time; null = display UTC. */
  utcOffsetMinutes: number | null;
  /** Epoch-ms of the SSS start gate (for the start-time marker); null if unknown. */
  startMs: number | null;
  /** Day-level par constants for the Time Lost chart; null if unavailable —
   * either no usable ESS/finisher data, or a hike-and-fly task, whose part-hiked
   * legs the air-only par model doesn't describe.
   * `tauRef` is the common par-ghost anchor (minutes): the par pilot's Time Lost
   * from the start, tauSeries evaluated at (dTask, hRef). See timetogo.ts
   * `lostSeries`; L(t) = tau(t) + (t − t_gate)/60 − tauRef is "minutes behind
   * the par ghost". */
  timeToGo: {
    M: number;
    /** Par pace over the whole course (m/s) — a day stat; τ derives its own
     * pace from Vg, g and M. */
    Vcc: number;
    /** Par ground speed while gliding (m/s), measured from the par pilots. */
    Vg: number;
    /** Par ground glide ratio (course metres per metre of height), ≡ Vg/sink. */
    g: number;
    /** Model→reality pace fit: actual median par duration ÷ raw two-phase τ at
     * the reference start. τ and tauRef ship pre-multiplied by this; it is
     * carried so the scaling is auditable. */
    pace: number;
    hFin: number;
    dTask: number; // optimised task distance SSS→ESS (m)
    hRef: number; // reference start altitude (fleet-median start-gate crossing, m MSL)
    tauRef: number; // tauSeries(dTask, hRef): dTask/Vg/60 + max(0, dTask/g − (hRef−hFin))/M/60
  } | null;
}

export interface TableCell {
  /** Display text. */
  text: string;
  /** Raw numeric value used for gradient shading (NaN if not applicable). */
  value: number;
}

export interface StatsTable {
  headers: string[];
  /** Per-column gradient direction (null = no shading), aligned with COMP_SUBSET. */
  dirs: GradientDir[];
  completed: TableCell[][];
  incomplete: TableCell[][];
}

export interface ClimbSeries {
  pilot: string;
  /** percentage of climbing time at each of the 6 climb-rate buckets */
  values: number[];
  /** average climb rate (m/s) for the vertical reference line */
  avgClimbRate: number;
}

export interface ClimbData {
  completed: ClimbSeries[];
  incomplete: ClimbSeries[];
}

/**
 * One pilot's gap to the winner, in seconds, split by where it was spent.
 * `start + thermalGain + thermalFlat + glideGain + glideSink === total`.
 * Positive = slower than the winner in that phase.
 */
export interface TimeLossRow {
  pilot: string;
  /**
   * True only for the winner's row, whose deltas are measured against the
   * top-N average rather than the winner. Flips the reference wording in the
   * UI; the sign convention (positive = slower/more than the reference) is
   * unchanged.
   */
  referenceIsAvg: boolean;
  total: number;
  /** Later across the start line than the winner. */
  start: number;
  /** Longer spent thermalling while actually gaining height. */
  thermalGain: number;
  /** Longer spent stopped without gaining — zeros, sink, re-centring. */
  thermalFlat: number;
  /**
   * Longer spent gliding (moving forward), lift and sink merged. All gliding is
   * progress, so this is not a good/bad axis at the time level — the lift/sink
   * quality lives in `altGlide` instead. Sums the underlying glide-gain and
   * glide-sink seconds.
   */
  glide: number;
  /**
   * Height counterpart to each component, in metres relative to the winner.
   * `altStart` compares start altitude MSL; the rest compare net height change
   * within that state, and `altGlide` (net metres gained or lost while gliding)
   * is where the lift-vs-sink glide quality shows up. Positive means more height
   * than the winner (gained more, or lost less) — not automatically better, so
   * these read as context for the time gap rather than a second scoring axis.
   */
  altStart: number;
  altThermalGain: number;
  altThermalFlat: number;
  altGlide: number;
  /**
   * Height at the finish (ESS) relative to the winner. Because the four state
   * values are net changes off the start altitude, this is the height column's
   * total in the same way `total` is the time column's:
   * `altStart + the four state deltas === altFinish`.
   */
  altFinish: number;
  /**
   * Descriptive context metrics — each pilot's own value plus its gap to the
   * winner. These characterise *how* a pilot flew but are not additive
   * components of the time or height totals, so they live in a separate block,
   * not the summing grid.
   */
  context: { avgClimbRate: number; avgAltitude: number; totalDistance: number };
  contextVsWinner: { avgClimbRate: number; avgAltitude: number; totalDistance: number };
}

/** How many of the fastest finishers the winner's row is averaged against. */
export const TIME_LOSS_TOP_N = 10;

export interface TimeLossData {
  /** Reference pilot (fastest completion), or null if nobody completed. */
  winner: string | null;
  rows: TimeLossRow[];
  /**
   * Number of finishers the winner's row is measured against (min(top-N,
   * field size)). 1 means the winner was the only finisher, so their row has
   * no reference and stays all-zero.
   */
  topCount: number;
  /**
   * Largest absolute gap-to-winner in the field for each context metric, used
   * to scale the reference bars. Unlike the decomposition bars (scaled within a
   * pilot's own row), a lone context metric has nothing in-row to size against,
   * so its bar is field-relative: full width = the biggest gap that day.
   */
  contextScale: { avgClimbRate: number; avgAltitude: number; totalDistance: number };
}

export class Competition {
  task: XcTask;
  pilots: PilotRow[] = [];
  /** Minutes to add to UTC for local task time (from archive meta); null = UTC. */
  utcOffsetMinutes: number | null;
  /** XC comp or hike and fly — see xctsk.ts `TaskKind`. Chooses the metric set
   * and whether the par/Time Lost model runs at all. */
  kind: TaskKind;

  constructor(
    taskText: string,
    utcOffsetMinutes: number | null = null,
    kind: TaskKind = DEFAULT_TASK_KIND,
  ) {
    this.task = parseXcTask(taskText);
    this.utcOffsetMinutes = utcOffsetMinutes;
    this.kind = kind;
  }

  /**
   * The whole client payload for this day: metrics table, climb distribution,
   * map/track data, and the time-loss decomposition. What the build-time archive
   * endpoint serialises and what the upload page renders directly, so both go
   * through the same kind-dependent choices rather than each assembling their own
   * set.
   */
  buildResults(): {
    table: StatsTable;
    climb: ClimbData;
    map: MapData;
    timeLoss: TimeLossData;
  } {
    return {
      table: this.buildStatsTable(),
      climb: this.buildClimbData(),
      map: this.buildMapData(),
      timeLoss: this.buildTimeLoss(),
    };
  }

  /**
   * Rank two tracklogs for the same pilot on the same day, higher is better.
   *
   * A pilot can appear more than once in a day's files — a partial upload
   * alongside the real flight (Mike Steed's chelan-us-open day 1 pair is a
   * 344-byte stub next to a 126 km flight), or the same flight logged by two
   * instruments. Reaching goal beats not reaching it; otherwise the track that
   * covers more of the task is the more complete recording.
   */
  private static trackScore(row: PilotRow): [number, number] {
    const distance = Number(row.stats.comp_total_distance);
    return [row.completed ? 1 : 0, Number.isFinite(distance) ? distance : -1];
  }

  private static isBetter(candidate: PilotRow, incumbent: PilotRow): boolean {
    const [ac, ad] = Competition.trackScore(candidate);
    const [bc, bd] = Competition.trackScore(incumbent);
    return ac !== bc ? ac > bc : ad > bd;
  }

  /**
   * Parse an IGC file, compute competition metrics, and register the pilot.
   *
   * If this pilot already has a track for the day, the better of the two is
   * kept (see trackScore) and the other discarded — one row per pilot, so the
   * stats table, charts and map don't show the same person twice.
   */
  addPilot(igcText: string, fallbackName: string): PilotRow {
    const flight = new IgcFlight(igcText, fallbackName);
    flight.buildCompMetrics(this.task);
    const row: PilotRow = {
      name: flight.pilotName,
      completed: flight.stats.completed === true,
      stats: { ...flight.stats, name: flight.pilotName as unknown as number },
      startGateMs: flight.startGateMs,
      // Crop the displayed track to [start gate − 15 min, end] so the map and
      // altitude plot aren't dominated by ground time: end at the goal crossing
      // if the pilot reached goal, otherwise at landing (last fix). Stats are
      // unaffected — they still run over the full flight above.
      ...cropAndDownsample(flight, this.task),
    };

    const existingIdx = this.pilots.findIndex((p) => p.name === row.name);
    if (existingIdx === -1) {
      this.pilots.push(row);
      return row;
    }

    const existing = this.pilots[existingIdx];
    if (Competition.isBetter(row, existing)) {
      this.pilots[existingIdx] = row;
      return row;
    }
    return existing;
  }

  // ---- map view ----------------------------------------------------------

  buildMapData(): MapData {
    const turnpoints: MapTurnpoint[] = this.task.turnpoints.map((tp) => ({
      lat: tp.lat,
      lon: tp.lon,
      radius: tp.radius,
      name: tp.name,
      type: tp.type,
      order: tp.order,
    }));

    // Time Lost: par constants from the results, then a τ series per track. See
    // timetogo.ts. Guarded so a task without a usable ESS/finishers just omits it.
    // Hike and fly omits it by kind, not by data: the model prices a leg as climb
    // plus glide, and a leg walked up a hill is neither, so a "par pilot" fitted
    // to those durations describes nothing. Skipping it here is also what removes
    // the Time Lost chart downstream (see mountTimeline) and keeps the per-track
    // τ arrays out of the day JSON.
    const modelsPar = this.kind === 'xc';
    const geom = buildGeom(turnpoints);
    const taskDist = geom.cx.length >= 2 ? taskDistanceM(geom) : 0;
    // Par is measured from the day's fastest PAR_N finishers: M = median climb,
    // V_cc = optimised task dist ÷ median completion (a day stat — τ derives its
    // own pace from Vg/g/M plus the pace fit below). h_fin = min crossing
    // altitude across ALL finishers.
    const PAR_N = 10;
    const finishers = this.pilots
      .filter((p) => p.completed && num(p.stats.completion_time) > 0)
      .sort((a, b) => num(a.stats.completion_time) - num(b.stats.completion_time));
    const par = finishers.slice(0, PAR_N);
    const climbs = par.map((p) => num(p.stats.comp_average_climb_rate)).filter(Number.isFinite);
    const compTimes = par.map((p) => num(p.stats.completion_time)).filter((v) => Number.isFinite(v) && v > 0);
    const finishes = finishers.map((p) => num(p.stats.comp_finish_msl)).filter(Number.isFinite);
    const M = median(climbs);
    const medComp = median(compTimes);
    const Vcc = medComp > 0 ? taskDist / medComp : 0;
    const hFin = finishes.length ? Math.min(...finishes) : 0;
    const hasTau = modelsPar && geom.cx.length >= 2 && M > 0 && Vcc > 0 && finishers.length > 0;

    // Per-pilot D_rem + smoothed height (used for τ, finalGlide, and the SSS-exit
    // altitude), computed once so the ghost anchor h_ref can be taken across the fleet.
    const startCrossOf = (p: PilotRow): number | null => {
      if (p.startGateMs == null) return null;
      const sa = num(p.stats.comp_seconds_after_gate);
      return p.startGateMs + (Number.isFinite(sa) ? sa * 1000 : 0);
    };
    const perPilot = this.pilots
      .filter((p) => p.track.length > 0)
      .map((p) => {
        const rem = hasTau ? remainingSeries(geom, p.track) : [];
        const h = hasTau ? smoothAlt(p.trackTimes, p.trackAlt) : [];
        const startCrossMs = startCrossOf(p);
        let startExitAlt: number | null = null;
        if (hasTau && startCrossMs != null) {
          let si = 0;
          while (si < p.trackTimes.length && p.trackTimes[si] < startCrossMs) si++;
          if (si < h.length) startExitAlt = h[si];
        }
        return { p, rem, h, startCrossMs, startExitAlt };
      });

    // Ghost anchor: h_ref = fleet-median smoothed altitude at the SSS exit;
    // tau_ref = par Time Lost from the start (one common value). See lostSeries.
    const startExitAlts = perPilot
      .map((c) => c.startExitAlt)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const hRef = startExitAlts.length ? median(startExitAlts) : hFin;

    // Par glide pace, measured the way M already is: over the par pilots' scored
    // fixes, a fix sinking faster than the threshold is gliding; Vg is their
    // course progress per second of that, and g their course metres per metre of
    // height spent (g ≡ Vg/sink by construction, which is what makes par gliding
    // exactly neutral in tauSeries). Sparse days fall back to the constants.
    const parSet = new Set<PilotRow>(par);
    let glideCourseM = 0;
    let glideDropM = 0;
    let glideTimeS = 0;
    if (hasTau) {
      for (const { p, rem, h, startCrossMs } of perPilot) {
        if (!parSet.has(p) || startCrossMs == null) continue;
        const ct = num(p.stats.completion_time);
        const endMs =
          Number.isFinite(ct) && p.startGateMs != null ? p.startGateMs + ct * 1000 : Infinity;
        for (let i = 1; i < p.trackTimes.length; i++) {
          if (p.trackTimes[i] < startCrossMs || p.trackTimes[i] > endMs) continue;
          const dt = (p.trackTimes[i] - p.trackTimes[i - 1]) / 1000;
          if (dt <= 0 || dt > 30) continue; // track gap — rates across it mean nothing
          const dh = h[i] - h[i - 1];
          if (dh / dt >= -GLIDE_SINK_THRESHOLD_MPS) continue;
          glideCourseM += rem[i - 1] - rem[i];
          glideDropM += -dh;
          glideTimeS += dt;
        }
      }
    }
    const glideMeasured =
      glideTimeS >= MIN_GLIDE_SAMPLE_S && glideCourseM > 0 && glideDropM > 0;
    const Vg = glideMeasured ? glideCourseM / glideTimeS : DEFAULT_GLIDE_SPEED_KMH / 3.6;
    const g = glideMeasured ? glideCourseM / glideDropM : DEFAULT_GLIDE_RATIO;

    const tauParams = { glideMps: Vg, glideRatio: g, climbMps: M, hFinM: hFin };
    // Pace fit. The two-phase model prices only climbing and gliding, but real
    // par flying also makes ground WHILE climbing (thermal drift) and while
    // porpoising a line at constant height — so the raw model runs slower than
    // the day it describes, and against it every pilot trends steadily ahead:
    // a par line sloping down instead of horizontal. One measured ratio pins
    // it: scale τ so the ghost's time from the reference start state equals the
    // par pilots' actual median gate→ESS duration. tauRef then IS that median
    // duration, the par line is horizontal by construction, and a finisher's
    // final L reads as literal minutes behind the median winner.
    const tauRefRaw = hasTau ? tauSeries([taskDist], [hRef], tauParams)[0] : 0;
    const pace = tauRefRaw > 0 && medComp > 0 ? medComp / 60 / tauRefRaw : 1;
    const tauRef = tauRefRaw * pace;

    const tracks: MapTrack[] = perPilot.map(({ p, rem, h, startCrossMs }) => {
      const base: MapTrack = {
        pilot: p.name,
        completed: p.completed,
        points: p.track,
        times: p.trackTimes,
        alt: p.trackAlt,
      };
      if (!hasTau) return base;
      base.tau = tauSeries(rem, h, tauParams).map((v) => Math.round(v * pace * 100) / 100);
      base.finalGlide = rem.map((d, i) => h[i] > hFin + d / g);
      const ct = num(p.stats.completion_time);
      base.completionMs =
        p.completed && Number.isFinite(ct) && p.startGateMs != null ? p.startGateMs + ct * 1000 : null;
      base.startCrossMs = startCrossMs;
      return base;
    });

    // All pilots share the same gate time-of-day; take the first finite one.
    const startMs = this.pilots.find((p) => p.startGateMs != null)?.startGateMs ?? null;

    return {
      turnpoints,
      tracks,
      taskKind: this.kind,
      utcOffsetMinutes: this.utcOffsetMinutes,
      startMs,
      timeToGo: hasTau ? { M, Vcc, Vg, g, pace, hFin, dTask: taskDist, hRef, tauRef } : null,
    };
  }

  // ---- stats table -------------------------------------------------------

  buildStatsTable(): StatsTable {
    const completed = this.pilots
      .filter((p) => p.completed)
      .sort((a, b) => num(a.stats.completion_time) - num(b.stats.completion_time));
    const incomplete = this.pilots.filter((p) => !p.completed);
    const columns = metricsFor(this.kind);

    return {
      headers: columns.map((c) => c.label),
      dirs: columns.map((c) => c.dir),
      completed: this.buildRows(completed, columns),
      incomplete: this.buildRows(incomplete, columns),
    };
  }

  // Emit text + raw value per cell. Gradient shading is applied client-side so
  // it can react to the current pilot selection.
  private buildRows(rows: PilotRow[], columns: MetricColumn[]): TableCell[][] {
    return rows.map((row) =>
      columns.map((col) => {
        const raw = row.stats[col.key];
        if (col.key === 'name') {
          return { text: String(raw), value: NaN };
        }
        const value = num(raw);
        const text = Number.isFinite(value) ? value.toFixed(2) : '—';
        return { text, value };
      }),
    );
  }

  // ---- time-loss decomposition ------------------------------------------

  /**
   * Break each completing pilot's gap to the winner into additive components.
   *
   * Every pilot's `completion_time` is measured from the same reference (the
   * start gate opening, see IgcFlight.buildCompMetrics), so elapsed times are
   * directly comparable. That total splits exactly into the pre-start loiter
   * (`comp_seconds_after_gate`) plus four mutually-exclusive post-start states,
   * so the per-component gaps to the winner sum to the total gap with no
   * residual — see the `secs_*` block in IgcFlight.calculateStats.
   *
   * For display the two glide states (lift vs sink) are merged into one
   * `glide` component: all gliding is forward progress, so splitting it by
   * lift/sink carries no good/bad meaning at the time level. That quality
   * survives in the height column as `altGlide` (net metres on glide). The
   * merge preserves both additive identities.
   *
   * Empty on a hike-and-fly task: the decomposition is exactly the four air
   * states (thermalling, gliding, stopped), and a hiked leg belongs to none of
   * them, so the breakdown would attribute walking to zeros and re-centring. The
   * empty result is what leaves the breakdown panel off the stats table — see
   * `applyHighlight` in scripts/analysis.ts, which still shows the pinned
   * pilot's claim control without it.
   */
  buildTimeLoss(): TimeLossData {
    const empty: TimeLossData = {
      winner: null,
      rows: [],
      contextScale: { avgClimbRate: 0, avgAltitude: 0, totalDistance: 0 },
      topCount: 0,
    };
    if (this.kind !== 'xc') return empty;

    const completed = this.pilots
      .filter((p) => p.completed)
      .sort((a, b) => num(a.stats.completion_time) - num(b.stats.completion_time));
    const winner = completed[0];
    if (!winner) return empty;

    // The winner has no one ahead to measure against, so their all-zero row
    // would be dead weight. Instead the winner is compared to the average of
    // the top finishers — the same decomposition, now showing where the winner
    // beat (or trailed) the field. The average is additive, so every identity
    // that holds against a single winner also holds against it.
    const topN = completed.slice(0, TIME_LOSS_TOP_N);
    const avgOf = (key: string): number => {
      const vals = topN.map((p) => num(p.stats[key])).filter(Number.isFinite);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
    };

    const rows = completed.map((p) => {
      const referenceIsAvg = p === winner;
      // What this pilot is measured against on a given stat: the top-N average
      // for the winner, the winner's flight for everyone else.
      const ref = (key: string): number =>
        referenceIsAvg ? avgOf(key) : num(winner.stats[key]);
      // Gap to the reference on a single stat.
      const d = (key: string): number => num(p.stats[key]) - ref(key);
      // Same, but for a height stat that may be absent (no SSS exit / no
      // finish): keep NaN rather than letting `null - null = 0` masquerade as a
      // real zero delta.
      const altD = (key: string): number => {
        const v = num(p.stats[key]) - ref(key);
        return Number.isFinite(v) ? v : NaN;
      };
      return {
        pilot: p.name,
        referenceIsAvg,
        total: num(p.stats.completion_time) - ref('completion_time'),
        start: d('comp_seconds_after_gate'),
        thermalGain: d('comp_secs_thermal_gain'),
        thermalFlat: d('comp_secs_thermal_flat'),
        glide: d('comp_secs_glide_gain') + d('comp_secs_glide_sink'),
        altStart: altD('comp_start_msl'),
        altThermalGain: altD('comp_alt_thermal_gain'),
        altThermalFlat: altD('comp_alt_thermal_flat'),
        altGlide: altD('comp_alt_glide_gain') + altD('comp_alt_glide_sink'),
        altFinish: altD('comp_finish_msl'),
        context: {
          avgClimbRate: num(p.stats.comp_average_climb_rate),
          avgAltitude: num(p.stats.comp_average_altitude),
          totalDistance: num(p.stats.comp_total_distance),
        },
        contextVsWinner: {
          avgClimbRate: d('comp_average_climb_rate'),
          avgAltitude: d('comp_average_altitude'),
          totalDistance: d('comp_total_distance'),
        },
      };
    });

    const fieldMax = (pick: (r: TimeLossRow) => number): number =>
      Math.max(0, ...rows.map((r) => Math.abs(pick(r))).filter(Number.isFinite));
    const contextScale = {
      avgClimbRate: fieldMax((r) => r.contextVsWinner.avgClimbRate),
      avgAltitude: fieldMax((r) => r.contextVsWinner.avgAltitude),
      totalDistance: fieldMax((r) => r.contextVsWinner.totalDistance),
    };

    return { winner: winner.name, rows, contextScale, topCount: topN.length };
  }

  // ---- climb-rate distribution ------------------------------------------

  buildClimbData(): ClimbData {
    const toSeries = (rows: PilotRow[]): ClimbSeries[] =>
      rows.map((r) => ({
        pilot: r.name,
        values: CLIMB_RATE_LABELS.map(
          (lbl) => num(r.stats[`comp_percentage_time_${lbl}_climb`]) * 100,
        ),
        avgClimbRate: num(r.stats.comp_average_climb_rate),
      }));

    return {
      completed: toSeries(this.pilots.filter((p) => p.completed)),
      incomplete: toSeries(this.pilots.filter((p) => !p.completed)),
    };
  }
}

// ---- helpers -------------------------------------------------------------

function num(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  return typeof v === 'number' ? v : Number(v);
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const PRE_START_MS = 15 * 60 * 1000; // show 15 min before the start gate

/**
 * First time (epoch ms) at/after `fromMs` that the flight enters the goal — the
 * task's final turnpoint cylinder — or null if it never does. The flight's
 * `completed` flag only reaches ESS (the second-to-last turnpoint), so this
 * walks the final glide on to the goal.
 */
function goalCrossingMs(flight: IgcFlight, task: XcTask, fromMs: number): number | null {
  const goal = task.turnpoints[task.turnpoints.length - 1];
  if (!goal) return null;
  const { lat, lon, timeMs } = flight.df;
  for (let i = timeMs.findIndex((t) => t >= fromMs); i >= 0 && i < timeMs.length; i++) {
    if (haversine(lat[i], lon[i], goal.lat, goal.lon) <= goal.radius) return timeMs[i];
  }
  return null;
}

/**
 * Crop a flight's display track to [start gate − 15 min, end] and thin it.
 * `end` is the goal-crossing time when the pilot reached the final goal
 * cylinder, else the last fix (landing). Falls back to the full track if timing
 * is unavailable.
 */
function cropAndDownsample(
  flight: IgcFlight,
  task: XcTask,
): { track: [number, number][]; trackTimes: number[]; trackAlt: number[] } {
  const { lat, lon, timeMs, gnssAlt } = flight.df;
  const n = timeMs.length;

  const gate = flight.startGateMs;
  // The flight completes the scored task at ESS; from there, follow the glide
  // into the goal cylinder. End at the goal crossing if reached, else landing.
  const essMs =
    flight.stats.completed === true && flight.compDf?.timeMs.length
      ? flight.compDf.timeMs[flight.compDf.timeMs.length - 1]
      : null;
  const goalMs = essMs !== null ? goalCrossingMs(flight, task, essMs) : null;
  const endMs = goalMs ?? timeMs[n - 1];

  // Drop pilots whose flight ended before the start — they flew and landed
  // before the task began, so they'd only clutter the plots.
  if (gate !== null && endMs < gate) return { track: [], trackTimes: [], trackAlt: [] };

  let s = 0;
  if (gate !== null) {
    const startMs = gate - PRE_START_MS;
    const found = timeMs.findIndex((t) => t >= startMs);
    s = found === -1 ? 0 : found;
  }
  let e = n - 1;
  while (e > s && timeMs[e] > endMs) e--;
  if (e <= s) {
    s = 0;
    e = n - 1;
  }

  const crop = <T>(a: T[]): T[] => a.slice(s, e + 1);
  return downsample(crop(lat), crop(lon), crop(timeMs), crop(gnssAlt));
}

/**
 * Thin a track down to at most ~maxPoints fixes for lightweight map rendering,
 * always keeping the first and last fix. Returns [lat, lon] pairs and their
 * epoch-ms timestamps in lockstep so the time slider can scrub by position.
 */
function downsample(
  lat: number[],
  lon: number[],
  timeMs: number[],
  alt: number[],
  maxPoints = 1500,
): { track: [number, number][]; trackTimes: number[]; trackAlt: number[] } {
  const n = Math.min(lat.length, lon.length);
  const track: [number, number][] = [];
  const trackTimes: number[] = [];
  const trackAlt: number[] = [];
  if (n === 0) return { track, trackTimes, trackAlt };
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const push = (i: number): void => {
    if (Number.isFinite(lat[i]) && Number.isFinite(lon[i])) {
      track.push([lat[i], lon[i]]);
      trackTimes.push(timeMs[i]);
      trackAlt.push(alt[i]);
    }
  };
  for (let i = 0; i < n; i += step) push(i);
  const last = n - 1;
  if (last % step !== 0) push(last);
  return { track, trackTimes, trackAlt };
}

/**
 * Port of generate_colors_for_df's per-cell colour logic.
 * shade=230; green channel highlighted for "*_positive", red for "*_negative".
 */
export function gradientColor(
  value: number,
  min: number,
  max: number,
  dir: GradientDir,
): string | null {
  if (!dir || !Number.isFinite(value)) return null;
  let norm = max > min ? (value - min) / (max - min) : 0;

  const [first, second] = dir.split('_');
  const ascending = first === 'most';
  const colorGreen = second === 'positive';
  if (ascending) norm = 1 - norm;

  const shade = 230;
  const r = colorGreen ? Math.round(shade * norm) : shade;
  const g = colorGreen ? shade : Math.round(shade * norm);
  const b = Math.round(shade * norm);
  return `rgb(${r},${g},${b})`;
}
