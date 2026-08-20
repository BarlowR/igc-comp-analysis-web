/**
 * The results stats tables: sortable per-group table with selection checkboxes,
 * gradient shading, the collapsed deselected-pilots section, and the time-loss
 * breakdown panel that opens under a pinned pilot. Plain DOM — no Leaflet, no
 * Chart.js.
 */
import {
  gradientColor,
  type StatsTable,
  type TimeLossData,
  type TimeLossRow,
} from '../lib/competition';
import { PALETTE, type Selection } from '../lib/replay';

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

export function tableEl(
  table: StatsTable,
  rows: StatsTable['completed'],
  gradient: boolean,
  sel: Selection,
  colors: Map<string, string>,
  timeLoss: TimeLossData,
  /** Extra content for the pinned pilot's breakdown panel; null for none. Read
   * live at highlight time so hooks installed before render still apply. */
  pinnedExtra: (pilot: string) => HTMLElement | null = () => null,
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
    if (!anchor) return;

    const loss = lossByPilot.get(pinned);
    const extra = pinnedExtra(pinned);

    let row: HTMLElement | null = null;
    if (loss && timeLoss.winner) {
      row = timeLossRow(loss, timeLoss.winner, table.headers.length + 1, timeLoss.contextScale, timeLoss.topCount);
    } else if (extra) {
      // No time-loss breakdown for this pilot (they don't appear in the
      // decomposition), but the hook still has something to show — a bare panel
      // keeps it reachable rather than silently dropping it.
      row = document.createElement('tr');
      row.className = 'time-loss';
      const td = document.createElement('td');
      td.colSpan = table.headers.length + 1;
      const panel = document.createElement('div');
      panel.className = 'tl-panel';
      td.appendChild(panel);
      row.appendChild(td);
    }
    if (!row) return;

    if (extra) row.querySelector('.tl-panel')?.appendChild(extra);
    anchor.after(row);
  };
  sel.onHighlight(applyHighlight);

  renderBody();
  t.append(thead, tbody);
  wrap.appendChild(t);
  return { el: wrap, rerender: renderBody };
}
