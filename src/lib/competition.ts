/**
 * Port of comp_analysis.py — orchestrates multiple pilots against one task and
 * builds the data for the stats table and the climb-rate distribution chart.
 */

import { IgcFlight, type Stats } from './igc';
import { parseXcTask, type XcTask } from './xctsk';

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

/** Mirror of COMP_SUBSET: [stats key] -> [gradient direction, display label]. */
export const COMP_SUBSET: { key: string; dir: GradientDir; label: string }[] = [
  { key: 'name', dir: null, label: 'Pilot Name' },
  { key: 'completion_time', dir: 'least_positive', label: 'Completion Time (s)' },
  { key: 'comp_start_msl', dir: 'most_positive', label: 'Start Altitude MSL (m)' },
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

const CLIMB_RATE_LABELS = ['1ms', '2ms', '3ms', '4ms', '5ms', '>5ms'];
export const CLIMB_RATE_TICKS = ['1 m/s', '2 m/s', '3 m/s', '4 m/s', '5 m/s', '>5 m/s'];

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
}

export interface MapData {
  turnpoints: MapTurnpoint[];
  tracks: MapTrack[];
  /** Minutes to add to UTC for local task time; null = display UTC. */
  utcOffsetMinutes: number | null;
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

export class Competition {
  task: XcTask;
  pilots: PilotRow[] = [];
  /** Minutes to add to UTC for local task time (from archive meta); null = UTC. */
  utcOffsetMinutes: number | null;

  constructor(taskText: string, utcOffsetMinutes: number | null = null) {
    this.task = parseXcTask(taskText);
    this.utcOffsetMinutes = utcOffsetMinutes;
  }

  /** Parse an IGC file, compute competition metrics, and register the pilot. */
  addPilot(igcText: string, fallbackName: string): PilotRow {
    const flight = new IgcFlight(igcText, fallbackName);
    flight.buildCompMetrics(this.task);
    const row: PilotRow = {
      name: flight.pilotName,
      completed: flight.stats.completed === true,
      stats: { ...flight.stats, name: flight.pilotName as unknown as number },
      // Crop the displayed track to [start gate − 15 min, end] so the map and
      // altitude plot aren't dominated by ground time: end at the goal crossing
      // if the pilot reached goal, otherwise at landing (last fix). Stats are
      // unaffected — they still run over the full flight above.
      ...cropAndDownsample(flight, this.task),
    };
    this.pilots.push(row);
    return row;
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

    const tracks: MapTrack[] = this.pilots
      .filter((p) => p.track.length > 0)
      .map((p) => ({ pilot: p.name, completed: p.completed, points: p.track, times: p.trackTimes, alt: p.trackAlt }));

    return { turnpoints, tracks, utcOffsetMinutes: this.utcOffsetMinutes };
  }

  // ---- stats table -------------------------------------------------------

  buildStatsTable(): StatsTable {
    const completed = this.pilots
      .filter((p) => p.completed)
      .sort((a, b) => num(a.stats.completion_time) - num(b.stats.completion_time));
    const incomplete = this.pilots.filter((p) => !p.completed);

    return {
      headers: COMP_SUBSET.map((c) => c.label),
      dirs: COMP_SUBSET.map((c) => c.dir),
      completed: this.buildRows(completed),
      incomplete: this.buildRows(incomplete),
    };
  }

  // Emit text + raw value per cell. Gradient shading is applied client-side so
  // it can react to the current pilot selection.
  private buildRows(rows: PilotRow[]): TableCell[][] {
    return rows.map((row) =>
      COMP_SUBSET.map((col) => {
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
