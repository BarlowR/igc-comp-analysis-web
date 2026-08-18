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
 * What kind of day this is. Not a property of the `.xctsk` file — XContest
 * writes `taskType: "CLASSIC"` for every one of these, hike-and-fly included —
 * so it comes from outside: the archive manifest for a stored day (see
 * scripts/archive.mjs `--kind`), or the picker on the upload page.
 *
 * It selects which metrics are computed and shown: the full set for an XC comp,
 * a small starter set for hike and fly, whose turnpoint-to-turnpoint legs are
 * part hiked and part flown, so the air-only model behind the rest (par climb,
 * par glide, Time Lost) doesn't describe the day. See competition.ts
 * `metricsFor` and `buildMapData`.
 *
 * 'free' is the kind with no task at all — a set of tracklogs analyzed on
 * their own (Competition runs with task = null): whole-flight stats, no start
 * gate, no completion, no turnpoints on the map. Only the analyze page and
 * saved comps produce it; the archive never does, which is why it is absent
 * from TASK_KINDS below.
 */
export type TaskKind = 'xc' | 'hike-and-fly' | 'free';

export const DEFAULT_TASK_KIND: TaskKind = 'xc';

/** The task-BASED kinds: what the archive can hold and a .xctsk describes. */
export const TASK_KINDS: readonly TaskKind[] = ['xc', 'hike-and-fly'];

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  xc: 'XC Comp',
  'hike-and-fly': 'Hike and Fly',
  free: 'Free Flight',
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
  if (s === 'hikeandfly' || s === 'hikefly' || s === 'hnf') return 'hike-and-fly';
  // "non-comp" is what free flights were briefly called; saved rows may say it.
  if (s === 'free' || s === 'freeflight' || s === 'freeflights' || s === 'noncomp' || s === 'noncompflights') {
    return 'free';
  }
  return DEFAULT_TASK_KIND;
}

/**
 * Index of the cylinder the scored task starts at — the one that declares itself
 * the start of speed section. Everything before it (a TAKEOFF cylinder, and on
 * some tasks a waypoint or two beyond it) is pre-start staging: pilots sit
 * inside it during the hold, so treating it as the start puts the whole task
 * geometry one leg out and scores the hold as flying.
 *
 * Read the type rather than counting from the front, because both shapes occur:
 * XCTrack and AirScore tasks lead with a separate TAKEOFF cylinder and put the
 * SSS second, while the xcdemon-sourced tasks name the launch itself SSS and
 * have no TAKEOFF at all. A fixed offset is wrong for one or the other.
 *
 * Tasks with no SSS at all fall back to skipping a leading TAKEOFF, which is the
 * best guess available when nothing declares itself the start.
 */
export function startTurnpointIndex(turnpoints: readonly { type: string | null }[]): number {
  const sss = turnpoints.findIndex((tp) => tp.type === 'SSS');
  if (sss !== -1) return sss;
  return turnpoints[0]?.type === 'TAKEOFF' && turnpoints.length > 1 ? 1 : 0;
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
