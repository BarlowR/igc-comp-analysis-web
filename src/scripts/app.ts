/**
 * Client island: read uploaded files, run the competition analysis entirely in
 * the browser, and render the stats table + climb-rate charts.
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

const $ = (id: string) => document.getElementById(id)!;

const taskInput = $('task-input') as HTMLInputElement;
const igcInput = $('igc-input') as HTMLInputElement;
const analyzeBtn = $('analyze-btn') as HTMLButtonElement;
const taskName = $('task-name');
const igcCount = $('igc-count');
const statusEl = $('status');
const results = $('results');

let charts: Chart[] = [];
let map: L.Map | null = null;

function refreshState(): void {
  taskName.textContent = taskInput.files?.[0]?.name ?? 'No task file selected';
  const n = igcInput.files?.length ?? 0;
  igcCount.textContent = n === 0 ? 'No IGC files selected' : `${n} IGC file${n === 1 ? '' : 's'} selected`;
  analyzeBtn.disabled = !(taskInput.files?.length && n);
}

taskInput.addEventListener('change', refreshState);
igcInput.addEventListener('change', refreshState);
analyzeBtn.addEventListener('click', () => void analyze());

/** Derive a readable fallback pilot name from an IGC filename. */
function nameFromFile(filename: string): string {
  return filename
    .replace(/\.igc$/i, '')
    .replace(/_\d{4}-\d{2}-\d{2}.*$/, '') // strip trailing date/id segment
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || filename;
}

async function analyze(): Promise<void> {
  const taskFile = taskInput.files?.[0];
  const igcFiles = Array.from(igcInput.files ?? []);
  if (!taskFile || igcFiles.length === 0) return;

  analyzeBtn.disabled = true;
  statusEl.textContent = 'Reading task…';

  try {
    const comp = new Competition(await taskFile.text());

    for (let i = 0; i < igcFiles.length; i++) {
      const f = igcFiles[i];
      statusEl.textContent = `Analyzing ${i + 1}/${igcFiles.length}: ${f.name}`;
      // Yield to the event loop so the status text repaints between files.
      await new Promise((r) => setTimeout(r, 0));
      try {
        comp.addPilot(await f.text(), nameFromFile(f.name));
      } catch (err) {
        console.error(`Failed to parse ${f.name}`, err);
      }
    }

    statusEl.textContent = `Loaded ${comp.pilots.length} pilot${comp.pilots.length === 1 ? '' : 's'}.`;
    render(comp.buildStatsTable(), comp.buildClimbData(), comp.buildMapData());
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${(err as Error).message}`;
  } finally {
    analyzeBtn.disabled = false;
  }
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

function makeSelection(allNames: string[]): Selection {
  const selected = new Set(allNames);
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

function render(table: StatsTable, climb: ClimbData, mapData: MapData): void {
  for (const c of charts) c.destroy();
  charts = [];
  if (map) {
    map.remove();
    map = null;
  }
  results.innerHTML = '';

  // One selection shared across the map, both tables, and both charts.
  const names = new Set<string>();
  for (const r of table.completed) names.add(r[0].text);
  for (const r of table.incomplete) names.add(r[0].text);
  for (const tr of mapData.tracks) names.add(tr.pilot);
  const sel = makeSelection([...names]);

  if (mapData.turnpoints.length || mapData.tracks.length) {
    results.appendChild(mapSection(mapData, sel));
  }

  if (table.completed.length || climb.completed.length) {
    results.appendChild(group('Completed Task', table, table.completed, true, climb.completed, sel));
  }
  if (table.incomplete.length || climb.incomplete.length) {
    results.appendChild(group('Did Not Complete Task', table, table.incomplete, false, climb.incomplete, sel));
  }
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  row?: HTMLElement;
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

  if (trackLayers.length) addMapLegend(m, trackLayers, sel);

  // Keep the map in sync when selection changes from the table or charts.
  sel.subscribe(() => {
    for (const t of trackLayers) {
      const on = sel.has(t.name);
      if (on && !m.hasLayer(t.layer)) t.layer.addTo(m);
      else if (!on && m.hasLayer(t.layer)) m.removeLayer(t.layer);
      t.row?.classList.toggle('off', !on);
    }
  });
}

/** A clickable legend control: toggle each pilot's track via the shared selection. */
function addMapLegend(m: L.Map, tracks: TrackLayer[], sel: Selection): void {
  const Legend = L.Control.extend({
    options: { position: 'topright' as L.ControlPosition },
    onAdd(): HTMLElement {
      const div = L.DomUtil.create('div', 'map-legend');
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      for (const t of tracks) {
        const row = L.DomUtil.create('div', 'map-legend-row', div);
        t.row = row;
        row.classList.toggle('off', !sel.has(t.name));
        const sw = L.DomUtil.create('span', 'map-legend-swatch', row);
        sw.style.background = t.color;
        const label = L.DomUtil.create('span', '', row);
        label.textContent = t.name;
        L.DomEvent.on(row, 'click', () => sel.toggle(t.name));
      }
      return div;
    },
  });
  new Legend().addTo(m);
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
    const h3 = document.createElement('h3');
    h3.textContent = 'Climb Rate Distribution';
    const holder = document.createElement('div');
    holder.className = 'chart-holder';
    const canvas = document.createElement('canvas');
    holder.appendChild(canvas);
    card.append(h3, holder);
    const chart = makeChart(canvas, series, sel);
    sel.subscribe(() => {
      chart.data.datasets.forEach((ds, i) =>
        chart.setDatasetVisibility(i, sel.has(ds.label as string)),
      );
      chart.update();
    });
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

    // Selected pilots are always grouped above unselected ones; the active
    // column sort (if any) orders within each group.
    const ordered = [...rows].sort((a, b) => {
      const sa = sel.has(a[0].text);
      const sb = sel.has(b[0].text);
      if (sa !== sb) return sa ? -1 : 1;
      return sortCol < 0 ? 0 : compare(a, b);
    });

    tbody.innerHTML = '';
    for (const row of ordered) {
      const name = row[0].text;
      const isSelected = sel.has(name);
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
      tbody.appendChild(tr);
    }
  }

  renderBody();
  t.append(thead, tbody);
  wrap.appendChild(t);
  return { el: wrap, rerender: renderBody };
}

// Plugin: draw a dashed vertical line at each visible pilot's average climb rate.
const avgLinePlugin = {
  id: 'avgLines',
  afterDatasetsDraw(chart: Chart) {
    const { ctx, chartArea, scales } = chart;
    chart.data.datasets.forEach((ds, i) => {
      if (!chart.isDatasetVisible(i)) return;
      const avg = (ds as ChartDataset & { avgClimbRate?: number }).avgClimbRate;
      if (avg === undefined || Number.isNaN(avg)) return;
      const x = scales.x.getPixelForValue(avg);
      if (x < chartArea.left || x > chartArea.right) return;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = ds.borderColor as string;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.5;
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    });
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

  // Track clicks per chart so we can distinguish a double-click on a legend
  // item (isolate that pilot) from a single click (default show/hide toggle).
  let lastClick = { index: -1, time: 0 };

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
        legend: {
          position: 'bottom',
          labels: {
            usePointStyle: true,
            boxWidth: 8,
            // Widen the gap between the color marker and the pilot name.
            generateLabels(chart) {
              const labels = Chart.defaults.plugins.legend.labels.generateLabels(chart);
              for (const l of labels) l.text = '   ' + l.text;
              return labels;
            },
          },
          onClick(_e, legendItem, legend) {
            const index = legendItem.datasetIndex;
            if (index === undefined) return;
            const name = legend.chart.data.datasets[index].label as string;
            const now = Date.now();
            const isDouble = index === lastClick.index && now - lastClick.time < 300;
            lastClick = { index, time: now };

            // Route through the shared selection so the table and map stay in
            // sync. Single click toggles this pilot; double click isolates it
            // (double-clicking an already-isolated pilot restores everyone).
            if (isDouble) sel.isolate(name);
            else sel.toggle(name);
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => CLIMB_RATE_TICKS[Number(items[0].parsed.x) - 1] ?? '',
            label: (item) => `${item.dataset.label}: ${item.parsed.y.toFixed(1)}%`,
          },
        },
      },
    },
    plugins: [avgLinePlugin],
  });
}

refreshState();
