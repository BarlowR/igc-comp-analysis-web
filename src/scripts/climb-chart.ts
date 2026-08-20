/**
 * The climb-rate distribution chart: all of the results page's Chart.js code —
 * registration, the custom plugins (grey background lines, average-climb
 * verticals, pinned-point rings), selection-driven styling, and the chart
 * registry the renderer destroys between runs. Only the 2D results page imports
 * this, so Chart.js stays out of every other bundle.
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
import { CLIMB_RATE_TICKS, type ClimbSeries } from '../lib/competition';
import { PALETTE, DESELECTED_GREY, type Selection } from '../lib/replay';

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Legend);

// Match the app's near-black text color for all chart text (ticks, titles, legend).
Chart.defaults.color = '#140c0c';

// Every chart built since the last destroyCharts(), so a re-render can tear the
// old ones down before Chart.js re-binds their canvases.
let charts: Chart[] = [];

export function destroyCharts(): void {
  for (const c of charts) c.destroy();
  charts = [];
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

/**
 * Build the "Climb Rate Distribution" block for one completion group: heading +
 * chart, wired to the shared selection (restyle on change, hide the whole block
 * when nobody in the group is selected, bold the cross-view highlight). The
 * chart is registered for destroyCharts().
 */
export function climbChartSection(
  series: ClimbSeries[],
  sel: Selection,
  colors: Map<string, string>,
): HTMLElement {
  const chartWrap = document.createElement('div');
  const h3 = document.createElement('h3');
  h3.textContent = 'Climb Rate Distribution';
  const holder = document.createElement('div');
  holder.className = 'chart-holder';
  const canvas = document.createElement('canvas');
  holder.appendChild(canvas);
  chartWrap.append(h3, holder);
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
  return chartWrap;
}
