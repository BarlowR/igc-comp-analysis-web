/**
 * Port of comp_analysis.py — orchestrates multiple pilots against one task and
 * builds the data for the stats table and the climb-rate distribution chart.
 */

import { IgcFlight, type Stats } from './igc';
import { parseXcTask, type XcTask } from './xctsk';

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
}

export interface MapData {
  turnpoints: MapTurnpoint[];
  tracks: MapTrack[];
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

  constructor(taskText: string) {
    this.task = parseXcTask(taskText);
  }

  /** Parse an IGC file, compute competition metrics, and register the pilot. */
  addPilot(igcText: string, fallbackName: string): PilotRow {
    const flight = new IgcFlight(igcText, fallbackName);
    flight.buildCompMetrics(this.task);
    const row: PilotRow = {
      name: flight.pilotName,
      completed: flight.stats.completed === true,
      stats: { ...flight.stats, name: flight.pilotName as unknown as number },
      track: downsample(flight.df.lat, flight.df.lon),
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
      .map((p) => ({ pilot: p.name, completed: p.completed, points: p.track }));

    return { turnpoints, tracks };
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

/**
 * Thin a track down to at most ~maxPoints [lat, lon] pairs for lightweight map
 * rendering, always keeping the first and last fix.
 */
function downsample(lat: number[], lon: number[], maxPoints = 1500): [number, number][] {
  const n = Math.min(lat.length, lon.length);
  if (n === 0) return [];
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const out: [number, number][] = [];
  for (let i = 0; i < n; i += step) {
    if (Number.isFinite(lat[i]) && Number.isFinite(lon[i])) out.push([lat[i], lon[i]]);
  }
  const last = n - 1;
  if (last % step !== 0 && Number.isFinite(lat[last]) && Number.isFinite(lon[last])) {
    out.push([lat[last], lon[last]]);
  }
  return out;
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
