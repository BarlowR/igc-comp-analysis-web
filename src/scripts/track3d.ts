/**
 * Prototype 3D tracklog viewer (Cesium).
 *
 * Reuses the exact selection model, pilot colours and the altitude-plot time
 * scrubber from the 2D results page (src/scripts/analysis.ts) so the two views
 * behave identically — top-20 selected by default, the rest greyed, and a
 * draggable/playable altitude slider along the bottom. The globe just replaces
 * the Leaflet map: each track is a polyline at its true altitude, and the shared
 * scrubber moves a marker along every pilot's flight.
 *
 * Token-free by default: OpenStreetMap imagery on the WGS84 ellipsoid (no
 * Cesium Ion contact). Pasting an Ion token opts into real world terrain.
 *
 * Cesium's static assets are served from /cesium (copied by
 * scripts/copy-cesium-assets.mjs); window.CESIUM_BASE_URL is set in 3d.astro.
 */
import * as Cesium from 'cesium';
import {
  buildPilotSelection,
  mountTimeline,
  positionAt,
  altAt,
  DESELECTED_GREY,
  type ArchivedResults,
  type Selection,
} from './analysis';
import type { MapTurnpoint, MapTrack } from '../lib/competition';
import { haversine } from '../lib/math';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/** Per-pilot Cesium handles + metadata for styling and the side panel. */
interface PilotEnt {
  pilot: string;
  color: string;
  track: MapTrack;
  /** Faint grey full-flight line (context). */
  line: Cesium.Entity;
  /** Coloured trail that grows to the scrub time (positions via CallbackProperty). */
  trail: Cesium.Entity;
  /** Precomputed Cartesian3 for every fix, aligned with track.points. */
  carts: Cesium.Cartesian3[];
  marker: Cesium.Entity;
}

async function main(): Promise<void> {
  // Cesium's widget CSS is loaded from the copied static assets rather than
  // through the bundler (Vite would try to resolve its url()s).
  ensureWidgetsCss();

  const loading = makeLoading();
  const statusEl = $('status3d');
  const dataEl = document.getElementById('archive-entry');
  if (!dataEl?.textContent) {
    loading.fail('No archive entry found.');
    return;
  }
  const entry = JSON.parse(dataEl.textContent) as { base: string };

  let data: ArchivedResults;
  try {
    loading.step('Loading flight data…');
    const res = await fetch(`${entry.base}.json`);
    if (!res.ok) throw new Error(`${res.status} fetching results`);
    data = (await res.json()) as ArchivedResults;
  } catch (err) {
    loading.fail(`Couldn't load flight data: ${(err as Error).message}`);
    return;
  }

  const mapData = data.map;
  const tracks = mapData.tracks.filter((t) => t.points.length > 1);
  if (tracks.length === 0) {
    loading.fail('No tracks to display for this task.');
    return;
  }

  // Same ordering / top-20 default / colours as the 2D page.
  const { ordered, sel, colors, truncated, topN } = buildPilotSelection(data.table, mapData);

  // Column height for turnpoint cylinders: a bit above the highest fix.
  let maxAlt = 0;
  for (const t of tracks) for (const a of t.alt) if (Number.isFinite(a) && a > maxAlt) maxAlt = a;
  const columnTop = Math.max(1500, maxAlt + 250);

  loading.step('Building the globe…');
  const viewer = createViewer();
  loading.step(`Placing ${tracks.length} tracks…`);
  const setTaskTerrainMode = drawTask(viewer, mapData.turnpoints, columnTop);

  // The current scrub time, kept in sync by the timeline's frame callback; the
  // trail CallbackProperty and the follow-cam both read it.
  let scrubMs = NaN;
  const ents = drawTracks(viewer, tracks, colors, () => scrubMs);
  const byPilot = new Map(ents.map((e) => [e.pilot, e]));
  // Set once the pilot list is built; refreshes its climb/speed cells per frame.
  let refreshStats: (t: number) => void = () => {};

  // Selection styling: faint grey context line for everyone; a colour trail that
  // only shows for selected pilots (its extent is time-driven, see trailPositions).
  const styleSelection = (): void => {
    const highlight = sel.highlight();
    const single = sel.selectedCount() === 1;
    for (const pe of ents) {
      const selected = sel.has(pe.pilot);
      const isH = pe.pilot === highlight;
      // Only selected pilots show a track (faint grey full route for context,
      // plus the colour trail below); unselected pilots' lines are hidden.
      pe.line.show = selected;
      pe.line.polyline!.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.fromCssColorString(DESELECTED_GREY).withAlpha(0.45),
      );
      pe.line.polyline!.width = new Cesium.ConstantProperty(isH ? 2 : 1);
      pe.trail.show = selected;
      pe.trail.polyline!.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.fromCssColorString(pe.color).withAlpha(isH ? 1 : 0.95),
      );
      pe.trail.polyline!.width = new Cesium.ConstantProperty(isH ? 5 : single ? 4 : 2.5);
    }
  };
  styleSelection();
  sel.subscribe(styleSelection);
  sel.onHighlight(styleSelection);

  // --- follow-cam (position spring, orbit-able) ----------------------------
  // The camera keeps a fixed offset within a moving reference frame (via
  // lookAtTransform) so free orbit/zoom stays alive; the frame's origin — the
  // "anchor" the camera looks at — position-springs toward the pilot instead of
  // snapping, so the rig eases along behind them. On entry it snaps once behind
  // the travel direction; each later frame re-reads the user's offset within the
  // frame and re-applies it against the sprung anchor.
  const DIST_BACK = 2400; // chase distance behind + above the pilot on entry (m)
  const PITCH = -0.35; // downward look angle on entry (rad)
  const POS_STIFFNESS = 3; // anchor spring rate — higher settles faster
  let followPilot: string | null = null;
  let enteringFollow = false; // next frame should snap behind the pilot
  let anchor: Cesium.Cartesian3 | null = null; // sprung look target / frame origin
  let lastNow = 0;

  const followFrame = (): void => {
    if (!followPilot) {
      lastNow = 0;
      return;
    }
    const pe = byPilot.get(followPilot);
    if (!pe) return;
    const { times } = pe.track;
    // Clamp into the pilot's own window so there's always a target, even when
    // the scrub sits before their launch or after they land.
    const ct = Math.min(times[times.length - 1], Math.max(times[0], scrubMs));
    const pos = positionAt(pe.track, ct);
    const a = altAt(pe.track, ct);
    if (!pos || a == null) return;
    const pilotPos = Cesium.Cartesian3.fromDegrees(pos[1], pos[0], a);

    if (enteringFollow) {
      // Fresh entry from a released camera: snap the anchor onto the pilot and
      // sit behind their travel bearing.
      anchor = pilotPos.clone();
      const pt = Math.max(times[0], ct - 4000);
      const prev = positionAt(pe.track, pt) ?? pos;
      // Heading of travel (0 = due north, +clockwise); +π puts the camera behind.
      const bearing = Math.atan2(pos[1] - prev[1], pos[0] - prev[0]);
      viewer.camera.lookAtTransform(
        Cesium.Transforms.eastNorthUpToFixedFrame(anchor),
        new Cesium.HeadingPitchRange(bearing + Math.PI, PITCH, DIST_BACK),
      );
      enteringFollow = false;
      lastNow = performance.now();
      return;
    }

    // Spring the anchor toward the pilot's current position (frame-rate
    // independent lerp) so the look target eases along instead of snapping.
    const now = performance.now();
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    if (!anchor) anchor = pilotPos.clone();
    else if (dt > 0) {
      Cesium.Cartesian3.lerp(anchor, pilotPos, 1 - Math.exp(-POS_STIFFNESS * dt), anchor);
    }

    // Re-read the offset the user's orbit/zoom left within the frame, then
    // re-apply it against the sprung anchor's frame so the camera follows while
    // keeping the viewing angle. (lookAtTransform with no offset would NOT
    // translate — it only reinterprets the frame, leaving the camera put.)
    const offset = viewer.camera.position.clone();
    viewer.camera.lookAtTransform(Cesium.Transforms.eastNorthUpToFixedFrame(anchor), offset);
  };
  viewer.scene.preRender.addEventListener(followFrame);

  // Per-frame update, run by the shared scrubber on every scrub/playback tick
  // and on selection changes: move each pilot marker, then the follow-cam.
  const frame = (t: number): void => {
    scrubMs = t;
    const highlight = sel.highlight();
    const single = sel.selectedCount() === 1;
    for (const pe of ents) {
      const pos = positionAt(pe.track, t);
      const a = altAt(pe.track, t);
      if (!pos || a == null) {
        pe.marker.show = false;
        continue;
      }
      pe.marker.show = true;
      pe.marker.position = new Cesium.ConstantPositionProperty(
        Cesium.Cartesian3.fromDegrees(pos[1], pos[0], a),
      );
      const selected = sel.has(pe.pilot);
      const isH = pe.pilot === highlight;
      const pt = pe.marker.point!;
      if (selected) {
        pt.color = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString(pe.color));
        pt.pixelSize = new Cesium.ConstantProperty(isH ? 14 : single ? 12 : 9);
        pt.outlineColor = new Cesium.ConstantProperty(Cesium.Color.WHITE);
        pt.outlineWidth = new Cesium.ConstantProperty(1.5);
      } else {
        pt.color = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString(DESELECTED_GREY).withAlpha(0.6));
        pt.pixelSize = new Cesium.ConstantProperty(6);
        pt.outlineWidth = new Cesium.ConstantProperty(0);
      }
      // Only the pinned pilot gets a floating name label (avoids 20-label clutter).
      pe.marker.label!.show = new Cesium.ConstantProperty(isH);
    }
    refreshStats(t);
  };

  refreshStats = buildPilotList(ents, ordered, sel, colors);
  wirePinPicking(viewer, ents, sel);

  // The pinned pilot (cross-view highlight) is the one the camera follows —
  // pin a pilot (check their box + click their name, or click their track) to
  // chase them; unpin to release the camera.
  const setFollow = (p: string | null): void => {
    const wasFollowing = followPilot !== null;
    followPilot = p;
    if (!p) {
      // Release: hand the camera back to free navigation where it currently is.
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      anchor = null;
      lastNow = 0;
      return;
    }
    // Snap behind the pilot only on a fresh entry from a released camera.
    // Switching pilots keeps the sprung anchor so the view glides across to the
    // new pilot at the same viewing angle instead of re-snapping.
    if (!wasFollowing) enteringFollow = true;
  };
  sel.onHighlight(() => setFollow(sel.highlight()));

  // The shared altitude-plot scrubber, mounted into the bottom overlay. Play
  // sweeps the day in ~2.5 min (much slower than the 2D page's ~30s) so the 3D
  // flythrough is watchable.
  mountTimeline($('timeAnchor'), mapData, sel, colors, frame, 150_000);

  // Reveal the globe once it has actually painted a frame.
  loading.step('Rendering…');
  const off = viewer.scene.postRender.addEventListener(() => {
    off();
    loading.done();
  });

  viewer.flyTo(viewer.entities, { duration: 1.5 });
  wireTerrain(viewer, statusEl, () => setTaskTerrainMode(true));

  const field = truncated ? `Top ${topN} of ${ordered.length} pilots` : `${ordered.length} pilots`;
  statusEl.textContent = `${field} — check to show, click a name to pin + follow. Drag the altitude plot or press ▶.`;
}

// ---- viewer ---------------------------------------------------------------

function createViewer(): Cesium.Viewer {
  // Our own OSM baseLayer keeps Cesium from reaching for its default Ion Bing
  // imagery, so no access token is needed to start. We drive time from the
  // shared scrubber, so Cesium's own animation + timeline widgets are off.
  const viewer = new Cesium.Viewer('cesiumContainer', {
    baseLayer: new Cesium.ImageryLayer(
      new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
    ),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    animation: false,
    timeline: false,
  });
  viewer.scene.globe.depthTestAgainstTerrain = true;
  (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none';
  return viewer;
}

// ---- task geometry --------------------------------------------------------

function tpColor(type: string | null): Cesium.Color {
  const css = type === 'SSS' ? '#2e7d32' : type === 'ESS' ? '#c62828' : '#705a90';
  return Cesium.Color.fromCssColorString(css);
}

// Column fill/rim alpha: bumped up once terrain is on, where the busier
// satellite + relief backdrop otherwise swallows the faint columns.
const CYL_FILL_FLAT = 0.1;
const CYL_FILL_TERRAIN = 0.28;
const CYL_LINE_FLAT = 0.55;
const CYL_LINE_TERRAIN = 0.85;
const RING_SLICES = 72; // segments around the turnpoint circle
const CYL_FADE_BAND = 700; // m: a column fades to invisible over this band as the camera nears its wall

/** Ring of world positions around a turnpoint centre at `height` (m above ellipsoid). */
function turnpointRing(lon: number, lat: number, radius: number, height: number): Cesium.Cartesian3[] {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, 0));
  const ring: Cesium.Cartesian3[] = [];
  for (let i = 0; i <= RING_SLICES; i++) {
    const th = (i / RING_SLICES) * Cesium.Math.TWO_PI;
    const local = new Cesium.Cartesian3(Math.cos(th) * radius, Math.sin(th) * radius, height);
    ring.push(Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3()));
  }
  return ring;
}

/**
 * Draw the turnpoint columns, course line and labels. Returns a
 * `setTerrainMode(on)` that bumps the base column opacity when terrain is enabled.
 *
 * Each column is a `wall` (vertical ribbon around the turnpoint circle, no top
 * or bottom cap) plus crisp top + bottom rim polylines — so the scoring cylinder
 * reads as an open tube rather than a capped, disc-topped solid.
 *
 * Every column also **fades out as the camera approaches its wall** (per-frame
 * `fade` factor driven by the horizontal camera→axis distance), so flying the
 * follow-cam through a turnpoint tube doesn't wash the whole view with
 * translucent colour. Alpha = base (terrain-aware) × fade, applied via
 * `CallbackProperty` materials so both inputs update live without re-assigning.
 */
function drawTask(
  viewer: Cesium.Viewer,
  turnpoints: MapTurnpoint[],
  columnTop: number,
): (terrain: boolean) => void {
  const ellipsoid = viewer.scene.globe.ellipsoid;
  let baseFill = CYL_FILL_FLAT;
  let baseLine = CYL_LINE_FLAT;

  interface Column {
    color: Cesium.Color;
    lat: number;
    lon: number;
    radius: number;
    fade: number; // 0 (camera inside the tube) → 1 (clear of it); set each preRender
    fillScratch: Cesium.Color; // reused so the callbacks don't allocate per frame
    lineScratch: Cesium.Color;
  }
  const columns: Column[] = [];

  for (const tp of turnpoints) {
    const color = tpColor(tp.type);
    const col: Column = {
      color,
      lat: tp.lat,
      lon: tp.lon,
      radius: tp.radius,
      fade: 1,
      fillScratch: color.clone(),
      lineScratch: color.clone(),
    };
    const base = turnpointRing(tp.lon, tp.lat, tp.radius, 0);
    viewer.entities.add({
      wall: {
        positions: base,
        maximumHeights: new Array(base.length).fill(columnTop),
        minimumHeights: new Array(base.length).fill(0),
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(
            () => Cesium.Color.fromAlpha(color, baseFill * col.fade, col.fillScratch),
            false,
          ),
        ),
      },
    });
    // Crisp top + bottom rim circles (the wall itself carries no outline).
    for (const h of [0, columnTop]) {
      viewer.entities.add({
        polyline: {
          positions: turnpointRing(tp.lon, tp.lat, tp.radius, h),
          width: 1.5,
          arcType: Cesium.ArcType.NONE,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(
              () => Cesium.Color.fromAlpha(color, baseLine * col.fade, col.lineScratch),
              false,
            ),
          ),
        },
      });
    }
    columns.push(col);
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(tp.lon, tp.lat, columnTop),
      label: {
        text: tp.name,
        font: '500 13px Roboto, sans-serif',
        fillColor: color,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        scaleByDistance: new Cesium.NearFarScalar(1e3, 1.0, 5e5, 0.4),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  // Dashed course line joining the turnpoint centres near the ground.
  if (turnpoints.length > 1) {
    const positions = turnpoints
      .slice()
      .sort((a, b) => a.order - b.order)
      .flatMap((tp) => [tp.lon, tp.lat, 25]);
    viewer.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
        width: 2,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#140c0c').withAlpha(0.6),
          dashLength: 12,
        }),
      },
    });
  }

  // Each frame, set every column's fade from the horizontal distance between the
  // camera and the column axis: fully clear (1) once the camera is CYL_FADE_BAND
  // beyond the wall, ramping to 0 at the wall so the tube can't blind the view.
  const camCarto = new Cesium.Cartographic();
  viewer.scene.preRender.addEventListener(() => {
    const c = ellipsoid.cartesianToCartographic(viewer.camera.positionWC, camCarto);
    if (!c) return;
    const camLat = Cesium.Math.toDegrees(c.latitude);
    const camLon = Cesium.Math.toDegrees(c.longitude);
    for (const col of columns) {
      const horiz = haversine(camLat, camLon, col.lat, col.lon);
      col.fade = Math.min(1, Math.max(0, (horiz - col.radius) / CYL_FADE_BAND));
    }
  });

  // Terrain toggle just swaps the base alpha; the CallbackProperty materials
  // (base × fade) pick it up on the next render.
  return (terrain: boolean): void => {
    baseFill = terrain ? CYL_FILL_TERRAIN : CYL_FILL_FLAT;
    baseLine = terrain ? CYL_LINE_TERRAIN : CYL_LINE_FLAT;
  };
}

// ---- pilot tracks ---------------------------------------------------------

function drawTracks(
  viewer: Cesium.Viewer,
  tracks: MapTrack[],
  colors: Map<string, string>,
  getScrubMs: () => number,
): PilotEnt[] {
  return tracks.map((tr) => {
    const color = colors.get(tr.pilot) ?? DESELECTED_GREY;

    // Precompute a Cartesian3 per fix (lon, lat, alt) so the growing trail is a
    // cheap array slice each frame rather than a re-projection.
    const carts: Cesium.Cartesian3[] = [];
    for (let k = 0; k < tr.points.length; k++) {
      const [lat, lon] = tr.points[k];
      const alt = tr.alt[k];
      carts.push(
        Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(alt)
          ? Cesium.Cartesian3.fromDegrees(lon, lat, alt)
          : Cesium.Cartesian3.fromDegrees(lon || 0, lat || 0, 0),
      );
    }

    // Faint grey full-flight line for context (where they've been / will go).
    // arcType NONE keeps it as straight segments between fixes — no geodesic
    // densification, which matters for the per-frame trail below.
    const line = viewer.entities.add({
      name: tr.pilot,
      polyline: {
        positions: carts,
        width: 1,
        arcType: Cesium.ArcType.NONE,
        material: Cesium.Color.fromCssColorString(DESELECTED_GREY).withAlpha(0.3),
      },
    });

    const pe: PilotEnt = { pilot: tr.pilot, color, track: tr, line, carts, trail: null!, marker: null! };

    // Coloured trail: positions are the flown-so-far slice, up to the scrub time.
    pe.trail = viewer.entities.add({
      name: tr.pilot,
      show: false,
      polyline: {
        positions: new Cesium.CallbackProperty(() => trailPositions(pe, getScrubMs()), false),
        width: 3,
        arcType: Cesium.ArcType.NONE,
        material: Cesium.Color.fromCssColorString(color),
      },
    });

    // A marker whose position/style the shared scrubber updates each frame.
    pe.marker = viewer.entities.add({
      name: tr.pilot,
      // Hidden until the scrubber's first frame gives it a position (avoids
      // "entity has a point but no position" warnings on the initial render).
      show: false,
      point: {
        pixelSize: 9,
        color: Cesium.Color.fromCssColorString(color),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1.5,
      },
      label: {
        text: tr.pilot,
        show: false,
        font: '400 12px Roboto, sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -12),
        scale: 0.85,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    return pe;
  });
}

/**
 * The flown-so-far positions for a pilot's trail: every fix up to `t` plus the
 * interpolated point at exactly `t`. Empty before the pilot's first fix.
 */
function trailPositions(pe: PilotEnt, t: number): Cesium.Cartesian3[] {
  const { times } = pe.track;
  const n = times.length;
  if (n === 0 || !Number.isFinite(t) || t < times[0]) return [];
  // Number of fixes at or before t (binary search).
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const out = pe.carts.slice(0, lo + 1);
  if (t < times[n - 1]) {
    const pos = positionAt(pe.track, t);
    const a = altAt(pe.track, t);
    if (pos && a != null) out.push(Cesium.Cartesian3.fromDegrees(pos[1], pos[0], a));
  }
  return out;
}

// ---- side panel: pilot list ----------------------------------------------

// Window over which the instantaneous climb rate + ground speed are measured;
// the tracks are downsampled, so a few-second window smooths the read.
const STAT_WINDOW_MS = 20_000;

/** Ground speed (km/h) at scrub time `t`, over the trailing STAT_WINDOW. NaN out of range. */
function speedKmhAt(tr: MapTrack, t: number): number {
  const t0 = Math.max(tr.times[0], t - STAT_WINDOW_MS);
  const a = positionAt(tr, t);
  const b = positionAt(tr, t0);
  if (!a || !b) return NaN;
  const dt = (t - t0) / 1000;
  return dt > 0 ? (haversine(a[0], a[1], b[0], b[1]) / dt) * 3.6 : NaN;
}

/** Vertical speed (m/s) at scrub time `t`, over the trailing STAT_WINDOW. NaN out of range. */
function climbMsAt(tr: MapTrack, t: number): number {
  const t0 = Math.max(tr.times[0], t - STAT_WINDOW_MS);
  const a = altAt(tr, t);
  const b = altAt(tr, t0);
  if (a == null || b == null) return NaN;
  const dt = (t - t0) / 1000;
  return dt > 0 ? (a - b) / dt : NaN;
}

/**
 * Build the pilot selector, styled like the 2D results table: a colour-keyed
 * checkbox selects/deselects, clicking the name pins the pilot (which the
 * camera then follows), and each row shows the climb rate + ground speed at the
 * current scrub position. Returns a `refresh(t)` to update those live values.
 */
function buildPilotList(
  ents: PilotEnt[],
  ordered: string[],
  sel: Selection,
  colors: Map<string, string>,
): (t: number) => void {
  const list = $('pilotList') as HTMLUListElement;
  const byPilot = new Map(ents.map((e) => [e.pilot, e]));
  const fmt = (v: number, dp: number): string => (Number.isFinite(v) ? v.toFixed(dp) : '—');

  const head = document.createElement('li');
  head.className = 'head';
  head.innerHTML =
    '<span></span><span></span><span>Pilot</span><span class="stat">m</span><span class="stat">m/s</span><span class="stat">km/h</span>';
  list.appendChild(head);

  // Leaderboard order; only pilots that actually have a track drawn.
  const rows: {
    pilot: string;
    track: MapTrack;
    li: HTMLLIElement;
    check: HTMLInputElement;
    alt: HTMLSpanElement;
    climb: HTMLSpanElement;
    spd: HTMLSpanElement;
  }[] = [];
  ordered.forEach((pilot, i) => {
    const pe = byPilot.get(pilot);
    if (!pe) return;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'sel-check';
    check.style.accentColor = colors.get(pilot) ?? DESELECTED_GREY; // colour key
    check.addEventListener('change', () => sel.toggle(pilot));

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(i + 1);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = pilot;
    nm.title = 'Click to pin + follow';
    nm.addEventListener('click', () => {
      // Make sure the pilot we're about to pin + follow is actually visible.
      if (sel.highlight() !== pilot && !sel.has(pilot)) sel.setMany([pilot], true);
      sel.togglePin(pilot);
    });

    const alt = document.createElement('span');
    alt.className = 'stat';
    alt.textContent = '—';
    const climb = document.createElement('span');
    climb.className = 'stat';
    climb.textContent = '—';
    const spd = document.createElement('span');
    spd.className = 'stat';
    spd.textContent = '—';

    const li = document.createElement('li');
    li.append(rank, check, nm, alt, climb, spd);
    list.appendChild(li);
    rows.push({ pilot, track: pe.track, li, check, alt, climb, spd });
  });

  const sync = (): void => {
    for (const r of rows) {
      const selected = sel.has(r.pilot);
      r.check.checked = selected;
      r.li.classList.toggle('off', !selected);
    }
  };
  const syncPin = (): void => {
    const h = sel.highlight();
    for (const r of rows) r.li.classList.toggle('pinned', r.pilot === h);
  };
  sync();
  syncPin();
  sel.subscribe(sync);
  sel.onHighlight(syncPin);

  $('showAll').addEventListener('click', () => sel.setMany(rows.map((r) => r.pilot), true));
  $('hideAll').addEventListener('click', () => sel.setMany(rows.map((r) => r.pilot), false));

  // Live altitude/climb/speed at the current scrub time.
  return (t: number): void => {
    for (const r of rows) {
      r.alt.textContent = fmt(altAt(r.track, t) ?? NaN, 0);
      r.climb.textContent = fmt(climbMsAt(r.track, t), 1);
      r.spd.textContent = fmt(speedKmhAt(r.track, t), 0);
    }
  };
}

/** Click a track or marker on the globe to pin/unpin its cross-view highlight. */
function wirePinPicking(viewer: Cesium.Viewer, ents: PilotEnt[], sel: Selection): void {
  const entToPilot = new Map<Cesium.Entity, string>();
  for (const pe of ents) {
    entToPilot.set(pe.line, pe.pilot);
    entToPilot.set(pe.marker, pe.pilot);
  }
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
    const picked = viewer.scene.pick(movement.position);
    const pilot = picked?.id && entToPilot.get(picked.id as Cesium.Entity);
    if (pilot && sel.has(pilot)) sel.togglePin(pilot);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

// ---- optional Cesium Ion (satellite imagery + world terrain) --------------

/**
 * With a Cesium Ion token, upgrade the globe to Ion's satellite imagery (Bing
 * aerial) and world terrain — both on by default once a token is present.
 *
 * `persist` is set only for a token the user typed themselves, so it's reapplied
 * on their next visit. The build-time embedded token (see wireTerrain) is passed
 * with `persist:false` — it must NOT be copied into every visitor's localStorage,
 * or a later token rotation couldn't take effect for them.
 */
async function enableIon(
  viewer: Cesium.Viewer,
  token: string,
  statusEl: HTMLElement,
  onTerrain: () => void,
  persist: boolean,
): Promise<void> {
  try {
    Cesium.Ion.defaultAccessToken = token;
    // Satellite imagery: swap the OSM base layer for Ion world imagery.
    const layers = viewer.scene.imageryLayers;
    layers.removeAll();
    layers.add(Cesium.ImageryLayer.fromWorldImagery({}));
    // World terrain.
    viewer.scene.setTerrain(new Cesium.Terrain(Cesium.createWorldTerrainAsync()));
    onTerrain(); // bump the turnpoint columns to their terrain opacity
    if (persist) localStorage.setItem('cesiumIonToken', token);
    statusEl.textContent = 'Cesium Ion: satellite imagery + world terrain enabled.';
  } catch (err) {
    statusEl.textContent = `Cesium Ion failed: ${(err as Error).message}`;
  }
}

function wireTerrain(viewer: Cesium.Viewer, statusEl: HTMLElement, onTerrain: () => void): void {
  const input = $('ionToken') as HTMLInputElement;
  // Precedence: a token the user pasted (localStorage) overrides the token baked
  // in at build time via PUBLIC_CESIUM_ION_TOKEN (set in the Render dashboard).
  const saved = localStorage.getItem('cesiumIonToken');
  const embedded = import.meta.env.PUBLIC_CESIUM_ION_TOKEN;
  if (saved) {
    input.value = saved; // only reflect the user's own token in the box
    void enableIon(viewer, saved, statusEl, onTerrain, true);
  } else if (embedded) {
    void enableIon(viewer, embedded, statusEl, onTerrain, false);
  }
  $('applyTerrain').addEventListener('click', () => {
    const token = input.value.trim();
    if (token) void enableIon(viewer, token, statusEl, onTerrain, true);
  });
}

// ---- helpers --------------------------------------------------------------

/** Controls the full-screen loading overlay: advance its step, dismiss it, or
 * park it on an error message. */
function makeLoading(): { step: (m: string) => void; done: () => void; fail: (m: string) => void } {
  const el = document.getElementById('loading3d');
  const stepEl = document.getElementById('loading3d-step');
  const setStep = (m: string): void => {
    if (stepEl) stepEl.textContent = m;
  };
  return {
    step: setStep,
    done() {
      el?.classList.add('hidden');
      window.setTimeout(() => el?.remove(), 700);
    },
    fail(m: string) {
      el?.classList.add('error');
      setStep(m);
    },
  };
}

function ensureWidgetsCss(): void {
  if (document.querySelector('link[data-cesium-widgets]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/cesium/Widgets/widgets.css';
  l.dataset.cesiumWidgets = '1';
  document.head.appendChild(l);
}

void main();
