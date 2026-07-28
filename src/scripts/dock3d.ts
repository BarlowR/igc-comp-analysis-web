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
 *
 * On a phone that column model breaks down: a dock wide enough to read costs
 * more than the map can spare, and one narrow enough to leave a map has no room
 * for a pilot's name. So below COMPACT_VIEWPORT the docks stop being columns
 * altogether and become drawers up from the bottom of the map — full width, one
 * at a time, closing to a tab in a bottom corner. The columns go to zero and the
 * stylesheet moves both docks into the map cell.
 */

const MIN_WIDTH = 200;
const MAX_WIDTH = 560;
/** Collapsed width — just enough for the toggle and a vertical label. */
const RAIL_WIDTH = 28;
/** Below this, two open docks leave no usable map, so both start collapsed. */
const NARROW_VIEWPORT = 900;
/** Below this, an open dock overlays the map instead of taking a column. */
const COMPACT_VIEWPORT = 700;

const DEFAULT_WIDTH = { left: 320, right: 320 } as const;

const isCompact = (): boolean => window.innerWidth <= COMPACT_VIEWPORT;

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

/** Live handles onto the mounted docks, so each can drive the other. */
interface DockHandle {
  isOpen(): boolean;
  /** Close without recording it — a phone-only nudge, not a preference. */
  close(): void;
  /** Re-run the layout, e.g. after the notes dock is revealed. */
  refresh(): void;
}
const docks = new Map<Side, DockHandle>();

const dockEl = (side: Side): HTMLElement | null =>
  document.getElementById(`dock${side === 'left' ? 'Left' : 'Right'}`);

/**
 * Keep the map and the altitude plot in step while a dock animates.
 *
 * Opening a dock now takes ~220ms of CSS transition rather than one layout, and
 * neither Cesium nor the plot watches a grid column — so pump a resize per frame
 * for the length of it. This is the same per-frame cost a width drag already
 * pays (nudge() coalesces to one event per frame), just for a fifth of a second.
 */
const TRANSITION_MS = 260;
function pumpWhileAnimating(): void {
  const started = performance.now();
  const step = (now: number): void => {
    nudge();
    if (now - started < TRANSITION_MS) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function setupDock(side: Side, label: string): void {
  const viewer = viewerEl();
  const dock = dockEl(side);
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
    // `width` is the preference and survives; what a narrow window can actually
    // spare is worked out fresh each time. Folding the ceiling back into the
    // preference would mean a phone visit permanently shrank the desktop dock.
    const shown = Math.max(MIN_WIDTH, Math.min(ceiling(), width));
    // Compact: the column collapses to nothing, because the dock has left it —
    // the stylesheet puts it in the map cell as a bottom drawer. The class is
    // what that keys off.
    const compact = isCompact();
    viewer.classList.toggle('compact', compact);
    const column = compact ? 0 : collapsed ? RAIL_WIDTH : shown;
    viewer.style.setProperty(`--dock-${side}`, `${column}px`);
    dock.classList.toggle('collapsed', collapsed);
    // The chevron points the way the dock will move: up out of the bottom edge
    // on a phone, in or out of its column otherwise.
    toggle.textContent = compact ? (collapsed ? '▴' : '▾') : (side === 'left') !== collapsed ? '‹' : '›';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = `${collapsed ? 'Show' : 'Hide'} ${label}`;
    nudge();
  };

  let dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    if (collapsed) return;
    dragging = true;
    viewer.classList.add('dock-dragging'); // the width should track the pointer
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
    viewer.classList.remove('dock-dragging');
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    // Store what the drag could actually reach, not where the pointer ended up.
    localStorage.setItem(widthKey, String(Math.max(MIN_WIDTH, Math.min(ceiling(), width))));
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  const setCollapsed = (next: boolean, remember: boolean): void => {
    collapsed = next;
    if (remember) localStorage.setItem(collapsedKey, collapsed ? '1' : '0');
    apply();
    pumpWhileAnimating();
    // Two sheets can't share a phone screen, so opening one closes the other.
    // Not remembered: it's the screen's doing, not the reader's.
    if (!collapsed && isCompact()) {
      for (const [other, handle] of docks) if (other !== side) handle.close();
    }
  };

  docks.set(side, {
    isOpen: () => !collapsed,
    close: () => setCollapsed(true, false),
    refresh: apply,
  });

  toggle.addEventListener('click', () => setCollapsed(!collapsed, true));

  // A closed dock is a tab (or a rail), so the whole of it opens rather than
  // only the chevron inside it. Anything with its own handler is left alone.
  // On a phone the open tab shuts the same way: the whole tab is the control,
  // in both directions — but only the tab, never the drawer hanging off it,
  // where every click is meant for what's inside.
  dock.addEventListener('click', (e) => {
    const target = e.target as Element;
    if (target.closest('button, a')) return;
    if (!collapsed) {
      if (!isCompact() || target.closest('.dock-body')) return;
    }
    setCollapsed(!collapsed, true);
  });

  // Keep a wide dock from swallowing a shrinking window, and re-lay-out when a
  // rotation or a resize crosses the compact breakpoint.
  let compactNow = isCompact();
  window.addEventListener('resize', () => {
    if (nudging) return;
    const compact = isCompact();
    if (width > ceiling() || compact !== compactNow) {
      compactNow = compact;
      apply();
    }
  });

  apply();
}

/** Wire both docks. Safe to call once the viewer markup is in the document. */
export function mountDocks(): void {
  setupDock('left', 'the pilot list');
  setupDock('right', 'notes');

  // A phone opens on the map: both sheets shut, whatever a wider screen left
  // stored. The one exception is arriving on a "N notes" link, which is a
  // request to see the notes — landing on a rail would read as losing them.
  if (isCompact()) {
    const keep = window.location.hash === '#notes' ? 'right' : null;
    for (const [side, handle] of docks) if (side !== keep) handle.close();
  }
}

/**
 * Reveal the notes dock. It ships hidden with its column collapsed to zero, so a
 * build without accounts — or a signed-out visitor — gets a plain two-column
 * layout (pilots + globe) rather than an empty panel.
 */
export function showNotesDock(): void {
  const dock = document.getElementById('dockRight');
  if (!dock) return;
  dock.removeAttribute('hidden');
  viewerEl()?.classList.remove('no-right');
  // The pilot drawer's crossing to the notes drawer only makes sense from here.
  for (const handle of docks.values()) handle.refresh();
  nudge();
}
