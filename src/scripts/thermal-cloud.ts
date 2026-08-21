/**
 * Thermal Cloud — a 3D view of a climb beside the globe, anchored on the pinned pilot.
 *
 * The air is drawn as a translucent cloud of instanced spheres, one per fix in
 * the trailing three minutes that sat near the anchor: colour and opacity ramp
 * with climb strength (transparent yellow at V_FLOOR → opaque red at VMAX,
 * on into purple for the top decile beyond VMAX),
 * size fades with age, sink below V_FLOOR is not drawn. Other pilots are grey dots with short tails; the
 * pinned pilot wears their globe colour, and the best climber nearby is teal —
 * both with a black rim and a black trail so they read against the cloud.
 *
 * Lives in the pane beside the globe on the 3D replay page (Viewer3d.astro,
 * wired by track3d.ts mountCloudPane). This module is the lazy chunk — it is
 * what pulls in Three.js, so the page never ships it until the pane is first
 * opened. The data side (resampling, vario, the per-frame query) is
 * src/lib/thermal-cloud.ts; this file is the scene and the pane's chrome.
 *
 * There is no playback here. The pane follows the page's shared scrubber and
 * the pinned pilot; it draws, it never drives.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
  buildCloudModel,
  frameAt,
  type CloudModel,
  type PilotNow,
  STEP_MS,
  TRAIL_MS,
  TAIL_MS,
  ANCHOR_TRAIL_MS,
  STAT_MS,
} from '../lib/thermal-cloud';
import type { Timeline } from '../lib/replay';
import type { MapTrack } from '../lib/competition';

export interface ThermalCloudOptions {
  tracks: MapTrack[];
  /** Pilot the camera follows; null until someone is pinned or selected. */
  anchor: string | null;
  /** Pilot → CSS colour, as the globe draws them; the anchor is drawn in theirs. */
  colors: Map<string, string>;
  timeline: Timeline;
  /** Where the no-WebGL message sends people (the 2D analysis page). */
  backHref: string;
  /** The globe's follow-cam pose about the pinned pilot, read every frame so
   * the cloud is seen from the same direction. Heading in rad (0 = north,
   * clockwise), pitch in rad (negative = down); range (m) is reported but the
   * pane keeps its own zoom. */
  pose: () => { heading: number; pitch: number; range: number } | null;
  /** Orbiting the pane turns the globe too: push a new heading/pitch back. */
  setPose: (heading: number, pitch: number) => void;
}

/** Handle onto a mounted pane. */
export interface ThermalCloud {
  /** Follow a different pilot (null: nobody — the scene empties). */
  setAnchor(name: string | null): void;
  /** Pane shown or hidden: the render loop only runs while shown. */
  setActive(on: boolean): void;
  destroy(): void;
}

// ---- encodings (spec) -------------------------------------------------------
// ---- cloud dot tuning: paste the Apply block from the playground here ------
// (analysis/thermal-dots-proto.html — its Apply button prints this block)
const SPHERE_R = 25;
const SPHERE_DETAIL = 1;
const FRESNEL_LO = 0.20; // alpha *= smoothstep(lo, hi, facing)
const FRESNEL_HI = 1.4;
const ALPHA_GAIN = 1.5; // alpha = gain * t^gamma
const ALPHA_GAMMA = 1.2;
const AGE_FADE = 0.5; // size shrink over the 3 min window
const AGE_ALPHA_FADE = 0.85; // opacity fade over the same window
const DEPTH_WRITE = false;
const ALPHA_TO_COVERAGE = false; // opaque + MSAA; overrides DEPTH_WRITE
const INTERP_SUB = 1; // spheres per 5 s sample gap; 1 = off
// ---- end tuning -------------------------------------------------------------
/** Number → GLSL float literal (the shader template needs the decimal point). */
const glf = (n: number): string => n.toFixed(4);
const V_FLOOR = -1; // m/s; the ramp's transparent end — air sinking faster is not drawn
const COL_LO = 0xf2c230;
const COL_HI = 0xe24b4a;
const COL_XHI = 0x9038a3; // red keeps going into purple past vmax (the P90 clamp)
const XHI_SPAN = 0.5; // fully purple at vmax + span * (vmax - V_FLOOR)
const GREY = 0x8a847a;
const ACCENT = 0x705a90;
const HILITE = 0x1f8a9e; // teal: reads against both the yellow→red ramp and the grey
const OUTLINE = 0x000000; // rim around the anchor/best dots, and their trails
const TRAIL_W = 3; // px at the pilot; the anchor/best trails are fat lines, the grey tails stay 1 px
const TAPER_S = 30; // s of trail age over which TRAIL_W thins back to 1 px
const TAIL_PTS = TAIL_MS / STEP_MS + 1;
const TRAIL_PTS = ANCHOR_TRAIL_MS / STEP_MS + 2;

// One model per tracks array — the page's array is stable for the page's life,
// so remounting the pane costs nothing but the scene.
const modelCache = new WeakMap<MapTrack[], CloudModel>();

const CSS = `
.tc{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;color:var(--text,#140c0c);font-size:.85rem;container-type:inline-size}
.tc-stage{position:relative;flex:1;min-height:0;margin:.5rem .6rem .55rem}
.tc-stage canvas{display:block;width:100%;height:100%;background:var(--panel-2,#ece3cf);border:1px solid var(--border,rgba(20,12,12,.35));border-radius:9px;touch-action:none;cursor:grab}
.tc-stage canvas:active{cursor:grabbing}
.tc-stage.tc-loading canvas{background:linear-gradient(110deg,var(--panel-2,#ece3cf) 40%,var(--panel,#f5efe1) 50%,var(--panel-2,#ece3cf) 60%);background-size:200% 100%;animation:tc-sheen 1.1s linear infinite}
@keyframes tc-sheen{to{background-position:-200% 0}}
.tc-spinner{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted,#6b625e);font-size:.8rem;pointer-events:none}
.tc-overlay{position:absolute;top:.5rem;left:.6rem;display:flex;flex-direction:column;gap:.4rem;pointer-events:none;width:220px}
.tc-stats,.tc-legend{background:rgba(245,239,225,.92);border:1px solid var(--border,rgba(20,12,12,.35));border-radius:8px;padding:.4rem .6rem;font-size:.74rem;line-height:1.5}
.tc-stats b{font-weight:500;font-variant-numeric:tabular-nums}
.tc-stats .lbl{color:var(--muted,#6b625e)}
.tc-stats>div{min-width:0}
.tc-stats .who{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tc-legend{display:flex;flex-direction:column;gap:.1rem;color:var(--muted,#6b625e)}
.tc-legend b{font-weight:400;color:var(--text,#140c0c)}
.tc-scale{display:flex;align-items:center;gap:.4rem}
.tc-scale .bar{flex:1;height:9px;min-width:70px;border-radius:5px;border:1px solid var(--border,rgba(20,12,12,.35));background:linear-gradient(90deg,rgba(242,194,48,0),#F2C230 48%,#E24B4A 84%,#9038A3)}
.tc-chip{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:.4rem;vertical-align:-1px}
.tc-tip{position:absolute;pointer-events:none;background:var(--border-strong,#140c0c);color:#f5efe1;font-size:.74rem;line-height:1.45;padding:.35rem .5rem;border-radius:7px;max-width:220px;display:none;z-index:2}
.tc-tip b{font-weight:500}
.tc-nogl,.tc-empty{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:1rem;color:var(--muted,#6b625e);line-height:1.5;pointer-events:none}
.tc-nogl{pointer-events:auto}
.tc-nogl a{color:var(--accent,#705a90)}
/* Narrow pane: the overlays would cover the whole canvas, so they reflow below it. */
@container (max-width: 420px){
  .tc-stage{flex:none;height:min(52%,300px)}
  .tc-below{overflow-y:auto;padding:0 .6rem .5rem}
  .tc-overlay{position:static;width:auto;margin-top:.4rem}
  .tc-stats{display:grid;grid-template-columns:1fr 1fr;gap:0 .8rem}
}
/* Phones: the canvas is the whole pane; the stats and legend are dropped rather than squeezed. */
@media (max-width:700px){
  .tc-below,.tc-overlay{display:none}
  .tc-stage{flex:1;height:auto;margin:.4rem .5rem}
}
@media (prefers-reduced-motion:reduce){.tc-stage.tc-loading canvas{animation:none}}
`;

function ensureCss(): void {
  if (document.getElementById('tc-css')) return;
  const s = document.createElement('style');
  s.id = 'tc-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const fmtV = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;

/** Mount the pane into `container`. */
export function mountThermalCloud(container: HTMLElement, opts: ThermalCloudOptions): ThermalCloud {
  ensureCss();
  const { timeline } = opts;
  let anchorName = opts.anchor;

  // ---- chrome -------------------------------------------------------------
  const root = el('div', 'tc');
  const stage = el('div', 'tc-stage tc-loading');
  const canvas = el('canvas');
  const spinner = el('div', 'tc-spinner', 'Loading…');
  const tip = el('div', 'tc-tip');
  const empty = el('div', 'tc-empty');
  empty.hidden = true;
  const NO_PIN = 'Pin a pilot to see the air around them.';
  const NOT_FLYING = 'Pinned pilot not airborne.';
  stage.append(canvas, spinner, tip, empty);

  // Stats + legend overlay the canvas; in a narrow pane they reflow below it
  // (the container query in CSS moves .tc-overlay out of absolute positioning,
  // and .tc-below is the scroll box they land in).
  const below = el('div', 'tc-below');
  const overlay = el('div', 'tc-overlay');
  const stats = el('div', 'tc-stats');
  const sYou = el('b', undefined, '—');
  const sAlt = el('b', undefined, '—');
  const sBest = el('b', undefined, '—');
  const sMed = el('b', undefined, '—');
  const sWho = el('b', undefined, '—');
  const statRow = (label: string, ...nodes: (Node | string)[]): HTMLElement => {
    const d = el('div');
    d.append(el('span', 'lbl', label), ' ', ...nodes);
    return d;
  };
  // The name row gets .who: nowrap + ellipsis, so a long pilot name can't
  // resize the fixed-width box.
  const whoRow = statRow('Best nearby', sWho);
  whoRow.classList.add('who');
  stats.append(
    statRow('Pilot now', sYou, ' m/s · ', sAlt, ' m'),
    statRow(`Best, ${STAT_MS / 1000} s`, sBest, ' m/s'),
    statRow(`Avg, ${STAT_MS / 1000} s`, sMed, ' m/s'),
    whoRow,
  );
  const legend = el('div', 'tc-legend');
  const scale = el('div', 'tc-scale');
  const vmaxLabel = el('span', undefined, '+— m/s');
  scale.append(el('span', undefined, `${V_FLOOR}`), el('div', 'bar'), vmaxLabel);
  const greyRow = el('span');
  const chip = el('span', 'tc-chip');
  chip.style.background = '#8a847a';
  greyRow.append(chip, 'other pilots · size = age');
  const bestRow = el('span');
  const bestChip = el('span', 'tc-chip');
  bestChip.style.background = '#1F8A9E';
  bestChip.style.border = '2px solid #000';
  bestRow.append(bestChip, 'best climb nearby');
  legend.append(el('b', undefined, 'Lift'), scale, greyRow, bestRow, el('span', undefined, `sink below ${V_FLOOR} m/s not drawn`));
  overlay.append(stats, legend);
  below.append(overlay);

  root.append(stage, below);
  container.replaceChildren(root);

  const narrow = (): boolean => root.clientWidth > 0 && root.clientWidth <= 420;
  const placeOverlays = (): void => {
    if (narrow()) below.append(overlay);
    else stage.append(overlay);
  };
  placeOverlays();

  // ---- lifecycle ----------------------------------------------------------
  let destroyed = false;
  let active = true;
  let raf = 0;
  let unsubTime: (() => void) | null = null;
  let disposeScene: (() => void) | null = null;
  let ro: ResizeObserver | null = null;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    unsubTime?.();
    cancelAnimationFrame(raf);
    ro?.disconnect();
    disposeScene?.();
    root.remove();
  };

  // ---- WebGL gate ---------------------------------------------------------
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
  if (!gl) {
    stage.classList.remove('tc-loading');
    spinner.remove();
    const msg = el('div', 'tc-nogl');
    const p = el('p');
    p.append(
      'No WebGL here. ',
      Object.assign(el('a', undefined, 'Open the 2D analysis'), { href: opts.backHref }),
      ' instead.',
    );
    msg.append(p);
    stage.append(msg);
    return { setAnchor: () => {}, setActive: () => {}, destroy };
  }

  // ---- model + timeline range ---------------------------------------------
  let model = modelCache.get(opts.tracks);
  if (!model) {
    model = buildCloudModel(opts.tracks);
    modelCache.set(opts.tracks, model);
  }
  const M = model;
  vmaxLabel.textContent = `+${M.vmax.toFixed(1)} m/s`;
  vmaxLabel.title = "Day's 90th-percentile climb";
  let T = timeline.now();


  // ---- scene --------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xece3cf);
  const camera = new THREE.PerspectiveCamera(55, 2, 1, 20_000);
  const altMid = (M.altLo + M.altHi) / 2;
  // Local frame → scene: x east, y up (1:1 altitude about the day's mid), z south.
  const W = (x: number, alt: number, y: number, out = new THREE.Vector3()): THREE.Vector3 => out.set(x, alt - altMid, -y);

  // Cloud: instanced icosahedra, per-instance colour + alpha, fresnel edge fade.
  // Capacity = every sample that could ever be in a 3 min window: one per
  // pilot per step, plus one — times the interpolation factor.
  const MAXI = M.tracks.length * (TRAIL_MS / STEP_MS + 1) * INTERP_SUB;
  const sphereGeo = new THREE.IcosahedronGeometry(SPHERE_R, SPHERE_DETAIL);
  const alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAXI), 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  sphereGeo.setAttribute('instanceAlpha', alphaAttr);
  const fieldMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: !ALPHA_TO_COVERAGE,
    depthWrite: ALPHA_TO_COVERAGE || DEPTH_WRITE,
    alphaToCoverage: ALPHA_TO_COVERAGE,
  });
  fieldMat.onBeforeCompile = (sh) => {
    sh.vertexShader =
      'attribute float instanceAlpha;\nvarying float vA;\nvarying vec3 vN;\nvarying vec3 vVp;\n' +
      sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvA = instanceAlpha;\nvN = normalize(normalMatrix * normal);')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvVp = mvPosition.xyz;');
    sh.fragmentShader =
      'varying float vA;\nvarying vec3 vN;\nvarying vec3 vVp;\n' +
      sh.fragmentShader.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nfloat facing = clamp(dot(normalize(vN), normalize(-vVp)), 0.0, 1.0);\n' +
          `diffuseColor.a *= ${glf(ALPHA_GAIN)} * pow(vA, ${glf(ALPHA_GAMMA)}) * smoothstep(${glf(FRESNEL_LO)}, ${glf(FRESNEL_HI)}, facing);`,
      );
  };
  const field = new THREE.InstancedMesh(sphereGeo, fieldMat, MAXI);
  field.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXI * 3), 3);
  field.instanceColor.setUsage(THREE.DynamicDrawUsage);
  field.renderOrder = 1;
  field.frustumCulled = false;
  scene.add(field);
  const YEL = new THREE.Color(COL_LO);
  const RED = new THREE.Color(COL_HI);
  const PUR = new THREE.Color(COL_XHI);
  const C = new THREE.Color();
  /** Hover metadata per visible instance. */
  let airMeta: { name: string; mine: boolean; v: number; alt: number; ageS: number }[] = [];

  // Grey pilots: one instanced mesh for the dots, one line per tail.
  const nOthers = Math.max(1, M.tracks.length);
  const dotGeo = new THREE.IcosahedronGeometry(4, 1);
  const dotMat = new THREE.MeshBasicMaterial({ color: GREY, transparent: true, depthTest: false });
  const pilotsNow = new THREE.InstancedMesh(dotGeo, dotMat, nOthers);
  pilotsNow.renderOrder = 10;
  pilotsNow.frustumCulled = false;
  scene.add(pilotsNow);
  const tailMat = new THREE.LineBasicMaterial({ color: GREY, transparent: true, opacity: 0.6, depthTest: false });
  tailMat.onBeforeCompile = (sh) => {
    sh.vertexShader =
      'attribute float aFade;\nvarying float vFade;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
    sh.fragmentShader =
      'varying float vFade;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vFade;');
  };
  // Right-aligned buffer: the newest point is always the last vertex, so the
  // fade ramp (0 → 1 along the buffer) ends opaque at the pilot.
  const fadeArr = new Float32Array(TAIL_PTS);
  for (let i = 0; i < TAIL_PTS; i++) fadeArr[i] = i / (TAIL_PTS - 1);
  const tails: THREE.Line[] = [];
  for (let i = 0; i < nOthers; i++) {
    const g = new THREE.BufferGeometry().setFromPoints(Array.from({ length: TAIL_PTS }, () => new THREE.Vector3()));
    g.setAttribute('aFade', new THREE.BufferAttribute(fadeArr, 1));
    const l = new THREE.Line(g, tailMat);
    l.visible = false;
    l.renderOrder = 10;
    l.frustumCulled = false;
    scene.add(l);
    tails.push(l);
  }
  // Fat lines (Line2): plain THREE.Line is 1 px everywhere WebGL matters, so
  // the two highlighted trails get the screen-space-width addon instead.
  // resolution is fed CSS pixels in onResize, making TRAIL_W a CSS-px width.
  const trailMat = new LineMaterial({ color: OUTLINE, linewidth: TRAIL_W, transparent: true, depthTest: false });
  // Taper: LineMaterial's width is a uniform, so scale it per segment (each
  // segment is one instance) — 1 at the pilot down to 1px/TRAIL_W past TAPER_S.
  trailMat.onBeforeCompile = (sh) => {
    sh.vertexShader =
      'attribute float instanceWidth;\n' + sh.vertexShader.replace('offset *= linewidth;', 'offset *= linewidth * instanceWidth;');
  };
  const trailLine = (): Line2 => {
    const g = new LineGeometry();
    g.setPositions([0, 0, 0, 0, 0, 0]);
    g.setAttribute('instanceWidth', new THREE.InstancedBufferAttribute(new Float32Array([1]), 1));
    const l = new Line2(g, trailMat);
    l.renderOrder = 11;
    l.frustumCulled = false;
    l.visible = false;
    scene.add(l);
    return l;
  };
  const bigDot = (color: number, r: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false }));
    m.renderOrder = 11;
    m.frustumCulled = false;
    // Black rim: a slightly larger back-facing shell, drawn just before the
    // dot (renderOrder 10.5 < 11) so the dot covers all but the edge.
    const rim = new THREE.Mesh(
      new THREE.IcosahedronGeometry(r * 1.25, 1),
      new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide, transparent: true, depthTest: false }),
    );
    rim.renderOrder = 10.5;
    rim.frustumCulled = false;
    m.add(rim);
    scene.add(m);
    return m;
  };
  const meTrail = trailLine();
  const meDot = bigDot(ACCENT, 16);
  const setAnchorColor = (name: string | null): void => {
    const css = name ? opts.colors.get(name) : undefined;
    (meDot.material as THREE.MeshBasicMaterial).color.copy(new THREE.Color(css ?? ACCENT));
  };
  setAnchorColor(anchorName);
  // The best climber nearby: a teal dot + 75 s tail in place of their grey one.
  const bestTrail = trailLine();
  const bestDot = bigDot(HILITE, 13);
  bestTrail.visible = false;
  bestDot.visible = false;

  // ---- camera: the globe's heading + pitch, the pane's own zoom -----------
  // Cesium's camera sits behind its view direction; in the ENU frame that
  // direction is (sin h cos p, cos h cos p, sin p) for (east, north, up). Here
  // east is +x, up is +y, north is -z. Range is local: the globe is usually
  // kilometres back, far too far to read a thermal.
  const target = new THREE.Vector3();
  const anchorPos = new THREE.Vector3();
  let targetSet = false;
  let heading = Math.PI * 0.75;
  let pitch = -0.35;
  let range = 1100;
  const placeCamera = (): void => {
    const pz = opts.pose();
    if (pz) {
      heading = pz.heading;
      pitch = pz.pitch;
    }
    // Ease the look target onto the pilot every frame; a scrub that jumps
    // kilometres snaps instead of gliding through empty air.
    if (targetSet) {
      if (target.distanceTo(anchorPos) > 3000) target.copy(anchorPos);
      else target.lerp(anchorPos, 0.2);
    }
    const cp = Math.cos(pitch);
    camera.position.set(
      target.x - range * Math.sin(heading) * cp,
      target.y - range * Math.sin(pitch),
      target.z + range * Math.cos(heading) * cp,
    );
    camera.lookAt(target);
  };
  let hoverXY: [number, number] | null = null;
  let needsHover = false;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  let dragging = false;
  let lx = 0;
  let ly = 0;
  const zoomTo = (r: number): void => {
    range = Math.max(250, Math.min(4000, r));
    placeCamera();
  };
  // A drag here orbits both views: the new pose goes to the globe, and the
  // next frame reads it back through opts.pose like any other globe move.
  const orbitBy = (dx: number, dy: number): void => {
    heading += dx * 0.005;
    pitch = Math.max(-1.42, Math.min(-0.07, pitch + dy * 0.005));
    opts.setPose(heading, pitch);
    placeCamera();
  };
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      dragging = false;
    } else {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      downXY = [e.clientX, e.clientY];
    }
    canvas.setPointerCapture(e.pointerId);
    tip.style.display = 'none';
  });
  let downXY: [number, number] | null = null;
  const endPointer = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    // A tap (no drag to speak of) on a touch screen is the hover it can't do.
    if (e.pointerType !== 'mouse' && downXY && Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) < 6) {
      hoverXY = [e.clientX, e.clientY];
      needsHover = true;
    }
    downXY = null;
    dragging = pointers.size === 1;
    if (dragging) {
      const p = [...pointers.values()][0];
      lx = p.x;
      ly = p.y;
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) zoomTo((range * pinchDist) / d);
      pinchDist = d;
      needsHover = false;
      return;
    }
    if (dragging) {
      orbitBy(e.clientX - lx, e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
      needsHover = false;
      return;
    }
    hoverXY = [e.clientX, e.clientY];
    needsHover = true;
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomTo(range * Math.pow(1.1, Math.sign(e.deltaY)));
    },
    { passive: false },
  );
  canvas.addEventListener('pointerleave', () => {
    tip.style.display = 'none';
    needsHover = false;
  });

  // ---- per-frame update -----------------------------------------------------
  const Mx = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const S = new THREE.Vector3();
  const P = new THREE.Vector3();
  const setLine = (line: THREE.Line, pts: PilotNow['tail'], rightAlign: boolean): void => {
    const pos = line.geometry.attributes.position as THREE.BufferAttribute;
    const cap = pos.count;
    const use = pts.slice(Math.max(0, pts.length - cap));
    if (use.length < 2) {
      line.visible = false;
      return;
    }
    const start = rightAlign ? cap - use.length : 0;
    const w = new THREE.Vector3();
    W(use[0].x, use[0].alt, use[0].y, w);
    for (let f = 0; f < start; f++) pos.setXYZ(f, w.x, w.y, w.z);
    use.forEach((p, k) => {
      W(p.x, p.alt, p.y, w);
      pos.setXYZ(start + k, w.x, w.y, w.z);
    });
    if (!rightAlign) {
      const last = use[use.length - 1];
      W(last.x, last.alt, last.y, w);
      for (let f = use.length; f < cap; f++) pos.setXYZ(f, w.x, w.y, w.z);
    }
    pos.needsUpdate = true;
    line.visible = true;
  };
  // Same job for the two fat trails; LineGeometry takes a flat variable-length
  // array, so no fixed-capacity padding is needed.
  const setTrail = (line: Line2, pts: PilotNow['tail']): void => {
    const use = pts.slice(Math.max(0, pts.length - TRAIL_PTS));
    if (use.length < 2) {
      line.visible = false;
      return;
    }
    const arr = new Float32Array(use.length * 3);
    const w = new THREE.Vector3();
    use.forEach((p, k) => {
      W(p.x, p.alt, p.y, w);
      arr[k * 3] = w.x;
      arr[k * 3 + 1] = w.y;
      arr[k * 3 + 2] = w.z;
    });
    line.geometry.setPositions(arr);
    // Per-segment width: tail points sit on the STEP_MS grid, newest last, so
    // a segment's age is its distance from the end.
    const segs = use.length - 1;
    const widths = new Float32Array(segs);
    for (let s = 0; s < segs; s++) {
      const ageS = (segs - 1 - s) * (STEP_MS / 1000);
      const px = 1 + (TRAIL_W - 1) * Math.max(0, 1 - ageS / TAPER_S);
      widths[s] = px / TRAIL_W;
    }
    line.geometry.setAttribute('instanceWidth', new THREE.InstancedBufferAttribute(widths, 1));
    line.visible = true;
  };

  let dirty = true;
  const update = (): void => {
    dirty = false;
    const f = anchorName
      ? frameAt(M, anchorName, T)
      : { anchor: null, others: [], air: [], best: null, avg: null, bestNearby: null };
    empty.hidden = !!f.anchor;
    if (!f.anchor) empty.textContent = anchorName ? NOT_FLYING : NO_PIN;

    if (f.anchor) {
      W(f.anchor.x, f.anchor.alt, f.anchor.y, anchorPos);
      if (!targetSet) {
        target.copy(anchorPos);
        targetSet = true;
      }
    }
    placeCamera();

    // Cloud
    let i = 0;
    const metaNext: typeof airMeta = [];
    const windowS = TRAIL_MS / 1000;
    const emit = (pilot: string, x: number, y: number, alt: number, v: number, ageS: number): void => {
      if (v <= V_FLOOR || i >= MAXI) return;
      const sc = 1 - AGE_FADE * (ageS / windowS);
      W(x, alt, y, P);
      S.set(sc, sc, sc);
      Mx.compose(P, Q, S);
      field.setMatrixAt(i, Mx);
      const t = Math.min(1, (v - V_FLOOR) / (M.vmax - V_FLOOR));
      alphaAttr.setX(i, t * (1 - AGE_ALPHA_FADE * (ageS / windowS)));
      C.copy(YEL).lerp(RED, t);
      const over = Math.min(1, (v - M.vmax) / (XHI_SPAN * (M.vmax - V_FLOOR)));
      if (over > 0) C.lerp(PUR, over);
      field.setColorAt(i, C);
      metaNext.push({ name: pilot, mine: pilot === anchorName, v, alt, ageS });
      i++;
    };
    // f.air is ordered per pilot, newest first; a same-pilot pair one grid
    // step apart gets INTERP_SUB - 1 lerped spheres between them.
    let prev: (typeof f.air)[number] | null = null;
    for (const s of f.air) {
      if (INTERP_SUB > 1 && prev && prev.pilot === s.pilot && s.ageS - prev.ageS <= STEP_MS / 1000 + 0.01) {
        for (let k = 1; k < INTERP_SUB; k++) {
          const fr = k / INTERP_SUB;
          emit(
            s.pilot,
            prev.x + (s.x - prev.x) * fr,
            prev.y + (s.y - prev.y) * fr,
            prev.alt + (s.alt - prev.alt) * fr,
            prev.v + (s.v - prev.v) * fr,
            prev.ageS + (s.ageS - prev.ageS) * fr,
          );
        }
      }
      emit(s.pilot, s.x, s.y, s.alt, s.v, s.ageS);
      prev = s;
    }
    airMeta = metaNext;
    field.count = i;
    field.instanceMatrix.needsUpdate = true;
    field.instanceColor!.needsUpdate = true;
    alphaAttr.needsUpdate = true;

    // Is the pinned pilot out-climbing everyone nearby? Then nobody gets the
    // teal, and the readout says so.
    const selfBest = f.avg != null && f.avg > 0 && (!f.bestNearby || f.avg >= f.bestNearby.v);

    // Grey pilots (the best climber is pulled out and drawn teal below)
    const bestName = selfBest ? null : (f.bestNearby?.pilot ?? null);
    let bestP: PilotNow | null = null;
    let j = 0;
    for (let k = 0; k < tails.length; k++) {
      const p = f.others[k];
      if (p && p.pilot === bestName) bestP = p;
      if (!p || j >= nOthers || p.pilot === bestName) {
        tails[k].visible = false;
        continue;
      }
      W(p.x, p.alt, p.y, P);
      S.set(1, 1, 1);
      Mx.compose(P, Q, S);
      pilotsNow.setMatrixAt(j++, Mx);
      setLine(tails[k], p.tail, true);
    }
    pilotsNow.count = j;
    pilotsNow.instanceMatrix.needsUpdate = true;

    if (bestP) {
      setTrail(bestTrail, bestP.tail);
      W(bestP.x, bestP.alt, bestP.y, bestDot.position);
      bestDot.visible = true;
    } else {
      bestTrail.visible = false;
      bestDot.visible = false;
    }

    // Anchor
    if (f.anchor) {
      setTrail(meTrail, f.anchor.tail);
      W(f.anchor.x, f.anchor.alt, f.anchor.y, meDot.position);
      meDot.visible = true;
    } else {
      meTrail.visible = false;
      meDot.visible = false;
    }

    // Stats
    sYou.textContent = f.anchor ? fmtV(f.anchor.v) : '—';
    sAlt.textContent = f.anchor ? Math.round(f.anchor.alt).toLocaleString() : '—';
    sBest.textContent = f.best != null ? fmtV(f.best) : '—';
    sMed.textContent = f.avg != null ? fmtV(f.avg) : '—';
    sWho.textContent = selfBest
      ? `${anchorName} (pinned) ${fmtV(f.avg!)} m/s`
      : f.bestNearby
        ? `${f.bestNearby.pilot} ${fmtV(f.bestNearby.v)} m/s`
        : '—';
  };

  // ---- hover --------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const doHover = (): void => {
    if (!needsHover || !hoverXY) return;
    needsHover = false;
    const r = canvas.getBoundingClientRect();
    mouse.set(((hoverXY[0] - r.left) / r.width) * 2 - 1, -((hoverXY[1] - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    // Only the visible instances: count is already trimmed, and the raycaster
    // honours it.
    const hit = ray.intersectObject(field)[0];
    const s = hit?.instanceId != null ? airMeta[hit.instanceId] : undefined;
    if (!s) {
      tip.style.display = 'none';
      return;
    }
    const when = s.ageS === 0 ? 'now' : `${Math.round(s.ageS)} s ago`;
    tip.replaceChildren();
    const b = el('b', undefined, `${s.name}${s.mine ? ' (pinned)' : ''}`);
    tip.append(b, document.createElement('br'), `${fmtV(s.v)} m/s · ${Math.round(s.alt).toLocaleString()} m`, document.createElement('br'), when);
    tip.style.left = `${Math.min(hoverXY[0] - r.left + 12, r.width - 200)}px`;
    tip.style.top = `${hoverXY[1] - r.top + 12}px`;
    tip.style.display = 'block';
  };

  // ---- sync -----------------------------------------------------------------
  // The page's scrubber is the one clock; every move of it lands here.
  unsubTime = timeline.onTime((ms) => {
    if (ms === T) return;
    T = ms;
    dirty = true;
  });

  // ---- size + loop ----------------------------------------------------------
  const onResize = (): void => {
    placeOverlays();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    trailMat.resolution.set(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  };
  ro = new ResizeObserver(onResize);
  ro.observe(root);

  let firstFrame = true;
  const loop = (): void => {
    raf = 0;
    if (destroyed || !active) return;
    if (dirty) update();
    else placeCamera();
    doHover();
    renderer.render(scene, camera);
    if (firstFrame) {
      firstFrame = false;
      stage.classList.remove('tc-loading');
      spinner.remove();
    }
    raf = requestAnimationFrame(loop);
  };
  const start = (): void => {
    if (!raf && active && !destroyed) raf = requestAnimationFrame(loop);
  };
  onResize();
  start();

  disposeScene = (): void => {
    sphereGeo.dispose();
    fieldMat.dispose();
    dotGeo.dispose();
    dotMat.dispose();
    tailMat.dispose();
    for (const t of tails) t.geometry.dispose();
    for (const l of [meTrail, bestTrail]) l.geometry.dispose();
    trailMat.dispose();
    for (const d of [meDot, bestDot]) {
      d.geometry.dispose();
      (d.material as THREE.Material).dispose();
    }
    renderer.dispose();
  };

  return {
    setAnchor(name) {
      if (name === anchorName) return;
      anchorName = name;
      setAnchorColor(name);
      targetSet = false; // snap the camera to the new pilot rather than gliding 10 km
      dirty = true;
    },
    setActive(on) {
      active = on;
      if (on) {
        dirty = true;
        start();
      } else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    destroy,
  };
}
