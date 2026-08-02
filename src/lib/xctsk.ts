/**
 * Port of xctsk_lib.py — parses an XContest `.xctsk` task file.
 * These files are plain JSON with a different extension, so parsing is direct.
 */

export interface Turnpoint {
  order: number;
  radius: number;
  type: string | null; // "TAKEOFF" | "SSS" | "ESS" | null
  altSmoothed: number;
  description: string;
  lat: number;
  lon: number;
  name: string;
}

export interface XcTask {
  earthModel: string;
  goal: Record<string, unknown>;
  sss: { type?: string; direction?: string; timeGates: string[] };
  taskType: string;
  turnpoints: Turnpoint[];
}

/**
 * What kind of competition task this is. Not a property of the `.xctsk` file —
 * XContest writes `taskType: "CLASSIC"` for every one of these, hike-and-fly
 * included — so it comes from outside: the archive manifest for a stored day
 * (see scripts/archive.mjs `--kind`), or the picker on the upload page.
 *
 * It selects which metrics are computed and shown: the full set for an XC comp,
 * a small starter set for hike and fly, whose turnpoint-to-turnpoint legs are
 * part hiked and part flown, so the air-only model behind the rest (par climb,
 * par glide, Time Lost) doesn't describe the day. See competition.ts
 * `metricsFor` and `buildMapData`.
 */
export type TaskKind = 'xc' | 'hike-and-fly';

export const DEFAULT_TASK_KIND: TaskKind = 'xc';

export const TASK_KINDS: readonly TaskKind[] = ['xc', 'hike-and-fly'];

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  xc: 'XC Comp',
  'hike-and-fly': 'Hike and Fly',
};

/**
 * Read a task kind off untrusted input (a manifest field, a form value),
 * tolerating spelling and punctuation ("Hike & Fly", "hike_and_fly"). Anything
 * unrecognised — including absent — is an XC comp, which is what every archived
 * day was before kinds existed. `scripts/archive.mjs` validates strictly at
 * import time, so a typo there is caught rather than silently downgraded.
 */
export function parseTaskKind(value: unknown): TaskKind {
  const s = String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return s === 'hikeandfly' || s === 'hikefly' || s === 'hnf' ? 'hike-and-fly' : DEFAULT_TASK_KIND;
}

export function parseXcTask(text: string): XcTask {
  const data = JSON.parse(text);

  const turnpoints: Turnpoint[] = (data.turnpoints ?? []).map((tp: any, index: number) => ({
    order: index,
    radius: tp.radius,
    type: tp.type ?? null,
    altSmoothed: tp.waypoint.altSmoothed,
    description: tp.waypoint.description,
    lat: tp.waypoint.lat,
    lon: tp.waypoint.lon,
    name: tp.waypoint.name,
  }));

  return {
    earthModel: data.earthModel ?? '',
    goal: data.goal ?? {},
    sss: data.sss ?? { timeGates: [] },
    taskType: data.taskType ?? '',
    turnpoints,
  };
}
