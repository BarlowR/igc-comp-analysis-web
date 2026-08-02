#!/usr/bin/env node
/**
 * Crawl tasks + tracklogs from xcdemon.com into the archive.
 *
 *   node scripts/xcdemon-crawl.mjs                        # both leagues, recent years
 *   node scripts/xcdemon-crawl.mjs --leagues 16 --years 2025
 *   node scripts/xcdemon-crawl.mjs --only-task 582        # just this task id
 *   node scripts/xcdemon-crawl.mjs --dry                  # show the plan
 *
 * How it works (no login — reads the public results/task pages):
 *   - GET index.php?leagueappid=<L>&id=results&year=<Y>
 *       -> lists each scored task's igc zip: tracklogs/<L>/<season>/<task>/
 *          <date>_<task>-igcs.zip. That one line gives league, season, task id
 *          and date. The task-result page URL is built from season + task id.
 *   - GET results_task.php?leagueappid=<L>&task_id=<task>
 *       -> has an <h4> summary ("<date> - <site> - Race to Goal <km>km") and a
 *          turnpoint table. xcdemon has NO native .xctsk, so we reconstruct one
 *          from that table. Its columns are read by HEADER, not position: the
 *          NorCal leagues order them No./Dist./Id/Radius/Open/Close/Coordinates/
 *          Altitude and X Red Rocks No./Id - Description/Radius/Open/Close/Dist/
 *          Coordinates/Altitude. We fall back to the static per-season page
 *          tracklogs/<L>/<season>/task_result_<task>.html whenever the dynamic
 *          one yields no turnpoint table — including when it answers 200 with
 *          "task result not found", which is what it does for X Red Rocks.
 *   - GET tracklogs/<L>/<season>/<task>/<date>_<task>-igcs.zip
 *       -> a zip of every pilot's .igc, unzipped into a staging dir.
 * Each task is then imported via scripts/archive.mjs (copies files into
 * public/archive/<comp>/day<task>/, writes meta.json, rebuilds the manifest).
 *
 * xcdemon turnpoint Open/Close times are LOCAL to the league's site (see
 * LEAGUES `tz`); they're converted to UTC in the .xctsk `sss.timeGates` /
 * `goal.deadline` so they line up with the IGC's UTC fix times. The offset for
 * the date (e.g. -420 PDT, -360 MDT) is passed to the archiver for task-local
 * time display.
 *
 * Idempotent: by default a task whose archive dir already exists is skipped, so
 * re-running just picks up newly-scored tasks. Use --force to re-import.
 *
 * Flags:
 *   --leagues <ids>   comma list of leagueappids (default: 16,17)
 *   --years <years>   comma list of years (default: last two + current)
 *   --only-task <id>  import just this xcdemon task id (repeatable)
 *   --limit <n>       stop after importing n tasks (for testing)
 *   --kind <kind>     force the task kind (xc | hike-and-fly) instead of
 *                     reading it off the task title
 *   --force           re-import tasks even if their archive dir exists
 *   --host <url>      base URL (default: https://xcdemon.com)
 *   --dry             print the plan without downloading or writing
 *   --keep-staging    don't delete the temp download dir (for debugging)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_DIR = join(ROOT, 'public', 'archive');
const DEFAULT_HOST = 'https://xcdemon.com';
const TZ = 'America/Los_Angeles';

// The leagueappid IS the league. Other dropdown ids are unrelated leagues.
//
// One league page can span several of these: X Red Rocks is browsed under
// leagueappid 31, but its three divisions file their tracklogs under leagues 31,
// 32 and 40 (seasons 88/89/90). Discovery reads the league out of each task's
// zip URL, so the division a task belongs to — and therefore its comp slug — is
// whatever the link says, not the id that was asked for.
const LEAGUES = {
  16: { slug: 'norcal-xc', label: 'NorCal XC League' },
  17: { slug: 'norcal-sprint', label: 'NorCal Sprint League' },
  31: { slug: 'x-red-rocks', label: 'X Red Rocks', tz: 'America/Denver' },
  32: { slug: 'x-red-rocks-adventure', label: 'X Red Rocks Adventure', tz: 'America/Denver' },
  40: { slug: 'x-red-rocks-challenge', label: 'X Red Rocks Challenge', tz: 'America/Denver' },
};

// xcdemon task titles mis-label the site (e.g. a Dunlap task titled "Mt Vaca").
// The SSS turnpoint is the real launch and matches the IGC tracks, so the site
// is named from the SSS waypoint code. Add codes here as new launches appear.
const LAUNCH_SITES = {
  DNLNCH: 'Dunlap',
  TOLLLN: 'Tollhouse',
  SKNOB: 'Tollhouse',
  POTLAU: 'Potato Hill',
  SLIDE: 'Slide Mountain',
  FLNLNC: 'Owens Valley',
  PAIUTE: 'Owens Valley',
};

// ---- args ------------------------------------------------------------------

function parseArgs(argv) {
  const out = { onlyTask: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'dry' || key === 'keep-staging' || key === 'force') {
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
const HOST = (args.host ?? DEFAULT_HOST).replace(/\/$/, '');
const LEAGUE_IDS = (args.leagues ?? '16,17').split(',').map((s) => s.trim()).filter(Boolean);
const CURRENT_YEAR = new Date().getUTCFullYear();
const YEARS = (args.years ?? `${CURRENT_YEAR - 2},${CURRENT_YEAR - 1},${CURRENT_YEAR}`)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
// Validated here rather than left to archive.mjs, which only sees it after the
// task page and the whole tracklog zip have been downloaded.
if (args.kind && !['xc', 'hike-and-fly'].includes(args.kind)) {
  die('--kind must be xc or hike-and-fly.');
}

// ---- small parsers ---------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** "1000m" / "400 m" / "10.0 km" -> meters (integer). "" -> null. */
function parseRadius(s) {
  if (!s) return null;
  const t = String(s).replace(/&nbsp;/gi, '').trim();
  const m = t.match(/([\d.]+)\s*(k?m)/i);
  if (!m) return Number(t) || null;
  const v = parseFloat(m[1]);
  return Math.round(/km/i.test(m[2]) ? v * 1000 : v);
}

/** "1415m" -> 1415 (integer). */
function parseAlt(s) {
  const m = String(s ?? '').match(/(-?[\d.]+)/);
  return m ? Math.round(parseFloat(m[1])) : 0;
}

/** "36.76511, -119.09796" -> { lat, lon }. */
function parseCoords(s) {
  const m = String(s ?? '').match(/(-?[\d.]+)\s*,\s*(-?[\d.]+)/);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : { lat: 0, lon: 0 };
}

/**
 * Minutes to ADD to UTC to get local time in `tz` on `isoDate` (e.g. -420 for
 * PDT). Uses the actual DST rules for the date, so spring/fall tasks differ.
 */
function tzOffsetMinutes(isoDate, tz = TZ) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local - utc) / 60000);
}

/** local "11:50"(:ss) + offset minutes -> UTC "18:50:00Z". */
function localToUtcGate(local, offMin) {
  const [h, mm, ss = 0] = String(local).split(':').map((p) => parseInt(p, 10) || 0);
  let sec = h * 3600 + mm * 60 + ss - offMin * 60; // UTC = local - offset
  sec = ((sec % 86400) + 86400) % 86400;
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}Z`;
}

/** "2025-04-19" -> "Apr 19" (UTC-safe). */
function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return isNaN(d) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---- fetch helpers ---------------------------------------------------------
// Uses curl rather than node's fetch: curl honors HTTPS_PROXY (needed inside the
// sandbox) and works unchanged outside it. `-f` makes HTTP errors non-zero exit.

function getText(url) {
  return execFileSync('curl', ['-fsSL', '--max-time', '60', url], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function download(url, dest) {
  execFileSync('curl', ['-fsSL', '--max-time', '180', '-o', dest, url]);
}

// ---- HTML table parsing ----------------------------------------------------

const stripTags = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

/** Which field a turnpoint-table heading holds. Unrecognised headings are ignored. */
function columnRole(heading) {
  const h = heading.toLowerCase();
  if (/^no\b/.test(h)) return 'no';
  if (/^id\b/.test(h)) return 'id'; // "Id", and X Red Rocks' "Id - Description"
  if (h.includes('radius')) return 'radius';
  if (h.includes('open')) return 'open';
  if (h.includes('close')) return 'close';
  if (h.includes('coordinate')) return 'coords';
  if (h.includes('altitude')) return 'alt';
  return null;
}

/**
 * Rows of the turnpoint table (the one whose header carries `No.`), keyed by
 * what each column holds rather than where it sits: the leagues don't agree on
 * the order (NorCal puts Dist. second, X Red Rocks sixth), and reading by
 * position silently mis-assigns radius, coordinates and gate times.
 */
function turnpointRows(html) {
  const marker = html.indexOf('>No.</th>');
  if (marker === -1) return [];
  // Back up to the table's own start so the header row is inside the segment.
  const start = html.lastIndexOf('<table', marker);
  const end = html.indexOf('</table>', marker);
  const seg = html.slice(start === -1 ? marker : start, end === -1 ? undefined : end);

  let cols = null;
  const out = [];
  for (const [, inner] of seg.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...inner.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => stripTags(m[1]));
    if (!cells.length) continue;
    if (!cols) {
      if (columnRole(cells[0]) !== 'no') continue; // not the header row yet
      cols = cells.map(columnRole);
      continue;
    }
    if (!/^\d/.test(cells[0])) continue; // a turnpoint row starts with its number
    const row = {};
    cols.forEach((role, i) => {
      if (role) row[role] = cells[i] ?? '';
    });
    if (row.no && row.coords) out.push(row);
  }
  return out;
}

/**
 * Turnpoint id cell -> waypoint name + description. NorCal gives a bare code
 * ("POTLAU"); X Red Rocks gives "L11 - Juncion Bailout".
 */
function splitId(cell) {
  const [code, ...rest] = String(cell ?? '').split(/\s+-\s+/);
  return { name: code.trim(), description: rest.join(' - ').trim() };
}

// ---- reconstruct .xctsk from the turnpoint table ---------------------------

/**
 * The `No.` cell flags the special turnpoints, and the leagues spell them
 * differently: NorCal writes "1 SS" / "8 ES", X Red Rocks "1 S-IN" (an entry
 * start) and "6 Goal", with no ES at all.
 */
const isStartRow = (r) => /\bSS\b|\bS-?(IN|OUT)\b/i.test(r.no);
const isEssRow = (r) => /\bES\b/i.test(r.no);

function buildTask(rows, offMin, taskType) {
  const tp = (r, type) => {
    const { lat, lon } = parseCoords(r.coords);
    const { name, description } = splitId(r.id);
    return {
      radius: parseRadius(r.radius) ?? 400,
      waypoint: { lon, lat, altSmoothed: parseAlt(r.alt), name, description },
      ...(type ? { type } : {}),
    };
  };

  const ssRow = rows.find(isStartRow);
  const goalRow = rows[rows.length - 1];
  // No ES row (X Red Rocks, and hike and fly generally): there is no ESS
  // cylinder before goal — the goal IS the finish — so none is written. The
  // analyzer finishes at the declared ESS and falls back to the last turnpoint
  // when a task doesn't name one (igc.ts trackTaskProgress), which is exactly
  // this case. Nothing is invented to stand in for it.
  const turnpoints = rows.map((r) => tp(r, isStartRow(r) ? 'SSS' : isEssRow(r) ? 'ESS' : undefined));

  // An entry start ("S-IN") is recorded as such, though the analyzer treats
  // every SSS the same way: enter the cylinder, then leave it.
  const direction = /\bS-?IN\b/i.test(ssRow?.no ?? '') ? 'ENTER' : 'EXIT';
  const gates = ssRow ? [localToUtcGate(ssRow.open, offMin)] : [];

  return {
    version: 1,
    taskType: 'CLASSIC',
    turnpoints,
    sss: { type: taskType, direction, timeGates: gates },
    goal: {
      type: 'CYLINDER',
      ...(goalRow?.close ? { deadline: localToUtcGate(goalRow.close, offMin) } : {}),
    },
    earthModel: 'WGS84',
  };
}

/**
 * "<date> - <site> - Race to Goal 85.9km" -> parts. The title is also where the
 * task kind comes from: X Red Rocks days are titled "... - Hike and Fly XC
 * Task", and there is nothing else on the page that says so. Anything that
 * doesn't announce itself is an XC comp (see src/lib/xctsk.ts TaskKind).
 */
function parseSummary(html) {
  const m = html.match(/<h4[^>]*>([^<]+)<\/h4>/);
  const text = m ? stripTags(m[1]) : '';
  const type = /elapsed/i.test(text) ? 'ELAPSED-TIME' : 'RACE';
  const kind = /hike\s*(?:and|&|\+)?\s*fly/i.test(text) ? 'hike-and-fly' : 'xc';
  return { title: text, type, kind };
}

// ---- discovery -------------------------------------------------------------

/** All scored tasks in a league-year, from the results page's igc-zip links. */
function discoverTasks(league, year) {
  let html;
  try {
    html = getText(`${HOST}/index.php?leagueappid=${league}&id=results&year=${year}`);
  } catch (e) {
    console.warn(`  ! ${league}/${year}: results page failed (${e.message.split('\n')[0]})`);
    return [];
  }
  const seen = new Set();
  const tasks = [];
  const re = /tracklogs\/(\d+)\/(\d+)\/(\d+)\/(\d{4}-\d{2}-\d{2})_\3-igcs\.zip/g;
  for (const m of html.matchAll(re)) {
    const [, lg, season, task, date] = m;
    if (seen.has(task)) continue;
    seen.add(task);
    tasks.push({ league: lg, season, task, date, year });
  }
  return tasks;
}

// ---- main ------------------------------------------------------------------

function main() {
  // 1. Discover every scored task across the requested leagues + years.
  let tasks = [];
  for (const league of LEAGUE_IDS) {
    if (!LEAGUES[league]) console.warn(`  ! league ${league} is unknown; using generic labels`);
    for (const year of YEARS) tasks.push(...discoverTasks(league, year));
  }
  if (args.onlyTask.length) tasks = tasks.filter((t) => args.onlyTask.includes(t.task));
  if (tasks.length === 0) die('no scored tasks found for the requested leagues/years.');

  tasks.sort((a, b) => a.date.localeCompare(b.date) || Number(a.task) - Number(b.task));
  console.log(`Found ${tasks.length} scored task(s): ${tasks.map((t) => t.task).join(', ')}`);

  let imported = 0;
  for (const t of tasks) {
    if (imported >= LIMIT) break;
    const meta = LEAGUES[t.league] ?? { slug: `league-${t.league}`, label: `League ${t.league}` };
    const compSlug = `${meta.slug}-${t.year}`;
    const compLabel = `${t.year} ${meta.label}`;
    const day = `day${t.task}`;
    const destDir = join(ARCHIVE_DIR, compSlug, day);

    if (!args.force && existsSync(destDir)) {
      console.log(`\n• Task ${t.task} (${t.date}) — already archived at ${compSlug}/${day}, skipping.`);
      continue;
    }

    // 2. Task-result page -> turnpoint table + summary. Try the dynamic PHP page
    // first (the only one 2026 links), then the static per-season page. The
    // fallback is driven by "did we get a turnpoint table", not by the HTTP
    // status: for X Red Rocks the PHP endpoint answers 200 with the body "task
    // result not found", which a status check would happily accept.
    const sources = [
      `${HOST}/results_task.php?leagueappid=${t.league}&task_id=${t.task}`,
      `${HOST}/tracklogs/${t.league}/${t.season}/task_result_${t.task}.html`,
    ];
    let html = null;
    let rows = [];
    for (const url of sources) {
      let body;
      try {
        body = getText(url);
      } catch {
        continue; // 404 or network error — try the next source
      }
      const found = turnpointRows(body);
      if (found.length >= 2) {
        html = body;
        rows = found;
        break;
      }
    }
    if (!html) {
      console.warn(`\n• Task ${t.task}: no turnpoint table on either result page, skipping.`);
      continue;
    }
    const { title, type, kind } = parseSummary(html);
    const taskKind = args.kind ?? kind;
    const offMin = tzOffsetMinutes(t.date, meta.tz ?? TZ);
    const xctsk = buildTask(rows, offMin, type);

    // Site name from the SSS waypoint code (titles mis-label it).
    const ssRow = rows.find(isStartRow);
    const site = LAUNCH_SITES[splitId(ssRow?.id).name] ?? (title.split(' - ')[1] || meta.label);
    const dayLabel = `${site} — ${shortDate(t.date)}`;

    console.log(
      `\n• Task ${t.task} (${t.date}) "${title}"\n` +
        `    ${compSlug}/${day} — ${xctsk.turnpoints.length} turnpoints, ${type}, ${taskKind}, ` +
        `gate ${xctsk.sss.timeGates[0] ?? '?'} (offset ${offMin}m)`,
    );

    if (args.dry) {
      console.log(`    [dry] site "${site}"; would import -> public/archive/${compSlug}/${day}/`);
      console.log(`    ${JSON.stringify(xctsk.turnpoints.map((tp) => `${tp.type ?? 'TP'}:${tp.waypoint.name}@${tp.radius}m`))}`);
      imported++;
      continue;
    }

    const staging = mkdtempSync(join(tmpdir(), `xcdemon-${t.task}-`));
    try {
      const taskPath = join(staging, 'task.xctsk');
      writeFileSync(taskPath, JSON.stringify(xctsk));

      const zipPath = join(staging, 'igc.zip');
      download(`${HOST}/tracklogs/${t.league}/${t.season}/${t.task}/${t.date}_${t.task}-igcs.zip`, zipPath);
      execFileSync('unzip', ['-o', '-q', '-j', zipPath, '-d', staging]);
      const igcCount = readdirSync(staging).filter((f) => f.toLowerCase().endsWith('.igc')).length;
      if (igcCount === 0) throw new Error('igc zip contained no .igc files');

      const archiveArgs = [
        join(ROOT, 'scripts', 'archive.mjs'),
        '--comp', compSlug,
        '--day', day,
        '--task', taskPath,
        '--igc', join(staging, '*.igc'),
        '--comp-label', compLabel,
        '--day-label', dayLabel,
        '--date', t.date,
        '--title', title,
        '--utc-offset', String(offMin),
        ...(taskKind === 'xc' ? [] : ['--kind', taskKind]),
      ];
      execFileSync('node', archiveArgs, { stdio: 'inherit' });
      imported++;
    } finally {
      if (!args['keep-staging']) rmSync(staging, { recursive: true, force: true });
    }
  }

  console.log(`\nDone. Imported ${imported} task(s).`);
}

try {
  main();
} catch (e) {
  die(e.message);
}
