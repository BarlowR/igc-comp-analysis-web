/**
 * Competition analysis engine: runs the analysis entirely in the browser and
 * renders the stats table, climb-rate charts, and task/track map. Driven both by
 * the upload page (app.ts) and the archive viewer (archive.ts) via runAnalysis.
 */
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Tooltip,
  Legend,
  type ChartDataset,
  type Plugin,
} from 'chart.js';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { optimizeTaskRoute } from '../lib/math';
import {
  Competition,
  CLIMB_RATE_TICKS,
  gradientColor,
  nameFromFile,
  type StatsTable,
  type ClimbData,
  type ClimbSeries,
  type MapData,
  type TimeLossData,
  type TimeLossRow,
} from '../lib/competition';

// Re-export for callers that import it from here.
export { nameFromFile };

/** Precomputed analysis results for one archived day (built server-side). */
export interface ArchivedResults {
  table: StatsTable;
  climb: ClimbData;
  map: MapData;
  timeLoss: TimeLossData;
}

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Legend);

// Match the app's near-black text color for all chart text (ticks, titles, legend).
Chart.defaults.color = '#140c0c';

// 20 vivid hues so the default top-20 selection never repeats a colour. Every
// one is high-chroma (CIE76 C* ≥ 52) and clearly distinct from DESELECTED_GREY
// (ΔE ≥ 51) — so none read as grey-ish — and mutually separated (min ΔE ≈ 25).
// Ordered by interleaved hue so consecutive leaderboard pilots get strongly
// contrasting (opposite-wheel) colours.
const PALETTE = [
  '#e6194b', '#0751a6', '#ad0000', '#297eff', '#ff5c0a',
  '#0044cc', '#a65107', '#2945ff', '#cc9600', '#0a0aff',
  '#8bad00', '#8800cc', '#08c408', '#de0aff', '#07a63c',
  '#eb00cb', '#07a671', '#a60767', '#29a9ff', '#ff0a9d',
];

// Muted grey used to draw deselected pilots as faint background lines on both
// the map and the climb chart, so the field stays visible without competing
// with the selected (coloured) pilots.
const DESELECTED_GREY = '#9a948a';

/**
 * Assign every pilot one stable colour, keyed by name, so a pilot looks the
 * same on the map and on both climb charts. Built once per analysis run from
 * the canonical pilot order.
 */
function buildPilotColors(names: string[]): Map<string, string> {
  const colors = new Map<string, string>();
  names.forEach((n, i) => colors.set(n, PALETTE[i % PALETTE.length]));
  return colors;
}

let charts: Chart[] = [];
let map: L.Map | null = null;

/**
 * Render precomputed (server-built) results for an archived day. No IGC parsing
 * or analysis happens on the client — it just draws the stored table/climb/map.
 */
export function renderArchivedResults(opts: {
  results: ArchivedResults;
  resultsEl: HTMLElement;
  statusEl?: HTMLElement;
}): void {
  const { results, resultsEl, statusEl } = opts;
  const n = results.table.completed.length + results.table.incomplete.length;
  if (statusEl) statusEl.textContent = `Loaded ${n} pilot${n === 1 ? '' : 's'}.`;
  render(resultsEl, statusEl, results.table, results.climb, results.map, results.timeLoss);
}

/**
 * Run the full analysis over one task + a set of IGC tracklogs, rendering into
 * `resultsEl`. Progress and a summary are written to `statusEl` when provided.
 */
export async function runAnalysis(opts: {
  taskText: string;
  igc: { name: string; text: string }[];
  resultsEl: HTMLElement;
  statusEl?: HTMLElement;
  /** Minutes to add to UTC for local task time (from archive meta); null = UTC. */
  utcOffsetMinutes?: number | null;
}): Promise<void> {
  const { taskText, igc, resultsEl, statusEl } = opts;
  const setStatus = (s: string): void => {
    if (statusEl) statusEl.textContent = s;
  };

  const comp = new Competition(taskText, opts.utcOffsetMinutes ?? null);
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
  render(
    resultsEl,
    statusEl,
    comp.buildStatsTable(),
    comp.buildClimbData(),
    comp.buildMapData(),
    comp.buildTimeLoss(),
  );
}

/**
 * Shared pilot-selection state for one analysis run. The table, climb chart, and
 * map all read and mutate this, and re-render via subscriptions, so selecting a
 * pilot anywhere updates everywhere. Pilots are keyed by name.
 */
interface Selection {
  has(name: string): boolean;
  all(): string[];
  selectedCount(): number;
  toggle(name: string): void;
  setMany(names: string[], on: boolean): void;
  isolate(name: string): void;
  subscribe(fn: () => void): void;
  // Cross-view highlight of a single pilot: click-to-pin emphasises that pilot's
  // row, climb line, and map track at once (no hover effect). Separate channel
  // from selection so pinning doesn't trigger full re-renders.
  highlight(): string | null;
  togglePin(name: string): void;
  isPinned(name: string): boolean;
  onHighlight(fn: () => void): void;
}

function makeSelection(allNames: string[], initial: string[]): Selection {
  const selected = new Set(initial);
  const subs: (() => void)[] = [];
  const notify = (): void => {
    for (const f of subs) f();
  };
  // The pinned pilot is the cross-view highlight; null when nothing is pinned.
  let pinned: string | null = null;
  const hsubs: (() => void)[] = [];
  const notifyHighlight = (): void => {
    for (const f of hsubs) f();
  };
  return {
    has: (n) => selected.has(n),
    all: () => [...allNames],
    selectedCount: () => selected.size,
    subscribe: (f) => {
      subs.push(f);
    },
    highlight: () => pinned,
    togglePin(n) {
      pinned = pinned === n ? null : n;
      notifyHighlight();
    },
    isPinned: (n) => pinned === n,
    onHighlight(f) {
      hsubs.push(f);
    },
    toggle(n) {
      if (selected.has(n)) selected.delete(n);
      else selected.add(n);
      notify();
    },
    setMany(names, on) {
      for (const n of names) {
        if (on) selected.add(n);
        else selected.delete(n);
      }
      notify();
    },
    isolate(n) {
      // Double-click an already-isolated pilot to restore everyone.
      const onlyThis = selected.size === 1 && selected.has(n);
      selected.clear();
      if (onlyThis) for (const x of allNames) selected.add(x);
      else selected.add(n);
      notify();
    },
  };
}

function render(
  resultsEl: HTMLElement,
  statusEl: HTMLElement | undefined,
  table: StatsTable,
  climb: ClimbData,
  mapData: MapData,
  timeLoss: TimeLossData,
): void {
  for (const c of charts) c.destroy();
  charts = [];
  if (map) {
    map.remove();
    map = null;
  }
  resultsEl.innerHTML = '';

  // One selection shared across the map, both tables, and both charts.
  // Pilots are ordered completed-first (completed rows are sorted by completion
  // time), so the first 20 are the leaderboard's top 20, selected by default.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (n: string): void => {
    if (!seen.has(n)) {
      seen.add(n);
      ordered.push(n);
    }
  };
  for (const r of table.completed) push(r[0].text);
  for (const r of table.incomplete) push(r[0].text);
  for (const tr of mapData.tracks) push(tr.pilot);

  // With a large field, default to just the top 20 to keep the page manageable;
  // otherwise select everyone.
  const TOP_N = 20;
  const TRUNCATE_ABOVE = 50;
  const truncated = ordered.length > TRUNCATE_ABOVE;
  const sel = makeSelection(ordered, truncated ? ordered.slice(0, TOP_N) : ordered);
  if (truncated && statusEl) {
    statusEl.textContent += `  Showing the top ${TOP_N} of ${ordered.length} pilots by default — use the “deselected pilots” section or the checkboxes to show more.`;
  }

  // One stable colour per pilot, shared by the map and both climb charts.
  const colors = buildPilotColors(ordered);

  if (table.completed.length || climb.completed.length) {
    resultsEl.appendChild(group('Completed Task', table, table.completed, true, climb.completed, sel, colors, timeLoss));
  }
  if (mapData.turnpoints.length || mapData.tracks.length) {
    resultsEl.appendChild(mapSection(mapData, sel, colors));
  }
  if (table.incomplete.length || climb.incomplete.length) {
    resultsEl.appendChild(group('Did Not Complete Task', table, table.incomplete, false, climb.incomplete, sel, colors, timeLoss));
  }
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Build the "Task & Tracks" card and initialise the Leaflet map inside it. */
function mapSection(data: MapData, sel: Selection, colors: Map<string, string>): HTMLElement {
  const card = document.createElement('section');
  card.className = 'card';
  const h = document.createElement('h2');
  h.textContent = 'Task & Tracks';
  const holder = document.createElement('div');
  holder.className = 'map-holder';
  card.append(h, holder);

  // Leaflet must initialise against an element already in the DOM with a size,
  // so defer until after this card is appended and laid out.
  queueMicrotask(() => initMap(holder, data, sel, colors));
  return card;
}

interface TrackLayer {
  name: string;
  color: string;
  layer: L.Polyline;
}

function initMap(holder: HTMLElement, data: MapData, sel: Selection, colors: Map<string, string>): void {
  // A canvas renderer with hit tolerance makes the thin track lines far easier
  // to tap (mobile) or hover (desktop) without thickening the lines themselves.
  const m = L.map(holder, { preferCanvas: true, renderer: L.canvas({ tolerance: 12 }) });
  map = m;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(m);

  const bounds = L.latLngBounds([]);

  // --- task geometry: cylinders + the optimized task line ------------------
  // Added before the pilot tracks so it stays at the bottom of the stack —
  // beneath every track and dot. (The grey base lines deliberately do NOT get
  // bringToBack'd, which would otherwise sink them below the task.)
  for (const tp of data.turnpoints) {
    const center: L.LatLngExpression = [tp.lat, tp.lon];
    const color = tp.type === 'SSS' ? '#2e7d32' : tp.type === 'ESS' ? '#c62828' : '#705a90';
    L.circle(center, {
      radius: tp.radius,
      color,
      weight: 2,
      fillOpacity: 0.08,
    })
      .addTo(m)
      .bindTooltip(`${tp.order === 0 ? '' : tp.order + '. '}${tp.name}${tp.type ? ` (${tp.type})` : ''}`);
    L.circleMarker(center, { radius: 3, color, fillOpacity: 1 }).addTo(m);
    bounds.extend(center);
  }

  // Dashed line along the shortest route that touches each cylinder (the
  // scored "optimized task"), rather than straight lines through the centres.
  // Drop a leading TAKEOFF: the scored route starts at the SSS cylinder, and
  // an exit-start takeoff usually sits inside it (a degenerate stub otherwise).
  let routeTps = data.turnpoints;
  if (routeTps[0]?.type === 'TAKEOFF' && routeTps.length > 1) routeTps = routeTps.slice(1);
  if (routeTps.length > 1) {
    const route = optimizeTaskRoute(routeTps);
    L.polyline(route, { color: '#140c0c', weight: 1.5, dashArray: '6 6', opacity: 0.7 }).addTo(m);
  }

  // --- pilot tracks --------------------------------------------------------
  // Every pilot keeps a full grey route line at all times for context. The
  // time slider draws the coloured progress (up to each selected pilot's dot)
  // on top; the full grey line shows where they go next.
  const trackLayers: TrackLayer[] = [];
  data.tracks.forEach((tr) => {
    const color = colors.get(tr.pilot) ?? PALETTE[0];
    const layer = L.polyline(tr.points, { color: DESELECTED_GREY, weight: 1, opacity: 0.3 });
    layer.bindTooltip(tr.pilot, { sticky: true });
    // Tap/click a track to reveal its name (touch devices have no hover) and
    // pin/unpin its cross-view highlight.
    layer.on('click', (e) => {
      layer.openTooltip(e.latlng);
      if (sel.has(tr.pilot)) sel.togglePin(tr.pilot);
    });
    layer.addTo(m);
    trackLayers.push({ name: tr.pilot, color, layer });
    for (const pt of tr.points) bounds.extend(pt);
  });

  if (bounds.isValid()) m.fitBounds(bounds, { padding: [30, 30] });
  m.invalidateSize();

  // Style the grey base lines for the current selection. They stay grey for
  // everyone (the coloured progress overlay marks the selected pilots); a
  // selected pilot's full route is just a little more visible, a highlighted
  // one darker. Pilot names aren't listed on the map — hover a track to see it.
  const styleTracks = (): void => {
    const highlight = sel.highlight();
    for (const t of trackLayers) {
      const isH = t.name === highlight;
      const selected = sel.has(t.name);
      t.layer.setStyle({
        color: isH ? '#6b655c' : DESELECTED_GREY,
        weight: isH ? 2 : 1,
        opacity: isH ? 0.8 : selected ? 0.5 : 0.3,
      });
      // Only selected pilots are hover-selectable; drop the tooltip otherwise.
      if (selected) {
        if (!t.layer.getTooltip()) t.layer.bindTooltip(t.name, { sticky: true });
      } else {
        t.layer.closeTooltip();
        t.layer.unbindTooltip();
      }
      // Note: no bringToBack here — that would sink the grey lines below the
      // task cylinders. Order stays: task (added first) < grey lines < trails/dots.
    }
  };
  styleTracks();
  sel.subscribe(styleTracks);
  sel.onHighlight(styleTracks);

  addTimeSlider(holder, m, data, sel, colors);
}

/**
 * A scrubber under the map that replays the day: dragging (or playing) the
 * slider drops a coloured dot at each selected pilot's position at that moment,
 * interpolated between fixes, so you can watch the gaggle move through time.
 */
function addTimeSlider(
  holder: HTMLElement,
  m: L.Map,
  data: MapData,
  sel: Selection,
  colors: Map<string, string>,
): void {
  // Global time span across every track (ignoring non-finite stamps).
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const tr of data.tracks) {
    for (const t of tr.times) {
      if (!Number.isFinite(t)) continue;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  if (!Number.isFinite(tMin) || tMax <= tMin) return; // nothing to scrub

  // The altitude plot below doubles as the scrubber: drag across it to set the
  // time. This bar just holds the play/pause button and the clock readout.
  const bar = document.createElement('div');
  bar.className = 'time-slider';
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'time-slider-play';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.textContent = '▶';
  const label = document.createElement('span');
  label.className = 'time-slider-label';
  bar.append(playBtn, label);
  holder.insertAdjacentElement('afterend', bar);

  // Current scrub time. Dragging the altitude plot or playback moves it; render
  // reads it. Starts at the end so the full tracks show by default.
  let currentMs = tMax;
  const setTime = (ms: number): void => {
    currentMs = Math.min(tMax, Math.max(tMin, ms));
    render();
  };

  // Altitude profile below the bar, sharing the same time axis, colours and
  // selection so it stays in lockstep with the map — and acting as the slider.
  const drawAlt = createAltitudePlot(bar, data, tMin, tMax, sel, colors, (ms) => {
    stop(); // a manual scrub interrupts playback
    setTime(ms);
  });

  // A position dot for every pilot (grey unless selected). Selected pilots also
  // get a solid coloured trail from launch to the dot. All overlay/dot layers
  // are non-interactive so hover/click still hit the grey base line underneath.
  const dots = new Map<string, L.CircleMarker>();
  const trails = new Map<string, L.Polyline>();

  // Draw/refresh a pilot's solid trail, reusing one polyline per pilot.
  const drawTrail = (pilot: string, trail: [number, number][], color: string, weight: number): void => {
    let line = trails.get(pilot);
    if (trail.length < 2) {
      if (line) {
        line.remove();
        trails.delete(pilot);
      }
      return;
    }
    if (!line) {
      line = L.polyline(trail, { interactive: false });
      line.addTo(m);
      trails.set(pilot, line);
    } else {
      line.setLatLngs(trail);
    }
    line.setStyle({ color, weight, opacity: 1 });
    line.bringToFront();
  };

  const render = (): void => {
    const t = currentMs;
    label.textContent = formatClock(t, data.utcOffsetMinutes);
    const single = sel.selectedCount() === 1;
    const highlight = sel.highlight();

    // Pass 1: coloured trails (selected pilots), so the dots can sit above them.
    for (const tr of data.tracks) {
      const isH = tr.pilot === highlight;
      const trail = sel.has(tr.pilot) ? pointsUpTo(tr, t) : [];
      drawTrail(tr.pilot, trail, colors.get(tr.pilot) ?? PALETTE[0], isH ? 5 : single ? 4 : 2.5);
    }

    // Pass 2: position dots for every pilot in range, on top of all trails.
    for (const tr of data.tracks) {
      const selected = sel.has(tr.pilot);
      const isH = tr.pilot === highlight;
      const color = colors.get(tr.pilot) ?? PALETTE[0];
      const pos = positionAt(tr, t);
      let dot = dots.get(tr.pilot);
      if (!pos) {
        if (dot) {
          dot.remove();
          dots.delete(tr.pilot);
        }
        continue;
      }
      if (!dot) {
        dot = L.circleMarker(pos, { interactive: false });
        dot.addTo(m);
        dots.set(tr.pilot, dot);
      } else {
        dot.setLatLng(pos);
      }
      if (selected) {
        dot.setStyle({
          color: '#fff',
          weight: 1.5,
          fillColor: color,
          fillOpacity: 1,
          radius: isH ? 7 : single ? 6 : 4,
        });
      } else {
        dot.setStyle({
          color: DESELECTED_GREY,
          weight: 0,
          fillColor: DESELECTED_GREY,
          fillOpacity: 0.55,
          radius: 3,
        });
      }
      dot.bringToFront();
    }

    // Pinned pilot rides on top of everything (trail + dot).
    if (highlight) {
      trails.get(highlight)?.bringToFront();
      dots.get(highlight)?.bringToFront();
    }

    drawAlt(t); // keep the linked altitude plot in sync
  };

  // Re-place markers when the selection (or highlight) changes under a fixed time.
  sel.subscribe(render);
  sel.onHighlight(render);

  // --- playback ------------------------------------------------------------
  // Sweep the whole day in ~30s of real time; rAF stops itself if the map (and
  // thus this control) has been torn down by a re-render.
  const DURATION_MS = 30_000;
  let raf = 0;
  let last = 0;
  const stop = (): void => {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
  };
  const tick = (now: number): void => {
    if (!bar.isConnected) return; // map was replaced; let the loop die
    const dt = last ? now - last : 0;
    last = now;
    const next = currentMs + ((tMax - tMin) * dt) / DURATION_MS;
    if (next >= tMax) {
      setTime(tMax);
      stop();
      return;
    }
    setTime(next);
    raf = requestAnimationFrame(tick);
  };
  playBtn.addEventListener('click', () => {
    if (raf) {
      stop();
      return;
    }
    if (currentMs >= tMax) currentMs = tMin; // restart from the top
    last = 0;
    playBtn.textContent = '❚❚';
    playBtn.setAttribute('aria-label', 'Pause');
    raf = requestAnimationFrame(tick);
  });

  render();
}

type MapTrack = MapData['tracks'][number];

/** Index of the last fix at or before `t`. Assumes times[0] <= t <= times[n-1]. */
function lastIdxAtOrBefore(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Interpolate a track's [lat, lon] at epoch-ms `t`, or null if out of range. */
function positionAt(tr: MapTrack, t: number): [number, number] | null {
  const { times, points } = tr;
  const n = times.length;
  if (n === 0 || t < times[0] || t > times[n - 1]) return null;
  const i = lastIdxAtOrBefore(times, t);
  const a = points[i];
  if (i >= n - 1) return a;
  const b = points[i + 1];
  const span = times[i + 1] - times[i];
  const f = span > 0 ? (t - times[i]) / span : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** Track points from launch up to epoch-ms `t`, ending at the interpolated dot. */
function pointsUpTo(tr: MapTrack, t: number): [number, number][] {
  const { times, points } = tr;
  const n = times.length;
  if (n === 0 || t < times[0]) return [];
  if (t >= times[n - 1]) return points.slice();
  const i = lastIdxAtOrBefore(times, t);
  const head = points.slice(0, i + 1);
  const end = positionAt(tr, t);
  if (end) head.push(end);
  return head;
}

/**
 * Epoch ms -> "HH:MM:SS" in task-local time. Fix times were built from the
 * IGC's UTC clock (so getHours() reads back UTC); `offsetMin` shifts that to the
 * competition's local time. Null offset displays UTC.
 */
function formatClock(ms: number, offsetMin: number | null): string {
  const d = new Date(ms);
  const utcSecs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  const secs = (((utcSecs + (offsetMin ?? 0) * 60) % 86400) + 86400) % 86400;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(secs / 3600))}:${p(Math.floor((secs % 3600) / 60))}:${p(secs % 60)}`;
}

/** Interpolate a track's GPS altitude (m) at epoch-ms `t`, or null if out of range. */
function altAt(tr: MapTrack, t: number): number | null {
  const { times, alt } = tr;
  const n = times.length;
  if (n === 0 || t < times[0] || t > times[n - 1]) return null;
  const i = lastIdxAtOrBefore(times, t);
  if (i >= n - 1) return alt[i];
  const span = times[i + 1] - times[i];
  const f = span > 0 ? (t - times[i]) / span : 0;
  return alt[i] + (alt[i + 1] - alt[i]) * f;
}

/** "nice" round tick values spanning [min, max] (~`count` steps). */
function niceTicks(min: number, max: number, count: number): number[] {
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  return ticks;
}

/**
 * A canvas altitude-vs-time plot under the map, sharing its time axis, pilot
 * colours and selection. Every pilot draws a faint grey full-flight profile
 * (cached offscreen); selected pilots get the same comet fade up to the cursor
 * time, with dots and a vertical time line. Returns a `draw(t)` to call in sync
 * with the map.
 */
function createAltitudePlot(
  afterEl: HTMLElement,
  data: MapData,
  tMin: number,
  tMax: number,
  sel: Selection,
  colors: Map<string, string>,
  onScrub: (ms: number) => void,
): (t: number) => void {
  const wrap = document.createElement('div');
  wrap.className = 'alt-plot';
  const title = document.createElement('div');
  title.className = 'alt-plot-title';
  title.textContent = 'Altitude (m) — drag to scrub';
  const canvas = document.createElement('canvas');
  canvas.className = 'alt-plot-canvas';
  wrap.append(title, canvas);
  afterEl.insertAdjacentElement('afterend', wrap);

  const ctx = canvas.getContext('2d')!;

  // Altitude domain across all tracks, with a little headroom.
  let aMin = Infinity;
  let aMax = -Infinity;
  for (const tr of data.tracks) {
    for (const a of tr.alt) {
      if (!Number.isFinite(a)) continue;
      if (a < aMin) aMin = a;
      if (a > aMax) aMax = a;
    }
  }
  if (!Number.isFinite(aMin)) {
    aMin = 0;
    aMax = 1;
  }
  const padA = (aMax - aMin) * 0.06 || 10;
  aMin -= padA;
  aMax += padA;

  const PAD = { l: 48, r: 10, t: 8, b: 6 };
  let plotW = 0;
  let plotH = 0;
  let lastT = tMax;
  let base: HTMLCanvasElement | null = null; // cached static layer (grid + grey traces)

  const xOf = (time: number): number => PAD.l + ((time - tMin) / (tMax - tMin)) * plotW;
  const yOf = (a: number): number => PAD.t + (1 - (a - aMin) / (aMax - aMin)) * plotH;

  // Full-flight altitude profile in screen space (for the cached grey layer).
  const fullProfile = (tr: MapTrack): [number, number][] =>
    tr.points.map((_, i) => [xOf(tr.times[i]), yOf(tr.alt[i])]);

  // Flown-so-far altitude profile up to time `t`, ending at the interpolated cursor.
  const profileUpTo = (tr: MapTrack, t: number): [number, number][] => {
    const { times, alt } = tr;
    const n = times.length;
    if (n === 0 || t < times[0]) return [];
    const pts: [number, number][] = [];
    let i = 0;
    for (; i < n && times[i] <= t; i++) pts.push([xOf(times[i]), yOf(alt[i])]);
    if (i < n && i > 0) {
      const a = altAt(tr, t);
      if (a !== null) pts.push([xOf(t), yOf(a)]);
    }
    return pts;
  };

  const strokePath = (c: CanvasRenderingContext2D, pts: [number, number][]): void => {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.stroke();
  };

  // Solid coloured trail in screen space.
  const drawTrail = (c: CanvasRenderingContext2D, pts: [number, number][], color: string, weight: number): void => {
    if (pts.length < 2) return;
    c.lineWidth = weight;
    c.strokeStyle = color;
    strokePath(c, pts);
  };

  // Rebuild the cached static layer: gridlines, labels and grey full profiles.
  const buildBase = (): void => {
    const b = document.createElement('canvas');
    b.width = canvas.width;
    b.height = canvas.height;
    const bc = b.getContext('2d')!;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    bc.scale(dpr, dpr);
    bc.lineJoin = 'round';
    bc.lineCap = 'round';
    // Gridlines + altitude labels.
    bc.font = '11px system-ui, sans-serif';
    bc.textAlign = 'right';
    bc.textBaseline = 'middle';
    for (const a of niceTicks(aMin, aMax, 4)) {
      const y = yOf(a);
      bc.strokeStyle = 'rgba(20, 12, 12, 0.08)';
      bc.lineWidth = 1;
      strokePath(bc, [[PAD.l, y], [PAD.l + plotW, y]]);
      bc.fillStyle = '#6b625e';
      bc.fillText(String(Math.round(a)), PAD.l - 6, y);
    }
    // Grey full-flight profiles for every pilot.
    bc.strokeStyle = 'rgba(154, 148, 138, 0.4)';
    bc.lineWidth = 1;
    for (const tr of data.tracks) {
      if (tr.points.length < 2) continue;
      strokePath(bc, fullProfile(tr));
    }
    // Vertical marker at the task start gate (green, matching the SSS cylinder).
    if (data.startMs != null && data.startMs >= tMin && data.startMs <= tMax) {
      const sx = xOf(data.startMs);
      bc.strokeStyle = '#2e7d32';
      bc.lineWidth = 1.5;
      bc.setLineDash([4, 3]);
      strokePath(bc, [[sx, PAD.t], [sx, PAD.t + plotH]]);
      bc.setLineDash([]);
      bc.fillStyle = '#2e7d32';
      bc.font = '10px system-ui, sans-serif';
      bc.textAlign = 'left';
      bc.textBaseline = 'top';
      bc.fillText('Start', sx + 3, PAD.t + 2);
    }
    base = b;
  };

  const draw = (t: number): void => {
    lastT = t;
    if (!base || plotW <= 0) return;
    // Reset to device pixels to blit the cached layer 1:1, then work in CSS px.
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const single = sel.selectedCount() === 1;
    const highlight = sel.highlight();

    // Coloured trails for selected pilots; pinned pilot last so it sits on top.
    const selected = data.tracks.filter((tr) => sel.has(tr.pilot));
    const trailOrder = highlight
      ? [...selected.filter((tr) => tr.pilot !== highlight), ...selected.filter((tr) => tr.pilot === highlight)]
      : selected;
    for (const tr of trailOrder) {
      const isH = tr.pilot === highlight;
      drawTrail(ctx, profileUpTo(tr, t), colors.get(tr.pilot) ?? PALETTE[0], isH ? 4 : single ? 3.5 : 2.5);
    }

    // Vertical time cursor.
    const cx = xOf(t);
    ctx.strokeStyle = 'rgba(20, 12, 12, 0.45)';
    ctx.lineWidth = 1;
    strokePath(ctx, [[cx, PAD.t], [cx, PAD.t + plotH]]);

    // Position dots: grey for unselected, coloured for selected; pinned on top.
    const drawDot = (tr: MapTrack): void => {
      const a = altAt(tr, t);
      if (a === null) return;
      const x = xOf(t);
      const y = yOf(a);
      if (sel.has(tr.pilot)) {
        ctx.fillStyle = colors.get(tr.pilot) ?? PALETTE[0];
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, tr.pilot === highlight ? 5 : single ? 4.5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(154, 148, 138, 0.55)';
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    for (const tr of data.tracks) if (tr.pilot !== highlight) drawDot(tr);
    if (highlight) {
      const h = data.tracks.find((tr) => tr.pilot === highlight);
      if (h) drawDot(h);
    }
  };

  const resize = (): void => {
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    plotW = cssW - PAD.l - PAD.r;
    plotH = cssH - PAD.t - PAD.b;
    buildBase();
    draw(lastT);
  };

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  requestAnimationFrame(resize); // initial sizing once laid out

  // Scrub: map a pointer x within the plot area to a time and report it.
  const timeFromX = (clientX: number): number => {
    if (plotW <= 0) return tMin;
    const x = clientX - canvas.getBoundingClientRect().left - PAD.l;
    return tMin + Math.min(1, Math.max(0, x / plotW)) * (tMax - tMin);
  };
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    onScrub(timeFromX(e.clientX));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) onScrub(timeFromX(e.clientX));
  });
  const endDrag = (e: PointerEvent): void => {
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  return draw;
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
    const tbl = tableEl(table, rows, gradient, sel, colors, timeLoss);
    sel.subscribe(tbl.rerender);
    card.appendChild(tbl.el);
  }

  if (series.length) {
    const chartWrap = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = 'Climb Rate Distribution';
    const holder = document.createElement('div');
    holder.className = 'chart-holder';
    const canvas = document.createElement('canvas');
    holder.appendChild(canvas);
    chartWrap.append(h3, holder);
    card.append(chartWrap);
    const chart = makeChart(canvas, series, sel, colors);

    const syncChart = (): void => {
      // Hide the whole plot when no pilot in this section is selected.
      const anyVisible = series.some((s) => sel.has(s.pilot));
      chartWrap.style.display = anyVisible ? '' : 'none';
      if (!anyVisible) return;
      styleChartDatasets(chart, sel);
      chart.update();
      chart.resize(); // recover canvas size if it was hidden
    };
    sel.subscribe(syncChart);
    syncChart();

    // Reflect the cross-view highlight onto this chart: bold the highlighted
    // pilot's line and surface its average-climb label, without a full re-sync.
    const applyChartHighlight = (): void => {
      if (chartWrap.style.display === 'none') return;
      (chart as ChartWithAvg).$avgHover = sel.highlight();
      styleChartDatasets(chart, sel);
      chart.update('none');
    };
    sel.onHighlight(applyChartHighlight);

    charts.push(chart);
  }

  return card;
}

/** Signed mm:ss (or h:mm:ss), e.g. "+2:52", "−41s", "0". */
function signedTime(s: number): string {
  const r = Math.round(s);
  if (r === 0) return '0';
  const sign = r < 0 ? '−' : '+';
  const a = Math.abs(r);
  if (a < 60) return `${sign}${a}s`;
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const sec = a % 60;
  return h > 0
    ? `${sign}${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${sign}${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * The breakdown row shown under a pinned pilot: where their gap to the winner
 * was spent. Each component is a bar on a shared zero-centred scale — right of
 * centre (rust) is time lost to the winner in that phase, left (teal) is time
 * gained. The four components sum to the total by construction.
 */
function timeLossRow(
  loss: TimeLossRow,
  winner: string,
  span: number,
  contextScale: TimeLossData['contextScale'],
  topCount: number,
): HTMLElement {
  // The winner is measured against the field average rather than themselves, so
  // the reference name changes throughout their row.
  const refLabel = loss.referenceIsAvg ? `the top-${topCount} average` : 'the winner';
  const COMPONENTS: {
    key: keyof TimeLossRow;
    altKey: keyof TimeLossRow;
    label: string;
    hint: string;
  }[] = [
    {
      key: 'start',
      altKey: 'altStart',
      label: 'Start',
      hint: `crossing the start line later than ${refLabel}, and how high you crossed`,
    },
    {
      key: 'glide',
      altKey: 'altGlide',
      label: 'Gliding',
      hint: 'time spent moving forward on glide; the height is net metres gained or lost cruising (lift found minus sink hit)',
    },
    {
      key: 'thermalGain',
      altKey: 'altThermalGain',
      label: 'Climbing',
      hint: 'time spent thermalling while gaining, and the height it bought',
    },
    {
      key: 'thermalFlat',
      altKey: 'altThermalFlat',
      label: 'Stopped and not climbing',
      hint: 'zeros, sink, and re-centring',
    },
  ];

  const tr = document.createElement('tr');
  tr.className = 'time-loss';
  const td = document.createElement('td');
  td.colSpan = span;

  // The cell spans every column, so it is as wide as the full (scrolling)
  // table. Content lives in a narrow panel pinned to the left edge of the
  // scroll container, so the bars stay a readable width and stay on screen
  // however far the stats columns are scrolled.
  const panel = document.createElement('div');
  panel.className = 'tl-panel';
  td.appendChild(panel);

  const head = document.createElement('div');
  head.className = 'tl-head';
  head.textContent = loss.referenceIsAvg
    ? topCount > 1
      ? `${loss.pilot}: ${signedTime(loss.total)} vs the top-${topCount} average.`
      : `${loss.pilot} every pilot below is measured against this flight.`
    : `${loss.pilot} finished ${signedTime(loss.total)} vs ${winner} (winner)`;
  panel.appendChild(head);

  // Bars are scaled to the pilot's own largest component so small gaps stay
  // legible; the shared scale keeps the five comparable to each other.
  const scale = Math.max(...COMPONENTS.map((c) => Math.abs(loss[c.key] as number)), 1);

  const grid = document.createElement('div');
  grid.className = 'tl-grid';

  // Height gets its own scale — different unit, and it must not be read as a
  // fraction of the time gap.
  const altScale = Math.max(
    ...COMPONENTS.map((c) => Math.abs(loss[c.altKey] as number)).filter(Number.isFinite),
    1,
  );

  const hcell = (text: string, cls: string): HTMLElement => {
    const d = document.createElement('div');
    d.className = `tl-colhead ${cls}`;
    d.textContent = text;
    return d;
  };
  // Spacer over the label column, then one header spanning each value+bar pair
  // (tl-span sets grid-column: span 2). The height header also opens the group
  // divider (tl-div = the vertical rule between the time and height columns).
  grid.append(hcell('', ''), hcell('time', 'tl-span'), hcell('height', 'tl-span tl-div'));

  /** A zero-centred bar: half the track each side of centre. */
  const barTrack = (v: number, max: number, cls: string): HTMLElement => {
    const track = document.createElement('div');
    track.className = 'tl-track';
    if (!Number.isFinite(v)) return track;
    const bar = document.createElement('div');
    bar.className = cls;
    bar.style.width = `${(Math.abs(v) / max) * 50}%`;
    bar.style[v < 0 ? 'right' : 'left'] = '50%';
    track.appendChild(bar);
    return track;
  };

  for (const c of COMPONENTS) {
    const v = loss[c.key] as number;
    const a = loss[c.altKey] as number;

    const label = document.createElement('div');
    label.className = 'tl-label';
    label.textContent = c.label;
    label.title = c.hint;

    const val = document.createElement('div');
    val.className = 'tl-val';
    val.textContent = signedTime(v);

    // Height bars stay a single neutral colour in both directions: more height
    // in a phase is not reliably better (it can mean you needed the climb), so
    // only the time bars carry the rust/teal (slower/faster) win-lose reading.
    const altEl = document.createElement('div');
    altEl.className = 'tl-alt tl-div';
    altEl.textContent = Number.isFinite(a)
      ? `${a < 0 ? '−' : '+'}${Math.abs(Math.round(a))} m`
      : '—';

    // Value then bar in each group, with the height value carrying the group
    // divider on its left edge.
    grid.append(
      label,
      val,
      barTrack(v, scale, v < 0 ? 'tl-bar gain' : 'tl-bar loss'),
      altEl,
      barTrack(a, altScale, 'tl-bar alt'),
    );
  }

  // Totals. Both columns close here: the time components sum to the finish-time
  // gap, and the height components (net changes off the start altitude) sum to
  // the finish-height gap. No bars — a total can exceed every component, so it
  // has no place on the components' scale.
  const totalLabel = document.createElement('div');
  totalLabel.className = 'tl-label tl-total-label';
  totalLabel.textContent = 'Finish';
  totalLabel.title = 'at ESS: elapsed time and height, both relative to the winner';

  const totalTime = document.createElement('div');
  totalTime.className = 'tl-val';
  totalTime.textContent = signedTime(loss.total);

  const totalAlt = document.createElement('div');
  totalAlt.className = 'tl-alt tl-div';
  totalAlt.textContent = Number.isFinite(loss.altFinish)
    ? `${loss.altFinish < 0 ? '−' : '+'}${Math.abs(Math.round(loss.altFinish))} m`
    : '—';

  // A single full-width rule above the total, so the underline is one unbroken
  // line rather than five bordered cells split by the column gaps.
  const rule = document.createElement('div');
  rule.className = 'tl-rule';

  // Same column order as the component rows (value, bar per group) with empty
  // bar cells, so the totals line up under their columns.
  const totalCells = [totalLabel, totalTime, document.createElement('div'), totalAlt, document.createElement('div')];
  for (const el of totalCells) el.classList.add('tl-total');
  grid.append(rule, ...totalCells);

  panel.appendChild(grid);

  const foot = document.createElement('div');
  foot.className = 'tl-foot';
  foot.textContent =
    `Vs ${refLabel}: positive time = slower in that phase, and the components sum to the total gap. ` +
    'Height is net metres gained or lost in the same phase (start compares altitude at the line).';
  panel.appendChild(foot);

  // Reference block: descriptive metrics that characterise the flight but don't
  // feed the additive totals above. Neutral styling (no rust/teal, no bars) so
  // they read as context, not as another win/lose axis.
  if (loss.total !== 0) {
    const CONTEXT: {
      key: keyof TimeLossRow['context'];
      label: string;
      fmt: (v: number) => string;
    }[] = [
      { key: 'avgClimbRate', label: 'Average climb rate', fmt: (v) => `${v.toFixed(2)} m/s` },
      { key: 'avgAltitude', label: 'Average altitude', fmt: (v) => `${Math.round(v)} m` },
      { key: 'totalDistance', label: 'Total distance flown', fmt: (v) => `${(v / 1000).toFixed(1)} km` },
    ];

    const ctx = document.createElement('div');
    ctx.className = 'tl-context';

    const ctxHead = document.createElement('div');
    ctxHead.className = 'tl-context-head';
    ctxHead.textContent = `Reference (Relative to ${refLabel})`;
    ctx.appendChild(ctxHead);

    const ctxGrid = document.createElement('div');
    ctxGrid.className = 'tl-context-grid';
    for (const m of CONTEXT) {
      const value = loss.context[m.key];
      const delta = loss.contextVsWinner[m.key];

      const label = document.createElement('div');
      label.className = 'tl-context-label';
      label.textContent = m.label;

      // Shown relative to the winner: the signed gap is the headline, the
      // pilot's own value trails as muted context.
      const val = document.createElement('div');
      val.className = 'tl-context-val';
      val.textContent = Number.isFinite(delta)
        ? `${delta < 0 ? '−' : '+'}${m.fmt(Math.abs(delta))}`
        : '—';

      const vs = document.createElement('div');
      vs.className = 'tl-context-vs';
      vs.textContent = Number.isFinite(value) ? `${m.fmt(value)} actual` : '';

      // Neutral, zero-centred bar scaled to the day's largest gap on this metric
      // (field-relative — a lone context metric has nothing in-row to size
      // against). No rust/teal: more climb rate or altitude isn't reliably
      // better, so this reads as magnitude of difference, not win/lose.
      const bar = barTrack(delta, contextScale[m.key] || 1, 'tl-bar alt');
      bar.classList.add('tl-context-track');

      ctxGrid.append(label, val, bar, vs);
    }
    ctx.appendChild(ctxGrid);
    panel.appendChild(ctx);
  }

  tr.appendChild(td);
  return tr;
}

function tableEl(
  table: StatsTable,
  rows: StatsTable['completed'],
  gradient: boolean,
  sel: Selection,
  colors: Map<string, string>,
  timeLoss: TimeLossData,
): { el: HTMLElement; rerender: () => void } {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const t = document.createElement('table');
  t.className = gradient ? 'stats gradient' : 'stats';

  // Default to sorting by Completion Time (column index 1), fastest first.
  let sortCol = table.headers.findIndex((h) => h.startsWith('Completion Time'));
  let sortDir: 1 | -1 = 1;
  // Deselected pilots are tucked into a collapsed section to shorten the page.
  let showDeselected = false;

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');

  // Leading checkbox column: a "select all" toggle that acts on every pilot
  // across both tables, and reflects the overall selection state
  // (checked / unchecked / indeterminate).
  const selectAllTh = document.createElement('th');
  selectAllTh.className = 'select-col';
  const selectAll = document.createElement('input');
  selectAll.type = 'checkbox';
  selectAll.addEventListener('change', () => sel.setMany(sel.all(), selectAll.checked));
  selectAllTh.appendChild(selectAll);
  htr.appendChild(selectAllTh);

  const ths: HTMLTableCellElement[] = [];
  table.headers.forEach((h, ci) => {
    const th = document.createElement('th');
    th.textContent = h;
    th.classList.add('sortable');
    th.addEventListener('click', () => {
      if (sortCol === ci) {
        sortDir = (sortDir === 1 ? -1 : 1) as 1 | -1;
      } else {
        sortCol = ci;
        sortDir = 1;
      }
      renderBody();
    });
    ths.push(th);
    htr.appendChild(th);
  });
  thead.appendChild(htr);

  const tbody = document.createElement('tbody');

  // Current row element per pilot, rebuilt on each renderBody, so the highlight
  // subscription can toggle the bold class without a full re-render.
  const rowEls = new Map<string, HTMLElement>();

  // Compare two rows on the active column: numeric where possible, with
  // non-numeric cells ('—') always sorted to the bottom.
  function compare(a: StatsTable['completed'][number], b: StatsTable['completed'][number]): number {
    const at = a[sortCol].text;
    const bt = b[sortCol].text;
    const an = parseFloat(at);
    const bn = parseFloat(bt);
    const aNum = !Number.isNaN(an);
    const bNum = !Number.isNaN(bn);
    if (aNum && bNum) return (an - bn) * sortDir;
    if (aNum) return -1;
    if (bNum) return 1;
    return at.localeCompare(bt) * sortDir;
  }

  function renderBody(): void {
    ths.forEach((th, ci) => {
      const base = table.headers[ci];
      th.textContent = ci === sortCol ? `${base} ${sortDir === 1 ? '▲' : '▼'}` : base;
    });

    // Reflect the overall selection (across both tables) in the header checkbox.
    const total = sel.all().length;
    const selCount = sel.selectedCount();
    selectAll.checked = selCount === total;
    selectAll.indeterminate = selCount > 0 && selCount < total;

    // Gradient bounds reflect the current selection: graded against the other
    // selected pilots. With a single selection there's nothing to grade
    // against, so fall back to the full group so the cells show that pilot's
    // overall rank. Only gradient tables are shaded.
    const selectedRows = rows.filter((r) => sel.has(r[0].text));
    const basis = selectedRows.length >= 2 ? selectedRows : rows;
    const bounds = gradient
      ? table.dirs.map((dir, ci) => {
          if (!dir) return null;
          const vals = basis.map((r) => r[ci].value).filter(Number.isFinite);
          return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
        })
      : table.dirs.map(() => null);

    const buildRow = (row: StatsTable['completed'][number], isSelected: boolean): HTMLElement => {
      const name = row[0].text;
      const tr = document.createElement('tr');
      if (!isSelected) tr.classList.add('unselected');
      rowEls.set(name, tr);

      const checkTd = document.createElement('td');
      checkTd.className = 'select-col';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = isSelected;
      // The checkbox doubles as the pilot's colour key: a checked box fills with
      // their track colour, matching how they're drawn on the map and charts.
      check.style.accentColor = colors.get(name) ?? PALETTE[0];
      check.addEventListener('change', () => sel.toggle(name));
      checkTd.appendChild(check);
      tr.appendChild(checkTd);

      row.forEach((cell, ci) => {
        const td = document.createElement('td');
        if (ci === 0) {
          td.className = 'name';
          td.append(document.createTextNode(cell.text));
          // Click the pilot name to pin the highlight (click again to unpin).
          td.title = 'Click to pin/unpin highlight';
          td.addEventListener('click', () => sel.togglePin(name));
        } else {
          td.textContent = cell.text;
        }
        // Shade only selected rows, relative to the selected-pilot bounds.
        const b = bounds[ci];
        const bg = isSelected && b ? gradientColor(cell.value, b.min, b.max, table.dirs[ci]) : null;
        if (bg) {
          td.style.backgroundColor = bg;
          td.classList.add('shaded');
        }
        tr.appendChild(td);
      });
      return tr;
    };

    // The active column sort orders within the selected / deselected groups.
    const sortRows = (subset: StatsTable['completed']): StatsTable['completed'] =>
      sortCol < 0 ? subset : [...subset].sort(compare);
    const selectedSorted = sortRows(rows.filter((r) => sel.has(r[0].text)));
    const deselectedSorted = sortRows(rows.filter((r) => !sel.has(r[0].text)));

    tbody.innerHTML = '';
    rowEls.clear();
    for (const row of selectedSorted) tbody.appendChild(buildRow(row, true));

    // Collapsible section holding the deselected pilots.
    if (deselectedSorted.length) {
      const toggleTr = document.createElement('tr');
      toggleTr.className = 'deselected-toggle';
      const td = document.createElement('td');
      td.colSpan = table.headers.length + 1;
      const n = deselectedSorted.length;
      td.textContent = `${showDeselected ? '▾' : '▸'}  ${n} deselected pilot${n === 1 ? '' : 's'}`;
      td.addEventListener('click', () => {
        showDeselected = !showDeselected;
        renderBody();
      });
      toggleTr.appendChild(td);
      tbody.appendChild(toggleTr);

      if (showDeselected) for (const row of deselectedSorted) tbody.appendChild(buildRow(row, false));
    }

    // Newly built rows should reflect the current highlight.
    applyHighlight();
  }

  const lossByPilot = new Map(timeLoss.rows.map((r) => [r.pilot, r]));

  // Mark the pinned pilot's row (persistent click-to-pin emphasis) and open a
  // time-loss breakdown directly beneath it.
  const applyHighlight = (): void => {
    for (const [name, el] of rowEls) el.classList.toggle('pinned', sel.isPinned(name));

    tbody.querySelector('tr.time-loss')?.remove();
    const pinned = sel.highlight();
    if (!pinned) return;
    const anchor = rowEls.get(pinned);
    const loss = lossByPilot.get(pinned);
    if (!anchor || !loss || !timeLoss.winner) return;

    anchor.after(
      timeLossRow(loss, timeLoss.winner, table.headers.length + 1, timeLoss.contextScale, timeLoss.topCount),
    );
  };
  sel.onHighlight(applyHighlight);

  renderBody();
  t.append(thead, tbody);
  wrap.appendChild(t);
  return { el: wrap, rerender: renderBody };
}

// Plugin: draw a dashed vertical line at each visible pilot's average climb
// rate, with a hover label when the cursor is near a line.
interface AvgLine {
  x: number;
  pilot: string;
  avg: number;
  color: string;
}
type ChartWithAvg = Chart & {
  $avgLines?: AvgLine[];
  $avgHover?: string | null;
  $pinned?: string | null;
};

// Plugin: stroke a white ring around the pinned pilot's points, matching their
// dots on the map and altitude plot. Drawn last so it sits on top of the lines.
const pinnedPointsPlugin: Plugin<'line'> = {
  id: 'pinnedPoints',
  afterDatasetsDraw(chart) {
    const pinned = (chart as ChartWithAvg).$pinned;
    if (!pinned) return;
    const i = chart.data.datasets.findIndex((d) => d.label === pinned);
    if (i < 0 || !chart.isDatasetVisible(i)) return;
    const { ctx } = chart;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    for (const pt of chart.getDatasetMeta(i).data) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, (pt as unknown as { options?: { radius?: number } }).options?.radius ?? 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  },
};

const avgLinePlugin: Plugin<'line'> = {
  id: 'avgLines',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const c = chart as ChartWithAvg;
    const hover = c.$avgHover;
    const lines: AvgLine[] = [];

    chart.data.datasets.forEach((ds, i) => {
      // Only selected pilots get an average line; deselected pilots stay as
      // plain grey background curves.
      if (!(ds as ClimbDataset).selected) return;
      if (!chart.isDatasetVisible(i)) return;
      const avg = (ds as ClimbDataset).avgClimbRate;
      if (avg == null || !Number.isFinite(avg)) return; // null after JSON round-trip
      const x = scales.x.getPixelForValue(avg);
      if (x < chartArea.left || x > chartArea.right) return;
      const color = ds.borderColor as string;
      const hovered = ds.label === hover;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = color;
      ctx.globalAlpha = hovered ? 1 : 0.7;
      ctx.lineWidth = hovered ? 3 : 1.5;
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
      lines.push({ x, pilot: ds.label as string, avg, color });
    });
    c.$avgLines = lines;

    // Draw the hover label for the line under the cursor.
    const entry = hover ? lines.find((l) => l.pilot === hover) : undefined;
    if (entry) {
      ctx.save();
      ctx.font = "12px 'Roboto', system-ui, sans-serif";
      ctx.textBaseline = 'middle';
      const text = `${entry.pilot} — avg ${entry.avg.toFixed(2)} m/s`;
      const padX = 7;
      const w = ctx.measureText(text).width + padX * 2;
      const h = 22;
      let bx = entry.x + 8;
      if (bx + w > chartArea.right) bx = entry.x - 8 - w;
      const by = chartArea.top + 6;
      ctx.fillStyle = 'rgba(20, 12, 12, 0.92)';
      ctx.beginPath();
      ctx.roundRect(bx, by, w, h, 5);
      ctx.fill();
      ctx.fillStyle = entry.color;
      ctx.fillRect(bx, by, 3, h);
      ctx.fillStyle = '#f5efe1';
      ctx.fillText(text, bx + padX, by + h / 2 + 1);
      ctx.restore();
    }
  },
  afterEvent(chart, args) {
    const c = chart as ChartWithAvg;
    const e = args.event;
    let near: string | null = null;
    if (e.type === 'mousemove') {
      const { top, bottom } = chart.chartArea;
      if (e.x != null && e.y != null && e.y >= top && e.y <= bottom) {
        let best = 6; // px proximity threshold
        for (const l of c.$avgLines ?? []) {
          const d = Math.abs(l.x - e.x);
          if (d <= best) {
            best = d;
            near = l.pilot;
          }
        }
      }
    } else if (e.type !== 'mouseout') {
      return;
    }
    if (near !== (c.$avgHover ?? null)) {
      c.$avgHover = near;
      args.changed = true;
    }
  },
};

/** Shortest distance from point (px,py) to segment (ax,ay)-(bx,by). */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The pilot whose climb-chart line is under (x, y), or null. Tests the
 * average-thermal vertical lines first, then each visible pilot's curve;
 * everything must be within a few px so empty clicks don't pin anyone.
 */
function pilotAtChartPoint(chart: ChartWithAvg, x: number, y: number): string | null {
  const { top, bottom } = chart.chartArea;
  const THRESH = 6;
  if (y < top || y > bottom) return null;
  // Vertical average-thermal lines.
  let best = THRESH;
  let pilot: string | null = null;
  for (const l of chart.$avgLines ?? []) {
    const d = Math.abs(l.x - x);
    if (d <= best) {
      best = d;
      pilot = l.pilot;
    }
  }
  // Pilot distribution curves (only visible/selected datasets are interactive).
  chart.data.datasets.forEach((ds, i) => {
    if (!chart.isDatasetVisible(i)) return;
    const pts = chart.getDatasetMeta(i).data;
    for (let k = 0; k < pts.length - 1; k++) {
      const d = distToSegment(x, y, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y);
      if (d <= best) {
        best = d;
        pilot = ds.label as string;
      }
    }
  });
  return pilot;
}

/** Extra per-dataset fields the climb chart and avg-line plugin rely on. */
type ClimbDataset = ChartDataset<'line'> & {
  avgClimbRate?: number;
  baseColor?: string;
  selected?: boolean;
};

// Plugin: draw deselected pilots as faint grey background lines. They are hidden
// from Chart.js (so they're non-interactive), so we stroke them directly from
// the dataset values here, behind the selected datasets.
const greyBackgroundPlugin: Plugin<'line'> = {
  id: 'greyBackground',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const xs = scales.x;
    const ys = scales.y;
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
    ctx.clip();
    ctx.strokeStyle = DESELECTED_GREY;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    for (const ds of chart.data.datasets as ClimbDataset[]) {
      if (ds.selected) continue;
      const pts = ds.data as { x: number; y: number }[];
      ctx.beginPath();
      pts.forEach((p, i) => {
        const px = xs.getPixelForValue(p.x);
        const py = ys.getPixelForValue(p.y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    ctx.restore();
  },
};

/**
 * Restyle the climb chart for the current selection: selected pilots draw in
 * their own colour, deselected pilots fade to faint grey background lines, and
 * when exactly one pilot is selected its line is thickened. The `selected` flag
 * also tells the avg-line plugin which pilots get a vertical average line.
 */
function styleChartDatasets(chart: Chart, sel: Selection): void {
  const single = sel.selectedCount() === 1;
  const highlight = sel.highlight();
  chart.data.datasets.forEach((ds, i) => {
    const d = ds as ClimbDataset;
    const on = sel.has(d.label as string);
    d.selected = on;
    // Pinned pilot rides on top: Chart.js draws lower `order` last (front).
    d.order = d.label === highlight ? -1 : 0;
    // Deselected pilots are *hidden* from Chart.js so they take no part in
    // hover/tooltip/nearest interaction; the greyBackground plugin still draws
    // them as faint background lines. Selected pilots are normal interactive
    // datasets, drawn in their own colour.
    chart.setDatasetVisibility(i, on);
    if (on) {
      const isPinned = d.label === highlight;
      d.borderColor = d.baseColor;
      d.backgroundColor = d.baseColor;
      // The pinned pilot's line is bolder than the rest; a lone selection is
      // also thickened slightly.
      d.borderWidth = isPinned ? 4.5 : single ? 3.5 : 2;
      d.pointRadius = isPinned ? 5 : 4;
      d.pointHoverRadius = 6;
    }
  });
  // Remember the pinned pilot so pinnedPointsPlugin can ring their points.
  (chart as ChartWithAvg).$pinned = highlight;
}

function makeChart(
  canvas: HTMLCanvasElement,
  series: ClimbSeries[],
  sel: Selection,
  colors: Map<string, string>,
): Chart {
  const datasets = series.map((s) => {
    const color = colors.get(s.pilot) ?? PALETTE[0];
    return {
      label: s.pilot,
      data: s.values.map((y, x) => ({ x: x + 1, y })),
      borderColor: color,
      backgroundColor: color,
      baseColor: color,
      avgClimbRate: s.avgClimbRate,
      selected: sel.has(s.pilot),
      tension: 0,
      pointRadius: 4,
      pointHoverRadius: 6,
    } as ClimbDataset;
  });

  return new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      // Click a pilot's curve or their average-thermal line to pin/unpin them.
      onClick: (evt, _els, chart) => {
        const pilot = pilotAtChartPoint(chart as ChartWithAvg, evt.x ?? -1, evt.y ?? -1);
        if (pilot) sel.togglePin(pilot);
      },
      // Pointer cursor over a clickable line so the pin affordance is discoverable.
      onHover: (evt, _els, chart) => {
        const over = pilotAtChartPoint(chart as ChartWithAvg, evt.x ?? -1, evt.y ?? -1);
        chart.canvas.style.cursor = over ? 'pointer' : 'default';
      },
      scales: {
        x: {
          type: 'linear',
          min: 0.5,
          max: 6.5,
          title: { display: true, text: 'Thermal Strength' },
          // Anchor ticks on the integer positions 1..6 so each maps to a
          // thermal-strength label (otherwise Chart.js lands on 0.5, 1.5, …
          // and every label resolves to '').
          afterBuildTicks: (axis) => {
            axis.ticks = CLIMB_RATE_TICKS.map((_, i) => ({ value: i + 1 }));
          },
          ticks: {
            callback: (v) => CLIMB_RATE_TICKS[Number(v) - 1] ?? '',
          },
          grid: { display: false },
        },
        y: {
          title: { display: true, text: 'Percentage of Climbing Time (%)' },
          beginAtZero: true,
        },
      },
      plugins: {
        // Pilot names live in the table; the chart legend is hidden to reduce
        // clutter. Selection is driven by the table and synced via `sel`.
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => CLIMB_RATE_TICKS[Number(items[0].parsed.x) - 1] ?? '',
            label: (item) => `${item.dataset.label}: ${(item.parsed.y ?? 0).toFixed(1)}%`,
          },
        },
      },
    },
    plugins: [greyBackgroundPlugin, avgLinePlugin, pinnedPointsPlugin],
  });
}
