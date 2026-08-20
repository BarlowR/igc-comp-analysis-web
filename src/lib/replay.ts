/**
 * Shared replay core for the 2D results page and the 3D viewer: pilot
 * selection/colours, track interpolation, the play/scrub timeline with its
 * canvas plots (altitude, Time Lost), and the per-frame style tiers. Depends on
 * plain DOM + canvas only — no Leaflet, no Chart.js, no Cesium — so the 3D
 * pages can use it without pulling the 2D map/chart libraries into their bundle.
 */
import { lostSeries } from './timetogo';
import type { MapData, MapTrack, StatsTable } from './competition';

// 20 vivid hues so the default top-20 selection never repeats a colour. Every
// one is high-chroma (CIE76 C* ≥ 52) and clearly distinct from DESELECTED_GREY
// (ΔE ≥ 51) — so none read as grey-ish — and mutually separated (min ΔE ≈ 25).
// Ordered by interleaved hue so consecutive leaderboard pilots get strongly
// contrasting (opposite-wheel) colours.
export const PALETTE = [
  '#e6194b', '#0751a6', '#ad0000', '#297eff', '#ff5c0a',
  '#0044cc', '#a65107', '#2945ff', '#cc9600', '#0a0aff',
  '#8bad00', '#8800cc', '#08c408', '#de0aff', '#07a63c',
  '#eb00cb', '#07a671', '#a60767', '#29a9ff', '#ff0a9d',
];

// Muted grey used to draw deselected pilots as faint background lines on both
// the map and the climb chart, so the field stays visible without competing
// with the selected (coloured) pilots.
export const DESELECTED_GREY = '#9a948a';

/**
 * Assign every pilot one stable colour, keyed by name, so a pilot looks the
 * same on the map and on both climb charts. Built once per analysis run from
 * the canonical pilot order.
 */
export function buildPilotColors(names: string[]): Map<string, string> {
  const colors = new Map<string, string>();
  names.forEach((n, i) => colors.set(n, PALETTE[i % PALETTE.length]));
  return colors;
}

/**
 * Size tiers for a selected pilot's per-frame drawing, shared by the 2D map and
 * the 3D globe so a pinned or lone pilot reads the same in both. `dot` is the
 * 2D position-dot radius; `marker` is the 3D point's pixel diameter — the globe
 * reads smaller against terrain, so it is not simply 2 × dot.
 */
export function renderStyle(single: boolean, highlighted: boolean): {
  trail: number;
  dot: number;
  marker: number;
} {
  return {
    trail: highlighted ? 5 : single ? 4 : 2.5,
    dot: highlighted ? 7 : single ? 6 : 4,
    marker: highlighted ? 14 : single ? 12 : 9,
  };
}

/**
 * Shared pilot-selection state for one analysis run. The table, climb chart, and
 * map all read and mutate this, and re-render via subscriptions, so selecting a
 * pilot anywhere updates everywhere. Pilots are keyed by name.
 */
export interface Selection {
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

export function makeSelection(allNames: string[], initial: string[]): Selection {
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

/**
 * Canonical pilot order + shared selection/colours, used by both the 2D results
 * page and the 3D viewer so they agree on ordering, the top-20 default, and each
 * pilot's colour. Pilots are ordered completed-first (completed rows are already
 * sorted by completion time), so the first 20 are the leaderboard's top 20.
 */
export function buildPilotSelection(
  table: StatsTable,
  mapData: MapData,
): { ordered: string[]; sel: Selection; colors: Map<string, string>; truncated: boolean; topN: number } {
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

  // With a large field, default to just the top 20 to keep the view manageable;
  // otherwise select everyone. Across the whole field, not per group: `ordered`
  // lists finishers first, so on a day with 20+ finishers nobody in "Did Not
  // Complete Task" is selected and that group's climb chart hides itself
  // (syncChart) until you tick someone. That's intended.
  const TOP_N = 20;
  const TRUNCATE_ABOVE = 50;
  const truncated = ordered.length > TRUNCATE_ABOVE;
  const sel = makeSelection(ordered, truncated ? ordered.slice(0, TOP_N) : ordered);
  const colors = buildPilotColors(ordered);
  return { ordered, sel, colors, truncated, topN: TOP_N };
}

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
export function positionAt(tr: MapTrack, t: number): [number, number] | null {
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

/** Interpolate a track's GPS altitude (m) at epoch-ms `t`, or null if out of range. */
export function altAt(tr: MapTrack, t: number): number | null {
  const { times, alt } = tr;
  const n = times.length;
  if (n === 0 || t < times[0] || t > times[n - 1]) return null;
  const i = lastIdxAtOrBefore(times, t);
  if (i >= n - 1) return alt[i];
  const span = times[i + 1] - times[i];
  const f = span > 0 ? (t - times[i]) / span : 0;
  return alt[i] + (alt[i + 1] - alt[i]) * f;
}

/**
 * The flown-so-far trail up to epoch-ms `t`: every fix at or before `t` (via
 * `at(i)`, so the caller picks the coordinate space — [lat, lon] for the 2D map,
 * Cartesian3 for the globe), plus the interpolated tip at exactly `t` (via
 * `tip`, skipped once the whole track is behind the cursor). Empty before the
 * first fix or for a non-finite `t`.
 */
export function trailUpTo<P>(
  times: number[],
  t: number,
  at: (i: number) => P,
  tip: (t: number) => P | null,
): P[] {
  const n = times.length;
  if (n === 0 || !Number.isFinite(t) || t < times[0]) return [];
  const last = t >= times[n - 1] ? n - 1 : lastIdxAtOrBefore(times, t);
  const out: P[] = [];
  for (let i = 0; i <= last; i++) out.push(at(i));
  if (t < times[n - 1]) {
    const end = tip(t);
    if (end) out.push(end);
  }
  return out;
}

/**
 * Epoch ms -> "HH:MM:SS" in task-local time. Fix times are true UTC instants
 * (see igc.ts), so the clock is read with the UTC accessors and shifted by
 * `offsetMin` — the comp's offset for that date, carried in the manifest by
 * whichever crawler imported the day. Neither the machine that built the
 * archive nor the one reading it gets a say. Null offset displays UTC.
 */
export function formatClock(ms: number, offsetMin: number | null): string {
  const d = new Date(ms);
  const utcSecs = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  const secs = (((utcSecs + (offsetMin ?? 0) * 60) % 86400) + 86400) % 86400;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(secs / 3600))}:${p(Math.floor((secs % 3600) / 60))}:${p(secs % 60)}`;
}

/** A moment worth flagging on the time axis — today, an annotation. */
export interface TimeMarker {
  timeMs: number;
  /** Usually the annotated pilot's colour, so a tick keys to a track. */
  color: string;
}

/** Handle onto a mounted scrubber, for callers that need to drive it. */
export interface Timeline {
  /** Jump the playhead to `ms` (stops playback, as a manual scrub does). */
  seek(ms: number): void;
  /** Replace the ticks drawn along the altitude plot's time axis. */
  setMarkers(marks: TimeMarker[]): void;
}

/**
 * A scrubber (play/pause + clock + altitude plot) that replays the day. Drives a
 * caller-supplied `frame(t)` — the 2D map draws moving dots/trails, the 3D
 * viewer moves its markers — while the altitude plot below doubles as the
 * draggable slider. The bar + plot are inserted right after `afterEl`.
 *
 * Shared by the 2D results page and the 3D viewer so both get the identical
 * control, colours and playback. `opts.timeLost` adds the Time Lost chart
 * alongside altitude — the 3D viewer only; the 2D page shows altitude alone.
 * Hike-and-fly days never get it, on either page: the caller says so, and the
 * data it needs (`data.timeToGo`) isn't built for them either — see
 * Competition.buildMapData.
 */
export function mountTimeline(
  afterEl: HTMLElement,
  data: MapData,
  sel: Selection,
  colors: Map<string, string>,
  frame: (t: number) => void,
  durationMs = 60_000,
  opts: { timeLost?: boolean } = {},
): Timeline | null {
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
  if (!Number.isFinite(tMin) || tMax <= tMin) return null; // nothing to scrub

  // This bar holds the play/pause button and the clock readout; the altitude
  // plot inserted after it is the actual draggable slider.
  const bar = document.createElement('div');
  bar.className = 'time-slider';
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'time-slider-play';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.textContent = '▶';
  const label = document.createElement('span');
  label.className = 'time-slider-label';

  // Playback-speed slider: sets how long a full-day sweep takes (log scale, so
  // the middle feels natural). `sweepMs` is read live by the playback loop.
  const MIN_DUR = 15_000; // fastest full sweep
  const MAX_DUR = 600_000; // slowest full sweep
  let sweepMs = Math.min(MAX_DUR, Math.max(MIN_DUR, durationMs));
  const durToVal = (d: number): number => Math.log(d / MAX_DUR) / Math.log(MIN_DUR / MAX_DUR);
  const valToDur = (v: number): number => MAX_DUR * Math.pow(MIN_DUR / MAX_DUR, v);
  const speed = document.createElement('input');
  speed.type = 'range';
  speed.min = '0';
  speed.max = '1';
  speed.step = '0.001';
  speed.value = String(durToVal(sweepMs));
  speed.title = 'Playback speed';
  speed.className = 'time-slider-speed'; // width lives in CSS: phones want it shorter
  speed.addEventListener('input', () => {
    sweepMs = valToDur(Number(speed.value));
  });
  const speedWrap = document.createElement('span');
  speedWrap.style.cssText = 'display:flex;align-items:center;gap:0.3rem';
  const slow = document.createElement('span');
  slow.textContent = '🐢';
  const fast = document.createElement('span');
  fast.textContent = '🐇';
  speedWrap.append(slow, speed, fast);

  // Chart selector lives inline in this row, right of the speed slider; the
  // clock is pushed to the far right. It stays empty when there's only one plot.
  const toggleWrap = document.createElement('span');
  toggleWrap.className = 'chart-toggle';
  label.style.marginLeft = 'auto';

  // One row: play · speed slider · chart selector · clock (right-aligned).
  bar.append(playBtn, speedWrap, toggleWrap, label);
  afterEl.insertAdjacentElement('afterend', bar);

  // Current scrub time. Starts at the task start gate (falling back to the first
  // fix if the task has no defined start), clamped into the track window.
  let currentMs =
    data.startMs != null ? Math.min(tMax, Math.max(tMin, data.startMs)) : tMin;
  const setTime = (ms: number): void => {
    currentMs = Math.min(tMax, Math.max(tMin, ms));
    render();
  };

  // Chart dock below the bar: a toggle over a resizable body holding whichever
  // plot is active. Altitude always; Time Lost only where the caller asks for it
  // (the 3D viewer) and the day has the data. Every plot shares the time axis,
  // colours, selection and scrubbing, and acts as the slider.
  const scrub = (ms: number): void => {
    stop(); // a manual scrub interrupts playback
    setTime(ms);
  };
  const dock = document.createElement('div');
  dock.className = 'chart-dock';
  const body = document.createElement('div');
  body.className = 'chart-dock-body';
  const grip = document.createElement('div');
  grip.className = 'chart-dock-grip';
  grip.title = 'Drag to resize';
  dock.append(body);
  bar.insertAdjacentElement('afterend', dock);
  bar.insertAdjacentElement('beforebegin', grip); // resize grip sits above the play row

  // Restore a user-set height (persisted across visits); CSS supplies the default.
  // The store is shared with wider screens, where a comfortable chart is taller
  // than a phone can give up — so cap it there rather than bury the map.
  const HKEY = 'chartDockHeight';
  const savedH = Number(localStorage.getItem(HKEY));
  const capH = window.innerWidth <= 700 ? window.innerHeight * 0.4 : Infinity;
  if (Number.isFinite(savedH) && savedH >= 120) {
    body.style.height = `${Math.round(Math.min(savedH, capH))}px`;
  }

  // Ticks on the time axis, owned by whoever called mountTimeline (the 3D
  // viewer's annotations). Read live by the plot so setMarkers is just a redraw.
  let markers: TimeMarker[] = [];
  const drawAlt = createAltitudePlot(body, data, tMin, tMax, sel, colors, scrub, () => markers);
  const drawTtg =
    opts.timeLost !== false && data.timeToGo
      ? createTimeToGoPlot(body, data, tMin, tMax, sel, colors, scrub)
      : null;
  const plots: { label: string; draw: (t: number) => void }[] = [{ label: 'Altitude', draw: drawAlt }];
  if (drawTtg) plots.push({ label: 'Time Lost', draw: drawTtg });
  const wraps = Array.from(body.children) as HTMLElement[]; // one .alt-plot per plot, in order

  let active = 0;
  const btns: HTMLButtonElement[] = [];
  const showActive = (): void => {
    wraps.forEach((w, i) => (w.style.display = i === active ? '' : 'none'));
    btns.forEach((b, i) => b.classList.toggle('on', i === active));
    plots[active].draw(currentMs);
  };
  if (plots.length > 1) {
    plots.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chart-toggle-btn';
      b.textContent = p.label;
      b.addEventListener('click', () => {
        active = i;
        showActive();
      });
      btns.push(b);
      toggleWrap.appendChild(b);
    });
  }

  // Resize: drag the grip to change the dock body height (persisted).
  let resizing = false;
  let startY = 0;
  let startH = 0;
  grip.addEventListener('pointerdown', (e) => {
    resizing = true;
    startY = e.clientY;
    startH = body.getBoundingClientRect().height;
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    // Grip sits above the play row: dragging up (clientY decreases) enlarges the chart.
    body.style.height = `${Math.max(120, Math.min(600, startH - (e.clientY - startY)))}px`;
  });
  const endResize = (e: PointerEvent): void => {
    if (!resizing) return;
    resizing = false;
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    localStorage.setItem(HKEY, String(Math.round(body.getBoundingClientRect().height)));
  };
  grip.addEventListener('pointerup', endResize);
  grip.addEventListener('pointercancel', endResize);

  showActive();

  const render = (): void => {
    label.textContent = formatClock(currentMs, data.utcOffsetMinutes);
    frame(currentMs);
    plots[active].draw(currentMs); // keep the active plot in sync
  };

  // Re-run the frame when the selection (or highlight) changes at a fixed time.
  sel.subscribe(render);
  sel.onHighlight(render);

  // --- playback ------------------------------------------------------------
  // Sweep the whole day in `sweepMs` of real time (set live by the speed
  // slider); rAF stops itself if the control has been torn down.
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
    if (!bar.isConnected) return; // control was removed; let the loop die
    const dt = last ? now - last : 0;
    last = now;
    const next = currentMs + ((tMax - tMin) * dt) / sweepMs;
    if (next >= tMax) {
      setTime(tMax);
      stop();
      return;
    }
    setTime(next);
    raf = requestAnimationFrame(tick);
  };
  const toggle = (): void => {
    if (raf) {
      stop();
      return;
    }
    if (currentMs >= tMax) currentMs = tMin; // restart from the top
    last = 0;
    playBtn.textContent = '❚❚';
    playBtn.setAttribute('aria-label', 'Pause');
    raf = requestAnimationFrame(tick);
  };
  playBtn.addEventListener('click', toggle);

  // Space toggles play/pause globally — except when typing in a field, or when
  // the play button itself is focused (its native click already fires on Space).
  const onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (!bar.isConnected) {
      document.removeEventListener('keydown', onKey); // control torn down; unbind
      return;
    }
    if (e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
    e.preventDefault(); // stop the page from scrolling
    toggle();
  };
  document.addEventListener('keydown', onKey);

  render();

  return {
    seek: scrub,
    setMarkers(next) {
      markers = next;
      plots[active].draw(currentMs);
    },
  };
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
  parent: HTMLElement,
  data: MapData,
  tMin: number,
  tMax: number,
  sel: Selection,
  colors: Map<string, string>,
  onScrub: (ms: number) => void,
  getMarkers: () => TimeMarker[] = () => [],
): (t: number) => void {
  const wrap = document.createElement('div');
  wrap.className = 'alt-plot';
  const title = document.createElement('div');
  title.className = 'alt-plot-title';
  title.textContent = 'Altitude (m) — drag to scrub';
  const canvas = document.createElement('canvas');
  canvas.className = 'alt-plot-canvas';
  wrap.append(title, canvas);
  parent.appendChild(wrap);

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

    // Annotation ticks: a small pennant hanging from the top of the plot at each
    // marked moment, in the annotated pilot's colour. Drawn last so they stay
    // legible over a dense field of traces.
    for (const m of getMarkers()) {
      if (!(m.timeMs >= tMin && m.timeMs <= tMax)) continue;
      const x = xOf(m.timeMs);
      ctx.fillStyle = m.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 4, PAD.t);
      ctx.lineTo(x + 4, PAD.t);
      ctx.lineTo(x, PAD.t + 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
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

/**
 * A canvas "time lost vs par" plot: per pilot, L(t) = τ(t) + (t − t_gate)/60 −
 * τ_ref (minutes), i.e. cumulative time lost against a single common par ghost.
 * Flat = flying at par, rising = losing time, falling = gaining; the finish dot
 * is the pilot's final deficit. (This normalises out the raw τ's slope −1, so par
 * is the flat L = 0 line.) Finisher lines truncate at ESS. Shares the time axis,
 * colours, selection and scrubbing with the altitude plot. Requires
 * `data.timeToGo` (precomputed server-side); returns `draw(t)`.
 */
function createTimeToGoPlot(
  parent: HTMLElement,
  data: MapData,
  tMin: number,
  tMax: number,
  sel: Selection,
  colors: Map<string, string>,
  onScrub: (ms: number) => void,
): (t: number) => void {
  // A wheel and a 48px axis gutter are desktop instruments; gate the y-clipping
  // on the input rather than the viewport, so a small laptop window keeps it and
  // a large tablet doesn't advertise a gesture it can't make.
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  const wrap = document.createElement('div');
  wrap.className = 'alt-plot';
  const title = document.createElement('div');
  title.className = 'alt-plot-title';
  // The day's measured par model alongside the name — the terms τ is computed
  // from (timetogo.ts): par climb M, and glide speed/ratio taken off the par
  // pilots' gliding fixes at build time.
  const ttg = data.timeToGo;
  const parTerms = ttg
    ? ` MC: ${ttg.M.toFixed(1)} m/s, Nominal Glide: ${(ttg.Vg * 3.6).toFixed(0)} km/h at ${ttg.g.toFixed(1)}:1, Par Correction: ×${ttg.pace.toFixed(2)}`
    : '';
  title.textContent = `Time lost vs top-10 median. ${parTerms}`;
  const canvas = document.createElement('canvas');
  canvas.className = 'alt-plot-canvas';
  wrap.append(title, canvas);
  parent.appendChild(wrap);
  const ctx = canvas.getContext('2d')!;

  const tracks = data.tracks.filter((tr) => tr.tau && tr.tau.length === tr.times.length);
  // Drawable extent: finishers stop at ESS (completionMs), others run to landing.
  const endIdx = (tr: MapTrack): number => {
    if (tr.completionMs == null) return tr.times.length;
    let i = 0;
    while (i < tr.times.length && tr.times[i] <= tr.completionMs) i++;
    return Math.max(i, 2);
  };
  const ends = new Map<string, number>(tracks.map((tr) => [tr.pilot, endIdx(tr)]));
  // First fix drawn: the pilot's SSS crossing (scored start) — the pre-start hold
  // before this shows nothing meaningful. Clamped to leave at least a short line.
  const startIdx = (tr: MapTrack): number => {
    if (tr.startCrossMs == null) return 0;
    let i = 0;
    while (i < tr.times.length && tr.times[i] < tr.startCrossMs) i++;
    return Math.min(i, Math.max(0, (ends.get(tr.pilot) ?? tr.times.length) - 2));
  };
  const starts = new Map<string, number>(tracks.map((tr) => [tr.pilot, startIdx(tr)]));

  // Minutes behind the par ghost (L), via the centralised lostSeries in timetogo.ts.
  const tauRef = data.timeToGo?.tauRef ?? 0;
  const gate = data.startMs ?? tMin;
  const Ls = new Map<string, number[]>(
    tracks.map((tr) => [tr.pilot, lostSeries(tr.tau!, tr.times, gate, tauRef)]),
  );
  const valOf = (tr: MapTrack, i: number): number => Ls.get(tr.pilot)![i];

  // Par reference = the median top-10 finisher's line, from their median START
  // point (time, L) to their median FINISH point. The top-10 straddle it, so the
  // gap to this line reads as minutes ahead of / behind the median winner.
  // Measured at build time (timetogo.ts `parReference`) and shipped in the
  // payload, so the plot draws the line the model was fitted on instead of
  // re-deriving it. Absent in a pre-version-2 saved cache — no line drawn.
  const par = data.timeToGo?.par ?? null;

  // Both axes clip to the SELECTED pilots so a few bunched leaders fill the chart
  // (in time and in τ) instead of being squashed by the whole field's span. Falls
  // back to all tracks when nothing is selected. Recomputed on selection change.
  let yMin = 0;
  let yMax = 1;
  /** The fit-to-selection bounds, kept even while a hand-clipped range is in force. */
  let autoY: [number, number] = [0, 1];
  /**
   * Set once the reader clips the axis by hand. From then on the y axis is
   * theirs: changing the selection re-fits the time axis but leaves this alone,
   * because a clip is usually made in order to then go looking through pilots.
   * Double-clicking the gutter hands it back. Deliberately not persisted — a
   * range chosen for one day's spread means nothing on the next.
   */
  let manualY: [number, number] | null = null;
  let tXMin = tMin;
  let tXMax = tMax;
  const recomputeBounds = (): void => {
    const chosen = tracks.filter((tr) => sel.has(tr.pilot));
    const pool = chosen.length ? chosen : tracks;
    let lo = Infinity;
    let hi = -Infinity;
    let xlo = Infinity;
    let xhi = -Infinity;
    for (const tr of pool) {
      const e = ends.get(tr.pilot)!;
      const s = starts.get(tr.pilot)!;
      if (e > s) {
        if (tr.times[s] < xlo) xlo = tr.times[s];
        if (tr.times[e - 1] > xhi) xhi = tr.times[e - 1];
      }
      for (let i = s; i < e; i++) {
        const v = valOf(tr, i);
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    const pad = (hi - lo) * 0.06 || 1;
    autoY = [lo - pad, hi + pad];
    [yMin, yMax] = manualY ?? autoY;
    tXMin = Number.isFinite(xlo) ? xlo : tMin;
    tXMax = Number.isFinite(xhi) && xhi > xlo ? xhi : tXMin + 1;
  };
  recomputeBounds();

  const PAD = { l: 48, r: 10, t: 8, b: 6 };
  let plotW = 0;
  let plotH = 0;
  let lastT = tMax;
  let base: HTMLCanvasElement | null = null;

  const xOf = (time: number): number => PAD.l + ((time - tXMin) / (tXMax - tXMin)) * plotW;
  const yOf = (v: number): number => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  const linePts = (tr: MapTrack): [number, number][] => {
    const e = ends.get(tr.pilot)!;
    const pts: [number, number][] = [];
    for (let i = starts.get(tr.pilot)!; i < e; i++) pts.push([xOf(tr.times[i]), yOf(valOf(tr, i))]);
    return pts;
  };

  // Interpolated L at time `t` (null outside the drawn extent).
  const Lat = (tr: MapTrack, t: number): number | null => {
    const e = ends.get(tr.pilot)!;
    const s = starts.get(tr.pilot)!;
    const { times, tau } = tr;
    if (!tau || e <= s || t < times[s] || t > times[e - 1]) return null;
    let lo = s;
    let hi = e - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (times[m] <= t) lo = m;
      else hi = m;
    }
    const span = times[hi] - times[lo];
    const a = valOf(tr, lo);
    const b = valOf(tr, hi);
    return span ? a + ((t - times[lo]) / span) * (b - a) : a;
  };

  const strokePath = (c: CanvasRenderingContext2D, pts: [number, number][]): void => {
    if (pts.length < 2) return;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.stroke();
  };

  const buildBase = (): void => {
    const b = document.createElement('canvas');
    b.width = canvas.width;
    b.height = canvas.height;
    const bc = b.getContext('2d')!;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    bc.scale(dpr, dpr);
    bc.lineJoin = 'round';
    bc.lineCap = 'round';
    bc.font = '11px system-ui, sans-serif';
    bc.textAlign = 'right';
    bc.textBaseline = 'middle';
    for (const v of niceTicks(yMin, yMax, 4)) {
      const y = yOf(v);
      bc.strokeStyle = 'rgba(20, 12, 12, 0.08)';
      bc.lineWidth = 1;
      strokePath(bc, [[PAD.l, y], [PAD.l + plotW, y]]);
      bc.fillStyle = '#6b625e';
      bc.fillText(String(Math.round(v)), PAD.l - 6, y);
    }
    // Everything data-shaped is clipped to the plot rect. The axis fits its data
    // until someone clips it by hand, and from then on lines run off the top and
    // bottom — over the tick labels and the title if nothing stops them.
    bc.save();
    bc.beginPath();
    bc.rect(PAD.l, PAD.t, plotW, plotH);
    bc.clip();

    // Grey full lines for context.
    bc.strokeStyle = 'rgba(154, 148, 138, 0.4)';
    bc.lineWidth = 1;
    for (const tr of tracks) strokePath(bc, linePts(tr));
    // Par reference: the diagonal through the top-10 median start and finish
    // points, extended across the plot. The gap from a pilot's line to this is
    // minutes ahead of (below) / behind (above) the median winner.
    if (par) {
      const slope = par.b[0] !== par.a[0] ? (par.b[1] - par.a[1]) / (par.b[0] - par.a[0]) : 0;
      const lAt = (time: number): number => par!.a[1] + slope * (time - par!.a[0]);
      bc.strokeStyle = 'rgba(20, 12, 12, 0.4)';
      bc.lineWidth = 1.5;
      bc.setLineDash([5, 3]);
      strokePath(bc, [[xOf(tXMin), yOf(lAt(tXMin))], [xOf(tXMax), yOf(lAt(tXMax))]]);
      bc.setLineDash([]);
      bc.fillStyle = '#6b655c';
      bc.font = '10px system-ui, sans-serif';
      bc.textAlign = 'left';
      bc.textBaseline = 'bottom';
      bc.fillText('par (top-10 median)', xOf(par.a[0]) + 3, yOf(par.a[1]) - 2);
    }
    // Start-gate marker (green), matching the SSS cylinder.
    if (data.startMs != null && data.startMs >= tMin && data.startMs <= tMax) {
      const sx = xOf(data.startMs);
      bc.strokeStyle = '#2e7d32';
      bc.lineWidth = 1.5;
      bc.setLineDash([4, 3]);
      strokePath(bc, [[sx, PAD.t], [sx, PAD.t + plotH]]);
      bc.setLineDash([]);
    }
    bc.restore();
    base = b;
  };

  const draw = (t: number): void => {
    lastT = t;
    if (!base || plotW <= 0) return;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Same clip as the cached layer: a hand-clipped axis puts pilots off-plot.
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.l, PAD.t, plotW, plotH);
    ctx.clip();

    const highlight = sel.highlight();
    const selected = tracks.filter((tr) => sel.has(tr.pilot));
    const order = highlight
      ? [...selected.filter((tr) => tr.pilot !== highlight), ...selected.filter((tr) => tr.pilot === highlight)]
      : selected;
    for (const tr of order) {
      ctx.strokeStyle = colors.get(tr.pilot) ?? PALETTE[0];
      ctx.lineWidth = tr.pilot === highlight ? 2.5 : 1.8;
      const fg = tr.finalGlide;
      const e = ends.get(tr.pilot)!;
      const s = starts.get(tr.pilot)!;
      if (!fg) {
        strokePath(ctx, linePts(tr));
      } else {
        // Solid normally, DASHED where the pilot is above the glide slope (final
        // glide = "altitude is useless"). Draw contiguous runs, each starting one
        // point back so there's no gap at the transitions between regimes.
        let i = s;
        while (i < e) {
          const on = fg[i];
          let j = i + 1;
          while (j < e && fg[j] === on) j++;
          const start = i > s ? i - 1 : i;
          ctx.setLineDash(on ? [6, 4] : []);
          ctx.beginPath();
          ctx.moveTo(xOf(tr.times[start]), yOf(valOf(tr, start)));
          for (let k = start + 1; k < j; k++) ctx.lineTo(xOf(tr.times[k]), yOf(valOf(tr, k)));
          ctx.stroke();
          i = j;
        }
        ctx.setLineDash([]);
      }
    }

    const square = (x: number, y: number, size: number, color: string): void => {
      ctx.fillStyle = color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      ctx.strokeRect(x - size / 2, y - size / 2, size, size);
    };
    // Finish markers: a square at each selected finisher's ESS crossing.
    for (const tr of order) {
      if (tr.completionMs == null) continue;
      const e = ends.get(tr.pilot)!;
      const sz = tr.pilot === highlight ? 9 : 7;
      square(xOf(tr.times[e - 1]), yOf(valOf(tr, e - 1)), sz, colors.get(tr.pilot) ?? PALETTE[0]);
    }

    // Time cursor.
    const cx = xOf(t);
    ctx.strokeStyle = 'rgba(20, 12, 12, 0.45)';
    ctx.lineWidth = 1;
    strokePath(ctx, [[cx, PAD.t], [cx, PAD.t + plotH]]);

    // Dots at the current L for selected pilots still in the race.
    for (const tr of order) {
      const v = Lat(tr, t);
      if (v == null) continue;
      ctx.fillStyle = colors.get(tr.pilot) ?? PALETTE[0];
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, yOf(v), tr.pilot === highlight ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
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
  new ResizeObserver(() => resize()).observe(canvas);
  requestAnimationFrame(resize);

  const timeFromX = (clientX: number): number => {
    if (plotW <= 0) return tXMin;
    const x = clientX - canvas.getBoundingClientRect().left - PAD.l;
    return tXMin + Math.min(1, Math.max(0, x / plotW)) * (tXMax - tXMin);
  };

  // --- clipping the y axis by hand (desktop) --------------------------------
  // One pilot who lands out at −180 min flattens the leaders into a band three
  // pixels tall, and they are usually the reason the chart is open. Wheel zooms
  // the value axis about the cursor; dragging the axis gutter pans it.
  const cssX = (clientX: number): number => clientX - canvas.getBoundingClientRect().left;
  /** The tick-label gutter left of the plot: a pan handle, not a scrub target. */
  const inGutter = (clientX: number): boolean => finePointer && cssX(clientX) < PAD.l;

  // Rebuilding the cached layer redraws every pilot's full line, so a drag that
  // did it per pointermove would stall a big day. One rebuild per frame instead
  // (the docks coalesce their resize nudge the same way).
  let yFrame = 0;
  const applyY = (min: number, max: number): void => {
    manualY = [min, max];
    yMin = min;
    yMax = max;
    if (yFrame) return;
    yFrame = requestAnimationFrame(() => {
      yFrame = 0;
      if (plotW > 0 && canvas.clientWidth > 0) {
        buildBase();
        draw(lastT);
      }
    });
  };

  if (finePointer) {
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (plotH <= 0 || cssX(e.clientX) < PAD.l) return; // the gutter pans instead
        e.preventDefault(); // this gesture is the chart's, not the page's
        const span = yMax - yMin;
        const y = e.clientY - canvas.getBoundingClientRect().top;
        // Zoom about the value under the cursor, so the line being read stays put.
        const at = yMin + (1 - (y - PAD.t) / plotH) * span;
        const MIN_SPAN = 0.5; // minutes — below this the axis says nothing
        const next = Math.min(
          Math.max(span * (e.deltaY > 0 ? 1.15 : 1 / 1.15), MIN_SPAN),
          (autoY[1] - autoY[0]) * 4, // no zooming out into empty space
        );
        const min = at - ((at - yMin) * next) / span;
        applyY(min, min + next);
      },
      { passive: false },
    );
  }

  let dragging: 'time' | 'y' | null = null;
  let lastPanY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (inGutter(e.clientX)) {
      dragging = 'y';
      lastPanY = e.clientY;
      return;
    }
    dragging = 'time';
    onScrub(timeFromX(e.clientX));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (finePointer && !dragging) canvas.style.cursor = inGutter(e.clientX) ? 'ns-resize' : '';
    if (dragging === 'time') {
      onScrub(timeFromX(e.clientX));
    } else if (dragging === 'y' && plotH > 0) {
      // The data follows the pointer: drag down and the range it sits in rises.
      const dv = ((e.clientY - lastPanY) * (yMax - yMin)) / plotH;
      lastPanY = e.clientY;
      applyY(yMin + dv, yMax + dv);
    }
  });
  const endDrag = (e: PointerEvent): void => {
    dragging = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  // Give the axis back to the selection.
  canvas.addEventListener('dblclick', (e) => {
    if (!inGutter(e.clientX)) return;
    manualY = null;
    rescale();
  });

  // Selection changes the clipped bounds → rescale (rebuild base) then redraw;
  // highlight only changes draw order, so a plain redraw is enough.
  const rescale = (): void => {
    recomputeBounds();
    if (plotW > 0 && canvas.clientWidth > 0) {
      buildBase();
      draw(lastT);
    }
  };
  sel.subscribe(rescale);
  sel.onHighlight(() => draw(lastT));

  return draw;
}
