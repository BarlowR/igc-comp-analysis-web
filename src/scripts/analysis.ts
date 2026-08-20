/**
 * Competition analysis orchestrator: runs the analysis entirely in the browser
 * and composes the results view — stats tables (tables.ts), climb-rate charts
 * (climb-chart.ts) and the task/track map (map-leaflet.ts) — over one shared
 * selection (lib/replay.ts). Driven both by the upload page (app.ts) and the
 * archive viewer (archive.ts) via runAnalysis / renderArchivedResults.
 */
import { DEFAULT_TASK_KIND, type TaskKind } from '../lib/xctsk';
import {
  Competition,
  nameFromFile,
  type Results,
  type StatsTable,
  type ClimbSeries,
  type MapData,
  type TimeLossData,
} from '../lib/competition';
import { buildPilotSelection, type Selection } from '../lib/replay';
import { mapSection, destroyMap } from './map-leaflet';
import { tableEl } from './tables';
import { climbChartSection, destroyCharts } from './climb-chart';

/**
 * Hooks for page-level features that need to reach inside a rendered analysis
 * without this module knowing about them. The archive day page uses them to put
 * a "claim this result" control in the pinned pilot's breakdown panel and to
 * pin the signed-in user's own result on load (see scripts/day-claim.ts).
 */
export interface RenderHooks {
  /** Extra content for the pinned pilot's breakdown panel; null for none. */
  pinnedExtra?: (pilot: string) => HTMLElement | null;
  /** Called once per render, after the tables exist and can react to pinning. */
  onReady?: (sel: Selection, pilots: string[]) => void;
}

let hooks: RenderHooks = {};

export function setRenderHooks(next: RenderHooks): void {
  hooks = next;
}

/**
 * Render precomputed (server-built) results for an archived day. No IGC parsing
 * or analysis happens on the client — it just draws the stored table/climb/map.
 */
export function renderArchivedResults(opts: {
  results: Results;
  resultsEl: HTMLElement;
  statusEl?: HTMLElement;
  /** URL of the 3D viewer for this day; adds a "View in 3D" link to the map card. */
  threeDUrl?: string;
}): void {
  const { results, resultsEl, statusEl, threeDUrl } = opts;
  const n = results.table.completed.length + results.table.incomplete.length;
  if (statusEl) statusEl.textContent = `Loaded ${n} pilot${n === 1 ? '' : 's'}.`;
  render(resultsEl, statusEl, results.table, results.climb, results.map, results.timeLoss, threeDUrl);
}

/** The analysis inputs shared by computeResults and runAnalysis. */
export interface AnalysisInputs {
  /** Null on a free-flight run: no task, whole-flight analysis. */
  taskText: string | null;
  igc: { name: string; text: string }[];
  statusEl?: HTMLElement;
  /** Minutes to add to UTC for local task time (from archive meta); null = UTC. */
  utcOffsetMinutes?: number | null;
  /** XC comp (default), hike and fly, or free — picks the metric set. See xctsk.ts. */
  taskKind?: TaskKind;
}

/**
 * The render-free core of runAnalysis: parse the tracklogs, run the analysis,
 * return the results payload — nothing touches the page beyond `statusEl`.
 * The saved list's "Recompute all" uses this directly, refreshing storage
 * caches without drawing each day.
 */
export async function computeResults(opts: AnalysisInputs): Promise<Results> {
  const { taskText, igc, statusEl } = opts;
  const setStatus = (s: string): void => {
    if (statusEl) statusEl.textContent = s;
  };

  const comp = new Competition(
    taskText,
    opts.utcOffsetMinutes ?? null,
    opts.taskKind ?? DEFAULT_TASK_KIND,
  );
  for (let i = 0; i < igc.length; i++) {
    const f = igc[i];
    setStatus(`Analyzing ${i + 1}/${igc.length}: ${f.name}`);
    // Yield to the event loop so the status text repaints between files.
    await new Promise((r) => setTimeout(r, 0));
    try {
      comp.addPilot(f.text, nameFromFile(f.name));
    } catch (err) {
      console.error(`Failed to parse ${f.name}`, err);
    }
  }

  setStatus(`Loaded ${comp.pilots.length} pilot${comp.pilots.length === 1 ? '' : 's'}.`);
  return comp.buildResults();
}

/**
 * Run the full analysis over one task + a set of IGC tracklogs, rendering into
 * `resultsEl`. Progress and a summary are written to `statusEl` when provided.
 * Returns the results payload (the same shape an archived day stores) so the
 * caller can persist it — the analyze page's "save to account" uploads exactly
 * this, and the saved-comp viewer re-renders it via renderArchivedResults.
 */
export async function runAnalysis(opts: AnalysisInputs & { resultsEl: HTMLElement }): Promise<Results> {
  const results = await computeResults(opts);
  render(opts.resultsEl, opts.statusEl, results.table, results.climb, results.map, results.timeLoss);
  return results;
}

function render(
  resultsEl: HTMLElement,
  statusEl: HTMLElement | undefined,
  table: StatsTable,
  climb: Results['climb'],
  mapData: MapData,
  timeLoss: TimeLossData,
  threeDUrl?: string,
): void {
  destroyCharts();
  destroyMap();
  resultsEl.innerHTML = '';

  // One selection + colour map shared across the map, both tables, and both
  // charts (see buildPilotSelection for the top-20 default rule).
  const { ordered, sel, colors, truncated, topN } = buildPilotSelection(table, mapData);
  if (truncated && statusEl) {
    statusEl.textContent += `  Showing the top ${topN} of ${ordered.length} pilots — use the “deselected pilots” section to show more.`;
  }

  // A free-flight day has no completion concept: every pilot is in the
  // `incomplete` bucket, shown as one "Flights" group (leading, where the
  // completed table normally sits) — "Did Not Complete Task" would be nonsense
  // when there was nothing to complete.
  const free = mapData.taskKind === 'free';
  if (free) {
    if (table.incomplete.length || climb.incomplete.length) {
      resultsEl.appendChild(group('Flights', table, table.incomplete, true, climb.incomplete, sel, colors, timeLoss));
    }
    if (mapData.tracks.length) {
      resultsEl.appendChild(mapSection(mapData, sel, colors, threeDUrl));
    }
  } else {
    if (table.completed.length || climb.completed.length) {
      resultsEl.appendChild(group('Completed Task', table, table.completed, true, climb.completed, sel, colors, timeLoss));
    }
    if (mapData.turnpoints.length || mapData.tracks.length) {
      resultsEl.appendChild(mapSection(mapData, sel, colors, threeDUrl));
    }
    if (table.incomplete.length || climb.incomplete.length) {
      resultsEl.appendChild(group('Did Not Complete Task', table, table.incomplete, false, climb.incomplete, sel, colors, timeLoss));
    }
  }
  // On the next frame, not synchronously: group() builds each chart and runs its
  // first syncChart() while the card is still detached, so the chart has no size
  // yet and its first paint lands only once the browser has attached and laid it
  // out. A hook that changes the selection here — auto-pinning the signed-in
  // pilot's result — re-enters chart.update() before that has happened, and the
  // pending paint is dropped: correct dataset state, blank canvas.
  const onReady = hooks.onReady;
  if (onReady) requestAnimationFrame(() => onReady(sel, ordered));
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** One self-contained section for a completion group: stats table + climb chart. */
function group(
  title: string,
  table: StatsTable,
  rows: StatsTable['completed'],
  gradient: boolean,
  series: ClimbSeries[],
  sel: Selection,
  colors: Map<string, string>,
  timeLoss: TimeLossData,
): HTMLElement {
  const card = document.createElement('section');
  card.className = 'card';
  const h = document.createElement('h2');
  h.textContent = title;
  card.append(h);

  if (rows.length) {
    // The pinnedExtra hook is read through a closure so hooks installed via
    // setRenderHooks keep working however late they land.
    const tbl = tableEl(table, rows, gradient, sel, colors, timeLoss, (pilot) => hooks.pinnedExtra?.(pilot) ?? null);
    sel.subscribe(tbl.rerender);
    card.appendChild(tbl.el);
  }

  if (series.length) {
    card.append(climbChartSection(series, sel, colors));
  }

  return card;
}
