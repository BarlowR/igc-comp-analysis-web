/**
 * Wire codec for a day's Results payload — what the build writes into
 * `day.json` and what a saved comp caches in storage. The in-memory shape
 * (competition.ts `Results`) is unchanged; only `map` is packed on the wire,
 * because ~98% of a big day's JSON is its tracks:
 *
 *   - every per-fix series (lat, lon, times, alt, tau) becomes scaled-integer
 *     deltas — coordinates keep 7 decimals (~1 cm), altitude whole metres,
 *     tau its 2 decimals, and whole-second fix times ship as seconds
 *   - `finalGlide` packs into a base64 bitmask
 *   - the diagnostics no client reads (`timeToGo.Vcc/hFin/dTask/hRef`) are
 *     dropped
 *
 * The payload carries `fmt: 2`. decodeResults passes a payload without it
 * through unchanged (the pre-codec plain-Results shape, still live in old
 * saved-comp caches until their owner recomputes) and refuses a format newer
 * than it knows, rather than mangling it.
 */
import type { Results, MapData, MapTrack } from './competition';

export const RESULTS_FORMAT = 2;

/**
 * A numeric series as scaled-integer deltas: value[i] = (d[0]+…+d[i]) · m ∕ s.
 * `s` (divisor) and `m` (multiplier) are integers, omitted when 1, so every
 * decode step is exact integer arithmetic followed by one exact division —
 * values round-trip to the identical double. A series with a non-finite member
 * (which a delta chain would poison) falls back to `abs`: `d` holds the raw
 * values, JSON's null standing in for the non-finite ones.
 */
interface PackedSeries {
  d: (number | null)[];
  s?: number;
  m?: number;
  abs?: true;
}

function packSeries(vals: number[], div = 1, mul = 1): PackedSeries {
  if (!vals.every(Number.isFinite)) return { d: vals.slice(), abs: true };
  const d = new Array<number>(vals.length);
  let prev = 0;
  for (let i = 0; i < vals.length; i++) {
    const int = Math.round((vals[i] * div) / mul);
    d[i] = int - prev;
    prev = int;
  }
  const out: PackedSeries = { d };
  if (div !== 1) out.s = div;
  if (mul !== 1) out.m = mul;
  return out;
}

function unpackSeries(p: PackedSeries): number[] {
  const n = p.d.length;
  const out = new Array<number>(n);
  if (p.abs) {
    for (let i = 0; i < n; i++) out[i] = p.d[i] ?? NaN;
    return out;
  }
  const s = p.s ?? 1;
  const m = p.m ?? 1;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += p.d[i] as number;
    out[i] = (acc * m) / s;
  }
  return out;
}

/** One track's per-fix series, aligned by index. */
interface PackedTrack {
  pilot: string;
  /** Degrees at divisor 1e7 (7 decimals ≈ 1 cm). */
  lat: PackedSeries;
  lon: PackedSeries;
  /** Epoch ms; whole-second tracks ship with multiplier 1000 (i.e. seconds). */
  t: PackedSeries;
  /** Whole metres. */
  alt: PackedSeries;
  /** Minutes at divisor 100 — tau is already built with 2 decimals. */
  tau?: PackedSeries;
  /** finalGlide as a base64 bitmask, one bit per fix. */
  fg?: string;
  completionMs?: number | null;
  startCrossMs?: number | null;
}

interface PackedMap extends Omit<MapData, 'tracks' | 'timeToGo'> {
  tracks: PackedTrack[];
  timeToGo: Pick<
    NonNullable<MapData['timeToGo']>,
    'M' | 'Vg' | 'g' | 'pace' | 'tauRef' | 'par'
  > | null;
}

export interface PackedResults extends Omit<Results, 'map'> {
  fmt: typeof RESULTS_FORMAT;
  map: PackedMap;
}

const round7 = (v: number): number => Math.round(v * 1e7) / 1e7;

// ---- base64 bitmask -------------------------------------------------------
// Own 15-line base64 (standard alphabet, no padding) rather than btoa/atob:
// this runs at build time in Node and at load time in the browser, and a
// symmetric streaming pair is easier to trust than two host APIs.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function packBits(bits: boolean[]): string {
  const nBytes = Math.ceil(bits.length / 8);
  let out = '';
  let buf = 0;
  let bufBits = 0;
  for (let i = 0; i < nBytes; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) if (bits[i * 8 + b]) byte |= 1 << b;
    buf = (buf << 8) | byte;
    bufBits += 8;
    while (bufBits >= 6) {
      bufBits -= 6;
      out += B64[(buf >> bufBits) & 63];
    }
  }
  if (bufBits > 0) out += B64[(buf << (6 - bufBits)) & 63];
  return out;
}

export function unpackBits(s: string, n: number): boolean[] {
  const bytes: number[] = [];
  let buf = 0;
  let bufBits = 0;
  for (const ch of s) {
    buf = (buf << 6) | B64.indexOf(ch);
    bufBits += 6;
    if (bufBits >= 8) {
      bufBits -= 8;
      bytes.push((buf >> bufBits) & 0xff);
    }
  }
  const out = new Array<boolean>(n);
  for (let i = 0; i < n; i++) out[i] = ((bytes[i >> 3] ?? 0) & (1 << (i & 7))) !== 0;
  return out;
}

// ---- tracks ---------------------------------------------------------------

function packTrack(tr: MapTrack): PackedTrack {
  const n = tr.times.length;
  const lats = new Array<number>(n);
  const lons = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    lats[i] = tr.points[i][0];
    lons[i] = tr.points[i][1];
  }
  // IGC fixes are whole seconds, so a track's times are normally all
  // millisecond-multiples of 1000 — ship those as seconds.
  const wholeSeconds = tr.times.every((v) => Number.isFinite(v) && v % 1000 === 0);

  const out: PackedTrack = {
    pilot: tr.pilot,
    lat: packSeries(lats, 1e7),
    lon: packSeries(lons, 1e7),
    t: packSeries(tr.times, 1, wholeSeconds ? 1000 : 1),
    alt: packSeries(tr.alt),
  };
  if (tr.tau) out.tau = packSeries(tr.tau, 100);
  if (tr.finalGlide) out.fg = packBits(tr.finalGlide);
  if (tr.completionMs !== undefined) out.completionMs = tr.completionMs;
  if (tr.startCrossMs !== undefined) out.startCrossMs = tr.startCrossMs;
  return out;
}

function unpackTrack(p: PackedTrack): MapTrack {
  const lats = unpackSeries(p.lat);
  const lons = unpackSeries(p.lon);
  const n = lats.length;
  const points = new Array<[number, number]>(n);
  for (let i = 0; i < n; i++) points[i] = [lats[i], lons[i]];

  const tr: MapTrack = {
    pilot: p.pilot,
    points,
    times: unpackSeries(p.t),
    alt: unpackSeries(p.alt),
  };
  if (p.tau) tr.tau = unpackSeries(p.tau);
  if (p.fg !== undefined) tr.finalGlide = unpackBits(p.fg, n);
  if (p.completionMs !== undefined) tr.completionMs = p.completionMs;
  if (p.startCrossMs !== undefined) tr.startCrossMs = p.startCrossMs;
  return tr;
}

// ---- whole payload --------------------------------------------------------

export function encodeResults(r: Results): PackedResults {
  const m = r.map;
  const ttg = m.timeToGo;
  return {
    fmt: RESULTS_FORMAT,
    table: r.table,
    climb: r.climb,
    timeLoss: r.timeLoss,
    map: {
      turnpoints: m.turnpoints,
      taskKind: m.taskKind,
      utcOffsetMinutes: m.utcOffsetMinutes,
      startMs: m.startMs,
      route: m.route?.map(([lat, lon]) => [round7(lat), round7(lon)] as [number, number]),
      // Only the terms a client reads: the plot title (M, Vg, g, pace), the L
      // series anchor (tauRef), and the par reference line.
      timeToGo: ttg
        ? { M: ttg.M, Vg: ttg.Vg, g: ttg.g, pace: ttg.pace, tauRef: ttg.tauRef, par: ttg.par }
        : null,
      tracks: m.tracks.map(packTrack),
    },
  };
}

export function decodeResults(x: unknown): Results {
  const fmt = (x as { fmt?: unknown } | null)?.fmt;
  if (fmt === undefined) return x as Results; // pre-codec plain Results
  if (fmt !== RESULTS_FORMAT) {
    throw new Error(`results format ${String(fmt)} is newer than this app understands`);
  }
  const p = x as PackedResults;
  const m = p.map;
  return {
    table: p.table,
    climb: p.climb,
    timeLoss: p.timeLoss,
    map: {
      turnpoints: m.turnpoints,
      taskKind: m.taskKind,
      utcOffsetMinutes: m.utcOffsetMinutes,
      startMs: m.startMs,
      route: m.route,
      timeToGo: m.timeToGo,
      tracks: m.tracks.map(unpackTrack),
    },
  };
}
