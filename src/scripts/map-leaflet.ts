/**
 * The 2D "Task & Tracks" card: the Leaflet map with task cylinders, the
 * optimized route line, per-pilot track lines, and the scrubber's per-frame
 * trails + position dots. The only module that imports Leaflet, so it stays out
 * of every other page's bundle.
 */
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapData, MapTrack } from '../lib/competition';
import {
  PALETTE,
  DESELECTED_GREY,
  mountTimeline,
  positionAt,
  trailUpTo,
  renderStyle,
  type Selection,
} from '../lib/replay';

let map: L.Map | null = null;

/** Tear down the current map (if any) so a re-render can build a fresh one. */
export function destroyMap(): void {
  if (map) {
    map.remove();
    map = null;
  }
}

/** Build the "Task & Tracks" card and initialise the Leaflet map inside it. */
export function mapSection(
  data: MapData,
  sel: Selection,
  colors: Map<string, string>,
  threeDUrl?: string,
): HTMLElement {
  const card = document.createElement('section');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'map-head';
  const h = document.createElement('h2');
  // No turnpoints (a free-flight day): there is no task on this map to name.
  h.textContent = data.turnpoints.length ? 'Task & Tracks' : 'Tracks';
  head.appendChild(h);
  if (threeDUrl) {
    const link = document.createElement('a');
    link.className = 'map-3d-link';
    link.href = threeDUrl;
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '◈';
    const arrow = document.createElement('span');
    arrow.className = 'map-3d-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    link.append(icon, document.createTextNode(' View in 3D '), arrow);
    head.appendChild(link);
  }
  const holder = document.createElement('div');
  holder.className = 'map-holder';
  card.append(head, holder);

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
  // Shipped in the payload (buildMapData computes it once, SSS onward), so the
  // drawn line is the build's rather than a client re-derivation. Absent only
  // in a pre-version-2 saved cache — no line there until a recompute.
  const route = data.route ?? [];
  if (route.length > 1) {
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

  // The scrubber's per-frame drawing on *this* map: coloured trails + moving
  // position dots. The generic timeline scaffolding (bar, altitude plot,
  // playback) lives in mountTimeline, shared with the 3D viewer.
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

  /** Track points from launch up to epoch-ms `t`, ending at the interpolated dot. */
  const pointsUpTo = (tr: MapTrack, t: number): [number, number][] =>
    trailUpTo(tr.times, t, (i) => tr.points[i], (tt) => positionAt(tr, tt));

  const leafletFrame = (t: number): void => {
    const single = sel.selectedCount() === 1;
    const highlight = sel.highlight();

    // Pass 1: coloured trails (selected pilots), so the dots can sit above them.
    for (const tr of data.tracks) {
      const isH = tr.pilot === highlight;
      const trail = sel.has(tr.pilot) ? pointsUpTo(tr, t) : [];
      drawTrail(tr.pilot, trail, colors.get(tr.pilot) ?? PALETTE[0], renderStyle(single, isH).trail);
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
          radius: renderStyle(single, isH).dot,
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
  };

  // Altitude only here; Time Lost is a 3D-view chart.
  mountTimeline(holder, data, sel, colors, leafletFrame, undefined, { timeLost: false });
}
