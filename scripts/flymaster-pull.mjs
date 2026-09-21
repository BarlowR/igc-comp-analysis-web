#!/usr/bin/env node
/**
 * Pull a task + pilot tracks from Flymaster live tracking into the archive.
 *
 *   node scripts/flymaster-pull.mjs --group 8002 --task-id 1438 --comp red-rocks-2026
 *   node scripts/flymaster-pull.mjs --group 8002 --task-id 1438 --task-id 1442 --dry
 *
 * Flymaster (lt.flymaster.net) scores comps that publish a public results
 * page per task, e.g.
 *   https://lt.flymaster.net/bsTaskResultsFiltered.php?idgroup=8002&taskId=1438
 * The group's task list (bsGetTasks.php) needs a login, so each task id is
 * passed by hand — copy it from the results URL. No login for the rest:
 *   - GET  bsTaskResultsFiltered.php?idgroup=&taskId=
 *                                 -> results HTML: comp title, task name/date,
 *                                    one row per pilot with a
 *                                    `data-compe-id` (the pilot key), name,
 *                                    glider; a Task Definition table whose
 *                                    Type column says whether the goal is a
 *                                    line.
 *   - GET  bs.php?grp=<group>    -> the live page embeds `utc_offset=<secs>`.
 *   - POST bsGetTaskGeo.php      (idgroup, taskId) -> turnpoints: a/o lat/lon,
 *                                    s radius km, n name, alt m, type code
 *                                    (0 takeoff, 1 SSS, 3 cylinder, 5 ESS,
 *                                    6 goal line), tptime HHMM local (the
 *                                    SSS item carries the start gate, the
 *                                    goal item the deadline).
 *   - POST bsGetPilotTrack.php   (idgroup, taskId, compe_id) -> the pilot's
 *                                    1 Hz track: [lat, lon, alt, t, ground,
 *                                    agl] with t in seconds after LOCAL
 *                                    midnight. There is no IGC file to
 *                                    download (`has_igc` is "0"), so one is
 *                                    written from the track points.
 * Each task is handed to scripts/archive.mjs, like airscore-pull.mjs.
 *
 * The synthesised IGC carries HFDTE (UTC date of the first fix), HFPLTPILOT
 * and B records with the track altitude in both the pressure and GNSS
 * fields. A task that runs past UTC midnight (Utah evenings do) is fine: the
 * app's parser rolls the date over when the clock wraps.
 *
 * Flags:
 *   --group <id>      (required) Flymaster idgroup
 *   --task-id <id>    (required, repeatable) Flymaster taskId
 *   --comp <slug>     (required) archive comp slug, e.g. red-rocks-2026
 *   --comp-label <s>  override the comp label (default: the page's <h1>)
 *   --day <slug>      archive day slug (default: day<N> from "Task N")
 *   --kind <k>        task kind passed to archive.mjs (default xc)
 *   --host <url>      base URL (default: https://lt.flymaster.net)
 *   --dry             print the plan without downloading or writing
 *   --keep-staging    don't delete the temp download dir (for debugging)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HOST = 'https://lt.flymaster.net';

// ---- args ------------------------------------------------------------------

function parseArgs(argv) {
  const out = { taskIds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'dry' || key === 'keep-staging') {
      out[key] = true;
      continue;
    }
    const val = argv[++i];
    if (key === 'task-id') out.taskIds.push(String(val));
    else out[key] = val;
  }
  return out;
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.group) die('--group <idgroup> is required (from the results URL).');
if (args.taskIds.length === 0) die('--task-id <taskId> is required (from the results URL).');
if (!args.comp) die('--comp <slug> is required (e.g. --comp red-rocks-2026).');
if (args.day && args.taskIds.length > 1) die('--day only makes sense with a single --task-id.');
const HOST = (args.host ?? DEFAULT_HOST).replace(/\/$/, '');

// ---- fetch helpers ---------------------------------------------------------
// curl, not node fetch: curl honors HTTPS_PROXY (needed inside the sandbox).

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Gap between requests: the server answers 429 to a burst of track downloads.
const REQUEST_GAP_MS = 1500;
// Backoff after a failed attempt. The server also now and then closes a
// response early ("curl: (18) transfer closed with outstanding read data
// remaining"), so every request gets a few attempts.
const RETRY_WAIT_MS = [2000, 5000, 15000, 30000, 60000];

function curl(extra, url) {
  let lastErr;
  for (let i = 0; i <= RETRY_WAIT_MS.length; i++) {
    try {
      const out = execFileSync(
        'curl',
        ['-fsSL', '--http1.1', '-A', 'Mozilla/5.0', '--max-time', '120', ...extra, url],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      sleep(REQUEST_GAP_MS);
      return out;
    } catch (e) {
      lastErr = e;
      if (i < RETRY_WAIT_MS.length) sleep(RETRY_WAIT_MS[i]);
    }
  }
  throw new Error(`${url} failed: ${lastErr.stderr?.toString().trim() || lastErr.message}`);
}

const getText = (url) => curl([], url);

function postJson(path, fields) {
  const body = Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const text = curl(['-d', body], `${HOST}/${path}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 120)}`);
  }
}

// ---- results page parsing --------------------------------------------------

const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Results HTML -> { compLabel, taskName, date, taskNum, goalIsLine, pilots[] }. */
function parseResultsPage(html) {
  const compLabel = decodeEntities(html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? '');
  if (!compLabel) throw new Error('no <h1> on the results page — wrong group/task id?');

  // <div class="task-name"><strong>Task 1</strong> — 2026-09-20 (...)</div>
  const tn = html.match(/class="task-name">\s*<strong>([^<]*)<\/strong>\s*—\s*(\d{4}-\d{2}-\d{2})/);
  const taskName = decodeEntities(tn?.[1] ?? '');
  const date = tn?.[2] ?? null;
  const taskNum = taskName.match(/task\s*(\d+)/i)?.[1] ?? null;

  // The Task Definition table's Type column: "Goal Line" vs "Goal Cylinder".
  const defBlock = html.match(/Task Definition[\s\S]*?<\/table>/)?.[0] ?? '';
  const typeCells = [...defBlock.matchAll(/<td class="fs_res">([^<]*)<\/td>/g)].map((m) => m[1].trim());
  const goalIsLine = typeCells.some((t) => /goal\s*line/i.test(t));

  // One row per pilot: the map link carries the compe_id, then nation, CIVL, glider cells.
  const pilots = [];
  const rowRe = /<tr class="fs_res_res_row"[\s\S]*?<\/tr>/g;
  for (const row of html.match(rowRe) ?? []) {
    const id = row.match(/data-compe-id="(\d+)"/)?.[1];
    if (!id) continue;
    const name = decodeEntities(row.match(/data-compe-id="\d+"[^>]*>([\s\S]*?)<\/a>/)?.[1]);
    const glider = decodeEntities(row.match(/col-glider">([\s\S]*?)<\/td>/)?.[1]);
    const flight = decodeEntities(row.match(/col-flight">([\s\S]*?)<\/td>/)?.[1]);
    pilots.push({ id, name: name || `Pilot ${id}`, glider, flight });
  }
  return { compLabel, taskName, date, taskNum, goalIsLine, pilots };
}

/** The live page embeds `var utc_offset=-21600;` (seconds east of UTC). */
function parseUtcOffsetSeconds(html) {
  const m = html.match(/utc_offset\s*=\s*(-?\d+)/);
  if (!m) throw new Error('no utc_offset on the live page');
  return Number(m[1]);
}

// ---- reconstruct .xctsk from bsGetTaskGeo ---------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** "1310" local HHMM -> "19:10:00Z" given the offset in seconds. */
function localHhmmToGate(hhmm, utcOffsetSec) {
  const m = String(hhmm ?? '').match(/^(\d{2})(\d{2})$/);
  if (!m) return null;
  const localSec = Number(m[1]) * 3600 + Number(m[2]) * 60;
  const utcSec = ((localSec - utcOffsetSec) % 86400 + 86400) % 86400;
  return `${pad(Math.floor(utcSec / 3600))}:${pad(Math.floor((utcSec % 3600) / 60))}:${pad(utcSec % 60)}Z`;
}

// Flymaster item.type -> .xctsk turnpoint type. Cylinders and goal carry no type.
const TP_TYPE = { 0: 'TAKEOFF', 1: 'SSS', 2: 'SSS', 5: 'ESS' };
const GOAL_TYPES = new Set([4, 6]);

function buildXcTask(geo, goalIsLine, utcOffsetSec) {
  const items = geo.items ?? [];
  if (items.length === 0) throw new Error('bsGetTaskGeo returned no turnpoints');

  const turnpoints = items.map((it, i) => {
    const code = Number(it.type);
    const type = TP_TYPE[code] ?? null;
    if (type === null && code !== 3 && !GOAL_TYPES.has(code)) {
      console.warn(`    ! turnpoint ${it.n} has unknown Flymaster type ${it.type} — treated as a cylinder`);
    }
    const waypoint = {
      lon: Number(it.o),
      lat: Number(it.a),
      altSmoothed: Math.round(Number(it.alt) || 0),
      name: it.n ?? `TP${i}`,
      description: '',
    };
    const radius = Math.round(Number(it.s) * 1000) || 400;
    return type ? { radius, waypoint, type } : { radius, waypoint };
  });

  const sssItem = items.find((it) => TP_TYPE[Number(it.type)] === 'SSS');
  const goalItem = [...items].reverse().find((it) => GOAL_TYPES.has(Number(it.type))) ?? items[items.length - 1];
  const gate = localHhmmToGate(sssItem?.tptime, utcOffsetSec);
  const deadline = localHhmmToGate(goalItem?.tptime, utcOffsetSec);

  return {
    version: 1,
    taskType: 'CLASSIC',
    turnpoints,
    sss: { type: 'RACE', direction: 'EXIT', timeGates: gate ? [gate] : [] },
    goal: {
      type: goalIsLine || Number(goalItem?.type) === 6 ? 'LINE' : 'CYLINDER',
      ...(deadline ? { deadline } : {}),
    },
    earthModel: 'WGS84',
  };
}

// ---- track JSON -> IGC ----------------------------------------------------

/** 38.5408 -> "3832448N" (DDMMmmm + hemisphere). */
function igcLat(lat) {
  const abs = Math.abs(lat);
  const deg = Math.floor(abs);
  const min = Math.round((abs - deg) * 60000);
  return `${pad(deg)}${pad(min, 5)}${lat < 0 ? 'S' : 'N'}`;
}

/** -112.0735 -> "11204412W" (DDDMMmmm + hemisphere). */
function igcLon(lon) {
  const abs = Math.abs(lon);
  const deg = Math.floor(abs);
  const min = Math.round((abs - deg) * 60000);
  return `${pad(deg, 3)}${pad(min, 5)}${lon < 0 ? 'W' : 'E'}`;
}

/**
 * Track points [lat, lon, alt, tLocalSec, ground, agl] -> IGC text. `date` is
 * the task's local date; the first fix's UTC date goes into HFDTE.
 */
function trackToIgc(points, pilot, date, utcOffsetSec) {
  const dayStartMs = Date.parse(`${date}T00:00:00Z`);
  const fixes = points
    .filter((p) => Array.isArray(p) && p.length >= 4 && p[0] != null && p[1] != null && p[3] != null)
    .map((p) => ({
      ms: dayStartMs + (Number(p[3]) - utcOffsetSec) * 1000,
      lat: Number(p[0]),
      lon: Number(p[1]),
      alt: Math.round(Number(p[2]) || 0),
    }));
  if (fixes.length === 0) return null;

  const first = new Date(fixes[0].ms);
  const hfdte = `${pad(first.getUTCDate())}${pad(first.getUTCMonth() + 1)}${pad(first.getUTCFullYear() % 100)}`;
  const lines = [
    'AXFMFLYMASTER LIVETRACK',
    `HFDTE${hfdte}`,
    'HFFXA010',
    `HFPLTPILOT:${pilot.name}`,
    `HFGTYGLIDERTYPE:${pilot.glider ?? ''}`,
    `HFCIDCOMPETITIONID:${pilot.id}`,
    'HFDTM100GPSDATUM:WGS-1984',
    'HFRFWFIRMWAREVERSION:lt.flymaster.net bsGetPilotTrack',
  ];
  for (const f of fixes) {
    const d = new Date(f.ms);
    const alt = pad(Math.max(-9999, Math.min(99999, f.alt)), 5);
    lines.push(
      `B${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
        `${igcLat(f.lat)}${igcLon(f.lon)}A${alt}${alt}`,
    );
  }
  return lines.join('\r\n') + '\r\n';
}

const slug = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'pilot';

/** "2026-09-20" -> "Sep 20" (UTC-safe). */
function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return isNaN(d)
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---- main ------------------------------------------------------------------

function main() {
  const utcOffsetSec = parseUtcOffsetSeconds(getText(`${HOST}/bs.php?grp=${args.group}`));
  console.log(`Group ${args.group}: utc_offset ${utcOffsetSec / 3600} h`);

  let fallbackNum = 0;
  for (const taskId of args.taskIds) {
    const page = parseResultsPage(
      getText(`${HOST}/bsTaskResultsFiltered.php?idgroup=${args.group}&taskId=${taskId}`),
    );
    const geo = postJson('bsGetTaskGeo.php', { idgroup: args.group, taskId });
    if (Number(geo.rcode) !== 1) throw new Error(`bsGetTaskGeo: ${geo.msg ?? JSON.stringify(geo)}`);
    const xctsk = buildXcTask(geo, page.goalIsLine, utcOffsetSec);

    fallbackNum++;
    const num = page.taskNum ?? fallbackNum;
    const day = args.day ?? `day${num}`;
    const compLabel = args['comp-label'] ?? page.compLabel;
    const dayLabel = `Task ${num}${page.date ? ` — ${shortDate(page.date)}` : ''}`;
    const totalKm = (geo.items ?? []).reduce((s, it) => s + (Number(it.d) || 0), 0);
    const title = `${page.taskName || `Task ${num}`} — ${totalKm.toFixed(1)} km`;

    console.log(
      `\n• ${page.taskName} (task ${taskId}) ${page.date ?? ''} — ${compLabel}\n` +
        `    ${xctsk.turnpoints.length} turnpoints, ${totalKm.toFixed(1)} km, gate ${xctsk.sss.timeGates[0] ?? '?'}, ` +
        `deadline ${xctsk.goal.deadline ?? '?'}, goal ${xctsk.goal.type}, ${page.pilots.length} pilots`,
    );
    console.log(
      `    ${JSON.stringify(xctsk.turnpoints.map((t) => `${t.type ?? 'TP'}:${t.waypoint.name}@${t.radius}m`))}`,
    );
    if (!page.date) throw new Error('could not read the task date from the results page');

    if (args.dry) {
      console.log(`    [dry] would import -> public/archive/${args.comp}/${day}/`);
      continue;
    }

    const staging = mkdtempSync(join(tmpdir(), `flymaster-${taskId}-`));
    try {
      const taskPath = join(staging, 'task.xctsk');
      writeFileSync(taskPath, JSON.stringify(xctsk));

      let written = 0;
      for (const pilot of page.pilots) {
        const track = postJson('bsGetPilotTrack.php', {
          idgroup: args.group,
          taskId,
          compe_id: pilot.id,
        });
        const igc = trackToIgc(track.track ?? [], pilot, page.date, utcOffsetSec);
        if (!igc) {
          console.warn(`    ! ${pilot.name} (${pilot.id}): no track points (${pilot.flight || 'no flight'}) — skipped`);
          continue;
        }
        writeFileSync(join(staging, `${slug(pilot.name)}_${page.date}.${pilot.id}.igc`), igc);
        written++;
        process.stdout.write(`\r    tracks: ${written}/${page.pilots.length}`);
      }
      process.stdout.write('\n');
      if (written === 0) throw new Error('no pilot had a track');

      const archiveArgs = [
        join(ROOT, 'scripts', 'archive.mjs'),
        '--comp', args.comp,
        '--day', day,
        '--task', taskPath,
        '--igc', join(staging, '*.igc'),
        '--comp-label', compLabel,
        '--day-label', dayLabel,
        '--date', page.date,
        '--title', title,
        '--utc-offset', String(Math.round(utcOffsetSec / 60)),
      ];
      if (args.kind) archiveArgs.push('--kind', args.kind);
      execFileSync('node', archiveArgs, { stdio: 'inherit' });
    } finally {
      if (!args['keep-staging']) rmSync(staging, { recursive: true, force: true });
    }
  }

  console.log('\nDone.');
}

try {
  main();
} catch (e) {
  die(e.message);
}
