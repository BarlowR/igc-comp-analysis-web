/**
 * The 3D viewer's side docks — pilots on the left, notes on the right.
 *
 * Each dock drags wider or narrower by its map-facing edge and collapses to a
 * labelled rail, so the globe can have the whole window when you want it. Both
 * the width and the collapsed state persist per side, the way the chart dock's
 * height already does.
 *
 * The grid's column widths are CSS custom properties on .viewer3d, so a drag is
 * a single style write and the map column (1fr) absorbs whatever is left.
 */

const MIN_WIDTH = 200;
const MAX_WIDTH = 560;
/** Collapsed width — just enough for the toggle and a vertical label. */
const RAIL_WIDTH = 28;
/** Below this, two open docks leave no usable map, so both start collapsed. */
const NARROW_VIEWPORT = 900;

const DEFAULT_WIDTH = { left: 320, right: 320 } as const;

const viewerEl = (): HTMLElement | null => document.querySelector('.viewer3d');

/**
 * Tell the world the map column changed size.
 *
 * Cesium only re-reads its canvas size on a window resize, and changing a grid
 * column doesn't fire one. (The altitude plot needs no help — it has its own
 * ResizeObserver.)
 *
 * Coalesced to one event per animation frame, because a drag calls this on every
 * pointermove and each event is expensive twice over: Cesium reallocates its
 * WebGL buffers, and the altitude plot rebuilds a cached layer holding every
 * pilot's full profile. Firing per pointer event instead of per frame is enough
 * to lock the main thread up on a big day.
 *
 * `nudging` keeps our own synthetic event from re-entering the clamp listener
 * below and bouncing between the two docks.
 */
let nudging = false;
let nudgeQueued = false;
function nudge(): void {
  if (nudgeQueued) return;
  nudgeQueued = true;
  requestAnimationFrame(() => {
    nudgeQueued = false;
    nudging = true;
    window.dispatchEvent(new Event('resize'));
    nudging = false;
  });
}

type Side = 'left' | 'right';

function setupDock(side: Side, label: string): void {
  const viewer = viewerEl();
  const dock = document.getElementById(`dock${side === 'left' ? 'Left' : 'Right'}`);
  const toggle = dock?.querySelector<HTMLButtonElement>('.dock-toggle');
  const grip = dock?.querySelector<HTMLElement>('.dock-grip');
  if (!viewer || !dock || !toggle || !grip) return;

  const widthKey = `dock3d.${side}.width`;
  const collapsedKey = `dock3d.${side}.collapsed`;
  const ceiling = (): number => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth * 0.4));

  const storedWidth = Number(localStorage.getItem(widthKey));
  let width = Number.isFinite(storedWidth) && storedWidth >= MIN_WIDTH ? storedWidth : DEFAULT_WIDTH[side];
  const storedCollapsed = localStorage.getItem(collapsedKey);
  // No stored preference on a narrow window: start out of the way rather than
  // handing someone a sliver of globe between two docks.
  let collapsed = storedCollapsed === null ? window.innerWidth < NARROW_VIEWPORT : storedCollapsed === '1';
  // Arriving on a "N notes" link from the account page: open the dock it points
  // at, whatever was stored. Landing on a collapsed rail would look like the
  // notes had gone missing.
  if (side === 'right' && window.location.hash === '#notes') collapsed = false;

  const apply = (): void => {
    width = Math.max(MIN_WIDTH, Math.min(ceiling(), width));
    viewer.style.setProperty(`--dock-${side}`, `${collapsed ? RAIL_WIDTH : width}px`);
    dock.classList.toggle('collapsed', collapsed);
    // The chevron points the way the dock will move: inward to collapse,
    // outward to reopen.
    toggle.textContent = (side === 'left') !== collapsed ? '‹' : '›';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = `${collapsed ? 'Show' : 'Hide'} ${label}`;
    nudge();
  };

  let dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    if (collapsed) return;
    dragging = true;
    grip.setPointerCapture(e.pointerId);
    e.preventDefault(); // don't start a text selection across the panel
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const box = viewer.getBoundingClientRect();
    width = Math.round(side === 'left' ? e.clientX - box.left : box.right - e.clientX);
    apply();
  });
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    localStorage.setItem(widthKey, String(width));
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    localStorage.setItem(collapsedKey, collapsed ? '1' : '0');
    apply();
  });

  // Keep a wide dock from swallowing a shrinking window.
  window.addEventListener('resize', () => {
    if (nudging) return;
    if (width > ceiling()) apply();
  });

  apply();
}

/** Wire both docks. Safe to call once the viewer markup is in the document. */
export function mountDocks(): void {
  setupDock('left', 'the pilot list');
  setupDock('right', 'notes');
}

/**
 * Reveal the notes dock. It ships hidden with its column collapsed to zero, so a
 * build without accounts — or a signed-out visitor — gets the old two-column
 * layout rather than an empty panel.
 */
export function showNotesDock(): void {
  const dock = document.getElementById('dockRight');
  if (!dock) return;
  dock.removeAttribute('hidden');
  viewerEl()?.classList.remove('no-right');
  nudge();
}
