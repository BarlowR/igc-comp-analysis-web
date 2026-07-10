#!/usr/bin/env node
/**
 * Pull tasks + tracklogs straight from an AirScore instance into the archive.
 *
 *   node scripts/airscore-pull.mjs --comp-id 199
 *   node scripts/airscore-pull.mjs --comp-id 199 --comp canadian-nats-2026
 *   node scripts/airscore-pull.mjs --comp-id 199 --only-task 488
 *   node scripts/airscore-pull.mjs --comp-id 199 --dry        # show what it'd do
 *
 * How it works (no login required — reads the public result pages):
 *   - GET /competition/<id>            -> comp name/site + the task ids
 *   - GET /task_result/<taskId>        -> HTML embeds `populate_task({...})`,
 *                                         a JSON blob with `info` (task type,
 *                                         start gate, time offset, deadline) and
 *                                         `route` (the turnpoint cylinders).
 *                                         We reconstruct a `.xctsk` from it.
 *   - GET /download/igc_zip/<taskId>   -> a zip of every pilot's .igc. Unzipped
 *                                         into a staging dir.
 * Each task is then imported via scripts/archive.mjs (which copies files into
 * public/archive/<comp>/day<n>/, writes meta.json, and rebuilds the manifest).
 *
 * AirScore start-gate/deadline times are LOCAL (info.time_offset, e.g.
 * "-6:00:00"); they're converted to UTC in the .xctsk `sss.timeGates` /
 * `goal.deadline` so they line up with the IGC's UTC fix times. `utcOffsetMinutes`
 * is passed to the archiver for task-local time display.
 *
 * Flags:
 *   --comp-id <n>     (required) AirScore competition id, e.g. 199
 *   --comp <slug>     archive comp slug (default: derived from the comp name)
 *   --host <url>      AirScore base URL (default: https://airscore.fai.org)
 *   --only-task <id>  import just this AirScore task id (repeatable)
 *   --comp-label <s>  override the human comp label
 *   --dry             print the plan without downloading or writing
 *   --keep-staging    don't delete the temp download dir (for debugging)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HOST = 'https://airscore.fai.org';

// ---- args ------------------------------------------------------------------

function parseArgs(argv) {
  const out = { onlyTask: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'dry' || key === 'keep-staging') {
      out[key] = true;
      continue;
    }
    const val = argv[++i];
    if (key === 'only-task') out.onlyTask.push(String(val));
    else out[key] = val;
  }
  return out;
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args['comp-id']) die('--comp-id <n> is required (e.g. --comp-id 199).');
const HOST = (args.host ?? DEFAULT_HOST).replace(/\/$/, '');
const COMP_ID = String(args['comp-id']);

// ---- small parsers ---------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** "6.0 Km" / "400 m &nbsp;" -> meters (integer). "" -> null. */
function parseRadius(s) {
  if (!s) return null;
  const t = String(s).replace(/&nbsp;/gi, '').trim();
  const m = t.match(/([\d.]+)\s*(k?m)/i);
  if (!m) return Number(t) || null;
  const v = parseFloat(m[1]);
  return Math.round(/km/i.test(m[2]) ? v * 1000 : v);
}

/** "-6:00:00" -> minutes to add to UTC to get local time (e.g. -360). */
function offsetToMinutes(s) {
  const m = String(s ?? '').match(/^(-?)(\d+):(\d+)(?::(\d+))?$/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/** local "13:30:00" + offset minutes -> UTC "19:30:00Z". */
function localToUtcGate(local, offMin) {
  const [h, mm, ss = 0] = String(local).split(':').map((p) => parseInt(p, 10) || 0);
  let sec = h * 3600 + mm * 60 + ss - offMin * 60; // UTC = local - offset
  sec = ((sec % 86400) + 86400) % 86400;
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}Z`;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "2026-07-05" -> "Jul 5" (UTC-safe). */
function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return isNaN(d) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---- fetch helpers ---------------------------------------------------------
// Uses curl rather than node's fetch: curl honors HTTPS_PROXY (needed inside the
// sandbox) and works unchanged outside it. `-f` makes HTTP errors non-zero exit.

function getText(url) {
  try {
    return execFileSync('curl', ['-fsSL', '--max-time', '60', url], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`GET ${url} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}

function download(url, dest) {
  try {
    execFileSync('curl', ['-fsSL', '--max-time', '180', '-o', dest, url]);
  } catch (e) {
    throw new Error(`GET ${url} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}

/** Pull the JSON argument out of `populate_task({...})` in a task_result page. */
function extractTaskData(html) {
  const m = html.match(/populate_task\((\{[\s\S]*?\})\)\s*<\/script>/);
  if (!m) throw new Error('could not find populate_task(...) in the task page');
  return JSON.parse(m[1]);
}

// ---- reconstruct .xctsk from AirScore route + info -------------------------

const TASK_TYPE = { race: 'RACE', elapsed: 'ELAPSED-TIME', time: 'ELAPSED-TIME' };

function buildXcTask(data) {
  const info = data.info ?? {};
  const offMin = offsetToMinutes(info.time_offset);

  const turnpoints = (data.route ?? []).map((tp, i, arr) => {
    const t = String(tp.type ?? '').toLowerCase();
    let type = null;
    if (t === 'launch') type = 'TAKEOFF';
    else if (t === 'ss' || t === 'sss') type = 'SSS';
    else if (t === 'es' || t === 'ess') type = 'ESS';
    // '' (regular) and 'goal' carry no `type` in XContest .xctsk files.

    // launch cylinders sometimes report no radius; a nominal value is harmless.
    const radius = parseRadius(tp.radius) ?? (type === 'TAKEOFF' ? 1 : 400);

    const waypoint = {
      lon: Number(tp.lon),
      lat: Number(tp.lat),
      altSmoothed: Math.round(Number(tp.altitude) || 0),
      name: tp.name ?? `TP${i}`,
      description: tp.description ?? '',
    };
    return type ? { radius, waypoint, type } : { radius, waypoint };
  });

  const gates = (info.startgates?.length ? info.startgates : [info.start_time])
    .filter(Boolean)
    .map((g) => localToUtcGate(g, offMin));

  return {
    version: 1,
    taskType: 'CLASSIC',
    turnpoints,
    sss: {
      type: TASK_TYPE[String(info.task_type).toLowerCase()] ?? 'RACE',
      direction: 'EXIT',
      timeGates: gates,
    },
    goal: {
      type: 'CYLINDER',
      ...(info.task_deadline ? { deadline: localToUtcGate(info.task_deadline, offMin) } : {}),
    },
    earthModel: 'WGS84',
  };
}

// ---- main ------------------------------------------------------------------

function main() {
  // 1. Competition page -> task ids. AirScore serves two variants of this page:
  // a final-results view linking /task_result/<id> and a live view linking
  // /live/<id>; either may lag the other, so union both (order preserved).
  const compHtml = getText(`${HOST}/competition/${COMP_ID}`);
  const taskIds = [
    ...new Set([...compHtml.matchAll(/\/(?:task_result|live)\/(\d+)/g)].map((m) => m[1])),
  ];
  if (taskIds.length === 0) die(`no tasks found on ${HOST}/competition/${COMP_ID}`);

  const wanted = args.onlyTask.length ? taskIds.filter((id) => args.onlyTask.includes(id)) : taskIds;
  if (wanted.length === 0) die(`--only-task ${args.onlyTask.join(',')} matched none of: ${taskIds.join(', ')}`);

  // Fetch each task's result page up front, skipping tasks that aren't scored
  // yet (their page has no populate_task blob). This also gives us the comp name.
  const tasks = [];
  for (const taskId of wanted) {
    let data;
    try {
      data = extractTaskData(getText(`${HOST}/task_result/${taskId}`));
    } catch (e) {
      console.warn(`  ! skipping task ${taskId}: ${e.message}`);
      continue;
    }
    tasks.push({ taskId, data });
  }
  if (tasks.length === 0) die('none of the tasks are scored yet (no results to import).');

  const compName = tasks[0].data.info?.comp_name ?? `comp-${COMP_ID}`;
  const compSite = tasks[0].data.info?.comp_site ?? '';
  const compSlug = args.comp ?? slugify(compName);
  const compLabel = args['comp-label'] ?? compName;

  console.log(`Competition ${COMP_ID}: ${compName}${compSite ? ` (${compSite})` : ''}`);
  console.log(`  archive slug: ${compSlug}   tasks: ${tasks.map((t) => t.taskId).join(', ')}${tasks.length < taskIds.length ? ` (of ${taskIds.length})` : ''}`);

  for (const { taskId, data } of tasks) {
    const info = data.info ?? {};
    const num = info.task_num ?? taskId;
    const day = `day${num}`;
    const dayLabel = `Task ${num}${info.date ? ` — ${shortDate(info.date)}` : ''}`;
    const xctsk = buildXcTask(data);

    console.log(
      `\n• Task ${num} (airscore id ${taskId}): "${info.task_name ?? ''}" ${info.date ?? ''} — ` +
        `${xctsk.turnpoints.length} turnpoints, gate ${xctsk.sss.timeGates[0] ?? '?'}`,
    );

    if (args.dry) {
      console.log(`    [dry] would import -> public/archive/${compSlug}/${day}/`);
      console.log(`    ${JSON.stringify(xctsk.turnpoints.map((t) => `${t.type ?? 'TP'}:${t.waypoint.name}@${t.radius}m`))}`);
      continue;
    }

    const staging = mkdtempSync(join(tmpdir(), `airscore-${taskId}-`));
    try {
      // task.xctsk
      const taskPath = join(staging, 'task.xctsk');
      writeFileSync(taskPath, JSON.stringify(xctsk));

      // igc zip -> unzip into staging
      const zipPath = join(staging, 'igc.zip');
      download(`${HOST}/download/igc_zip/${taskId}`, zipPath);
      execFileSync('unzip', ['-o', '-q', '-j', zipPath, '-d', staging]);
      const igcCount = readdirSync(staging).filter((f) => f.toLowerCase().endsWith('.igc')).length;
      if (igcCount === 0) throw new Error('igc zip contained no .igc files');

      // Import via the existing archiver (copies files, writes meta, rebuilds manifest).
      const archiveArgs = [
        join(ROOT, 'scripts', 'archive.mjs'),
        '--comp', compSlug,
        '--day', day,
        '--task', taskPath,
        '--igc', join(staging, '*.igc'),
        '--comp-label', compLabel,
        '--day-label', dayLabel,
        '--utc-offset', String(offsetToMinutes(info.time_offset)),
      ];
      if (info.date) archiveArgs.push('--date', info.date);
      if (info.task_name) archiveArgs.push('--title', info.task_name);

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
