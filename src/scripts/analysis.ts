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
import {
  Competition,
  CLIMB_RATE_TICKS,
  gradientColor,
  type StatsTable,
  type ClimbData,
  type ClimbSeries,
  type MapData,
} from '../lib/competition';

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Legend);

// Match the app's near-black text color for all chart text (ticks, titles, legend).
Chart.defaults.color = '#140c0c';

// Distinct hues chosen to stay legible on the light cream background.
const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#0097a7', '#f032e6', '#9e9d24', '#d81b60', '#469990',
  '#5e35b1', '#9a6324', '#800000', '#808000', '#000075', '#546e7a',
];

let charts: Chart[] = [];
let map: L.Map | null = null;

/** Derive a readable fallback pilot name from an IGC filename. */
export function nameFromFile(filename: string): string {
  return filename
    .replace(/\.igc$/i, '')
    .replace(/_\d{4}-\d{2}-\d{2}.*$/, '') // strip trailing date/id segment
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || filename;
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
}): Promise<void> {
  const { taskText, igc, resultsEl, statusEl } = opts;
  const setStatus = (s: string): void => {
    if (statusEl) statusEl.textContent = s;
  };

  const comp = new Competition(taskText);
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
  render(resultsEl, statusEl, comp.buildStatsTable(), comp.buildClimbData(), comp.buildMapData());
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
}

function makeSelection(allNames: string[], initial: string[]): Selection {
  const selected = new Set(initial);
  const subs: (() => void)[] = [];
  const notify = (): void => {
    for (const f of subs) f();
  };
  return {
    has: (n) => selected.has(n),
    all: () => [...allNames],
    selectedCount: () => selected.size,
    subscribe: (f) => {
      subs.push(f);
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

  if (table.completed.length || climb.completed.length) {
    resultsEl.appendChild(group('Completed Task', table, table.completed, true, climb.completed, sel));
  }
  if (mapData.turnpoints.length || mapData.tracks.length) {
    resultsEl.appendChild(mapSection(mapData, sel));
  }
  if (table.incomplete.length || climb.incomplete.length) {
    resultsEl.appendChild(group('Did Not Complete Task', table, table.incomplete, false, climb.incomplete, sel));
  }
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Build the "Task & Tracks" card and initialise the Leaflet map inside it. */
function mapSection(data: MapData, sel: Selection): HTMLElement {
  const card = document.createElement('section');
  card.className = 'card';
  const h = document.createElement('h2');
  h.textContent = 'Task & Tracks';
  const holder = document.createElement('div');
  holder.className = 'map-holder';
  card.append(h, holder);

  // Leaflet must initialise against an element already in the DOM with a size,
  // so defer until after this card is appended and laid out.
  queueMicrotask(() => initMap(holder, data, sel));
  return card;
}

interface TrackLayer {
  name: string;
  color: string;
  layer: L.Polyline;
}

function initMap(holder: HTMLElement, data: MapData, sel: Selection): void {
  const m = L.map(holder, { preferCanvas: true });
  map = m;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(m);

  const bounds = L.latLngBounds([]);

  // --- task geometry: cylinders + a dashed line through turnpoint centers ---
  const route: L.LatLngExpression[] = [];
  for (const tp of data.turnpoints) {
    const center: L.LatLngExpression = [tp.lat, tp.lon];
    route.push(center);
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
  if (route.length > 1) {
    L.polyline(route, { color: '#140c0c', weight: 1.5, dashArray: '6 6', opacity: 0.7 }).addTo(m);
  }

  // --- pilot tracks --------------------------------------------------------
  const trackLayers: TrackLayer[] = [];
  data.tracks.forEach((tr, i) => {
    const color = PALETTE[i % PALETTE.length];
    const layer = L.polyline(tr.points, { color, weight: 2, opacity: 0.85 });
    layer.bindTooltip(tr.pilot, { sticky: true });
    if (sel.has(tr.pilot)) layer.addTo(m);
    trackLayers.push({ name: tr.pilot, color, layer });
    for (const pt of tr.points) bounds.extend(pt);
  });

  if (bounds.isValid()) m.fitBounds(bounds, { padding: [30, 30] });
  m.invalidateSize();

  // Keep the map in sync when selection changes from the table. Pilot names are
  // not listed on the map (selection is driven by the table); hover a track to
  // see its pilot.
  sel.subscribe(() => {
    for (const t of trackLayers) {
      const on = sel.has(t.name);
      if (on && !m.hasLayer(t.layer)) t.layer.addTo(m);
      else if (!on && m.hasLayer(t.layer)) m.removeLayer(t.layer);
    }
  });
}

/** One self-contained section for a completion group: stats table + climb chart. */
function group(
  title: string,
  table: StatsTable,
  rows: StatsTable['completed'],
  gradient: boolean,
  series: ClimbSeries[],
  sel: Selection,
): HTMLElement {
  const card = document.createElement('section');
  card.className = 'card';
  const h = document.createElement('h2');
  h.textContent = title;
  card.append(h);

  if (rows.length) {
    const tbl = tableEl(table, rows, gradient, sel);
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
    const chart = makeChart(canvas, series, sel);

    const syncChart = (): void => {
      // Hide the whole plot when no pilot in this section is selected.
      const anyVisible = series.some((s) => sel.has(s.pilot));
      chartWrap.style.display = anyVisible ? '' : 'none';
      if (!anyVisible) return;
      chart.data.datasets.forEach((ds, i) =>
        chart.setDatasetVisibility(i, sel.has(ds.label as string)),
      );
      chart.update();
      chart.resize(); // recover canvas size if it was hidden
    };
    sel.subscribe(syncChart);
    syncChart();
    charts.push(chart);
  }

  return card;
}

function tableEl(
  table: StatsTable,
  rows: StatsTable['completed'],
  gradient: boolean,
  sel: Selection,
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

      const checkTd = document.createElement('td');
      checkTd.className = 'select-col';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = isSelected;
      check.addEventListener('change', () => sel.toggle(name));
      checkTd.appendChild(check);
      tr.appendChild(checkTd);

      row.forEach((cell, ci) => {
        const td = document.createElement('td');
        td.textContent = cell.text;
        if (ci === 0) td.className = 'name';
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
  }

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
type ChartWithAvg = Chart & { $avgLines?: AvgLine[]; $avgHover?: string | null };

const avgLinePlugin: Plugin<'line'> = {
  id: 'avgLines',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const c = chart as ChartWithAvg;
    const hover = c.$avgHover;
    const lines: AvgLine[] = [];

    chart.data.datasets.forEach((ds, i) => {
      if (!chart.isDatasetVisible(i)) return;
      const avg = (ds as ChartDataset & { avgClimbRate?: number }).avgClimbRate;
      if (avg === undefined || Number.isNaN(avg)) return;
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

function makeChart(canvas: HTMLCanvasElement, series: ClimbSeries[], sel: Selection): Chart {
  const datasets = series.map((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    return {
      label: s.pilot,
      data: s.values.map((y, x) => ({ x: x + 1, y })),
      borderColor: color,
      backgroundColor: color,
      avgClimbRate: s.avgClimbRate,
      hidden: !sel.has(s.pilot),
      tension: 0,
      pointRadius: 4,
      pointHoverRadius: 6,
    } as ChartDataset<'line'> & { avgClimbRate: number };
  });

  return new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
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
    plugins: [avgLinePlugin],
  });
}
