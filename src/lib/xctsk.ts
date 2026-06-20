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
