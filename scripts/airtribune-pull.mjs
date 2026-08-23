#!/usr/bin/env node
/**
 * Pull tasks + tracklogs from an Airtribune event into the archive.
 *
 *   node scripts/airtribune-pull.mjs --slug ozone-chelan-open-2024 --comp chelan2024
 *   node scripts/airtribune-pull.mjs --slug us-open-paragliding-2024 --only-race 6476 --dry
 *
 * Airtribune (airtribune.com) hosts the US comps that predate AirScore
 * coverage (pre-2024 US Open / Ozone Chelan / Red Rocks). No login needed:
 *   - GET /<slug>/                      -> the event page embeds window.ATDATA
 *                                          with `contestId` and `blog`, an array
 *                                          of day entries: topWidget.raceId,
 *                                          date, timeoffset (seconds), and
 *                                          tracks.inner[0].url — a direct IGC
 *                                          zip on airtribune's DO spaces.
 *   - GET /api/contest/<cid>/tasks/<raceId>
 *                                       -> task JSON: checkpoints[] (lat/lon/
 *                                          radius/type to|ss|tp|es|goal,
 *                                          checked_on enter|exit|line) plus
 *                                          window_open/start_time/deadline as
 *                                          UTC ISO strings. We reconstruct a
 *                                          .xctsk from it.
 * Each task is handed to scripts/archive.mjs (copies files, writes meta.json,
 * rebuilds src/archive-manifest.json) — same flow as airscore-pull.mjs.
 *
 * Unlike AirScore, all times here are already UTC; `timeoffset` seconds give
 * the task-local display offset. Goals can be lines (checked_on 'line') —
 * emitted as goal.type LINE.
 *
 * The IGC zips live on airtribune.fra1.digitaloceanspaces.com — add that host
 * (or run outside the sandbox) when pulling.
 *
 * Flags:
 *   --slug <s>        (required) event slug, e.g. ozone-chelan-open-2024
 *   --comp <slug>     archive comp slug (default: the event slug)
 *   --comp-label <s>  override the human comp label (default: event title)
 *   --only-race <id>  import just this raceId (repeatable)
 *   --kind <k>        task kind passed to archive.mjs (default xc)
 *   --host <url>      base URL (default: https://airtribune.com)
 *   --dry             print the plan without downloading or writing
 *   --keep-staging    don't delete the temp download dir (for debugging)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HOST = 'https://airtribune.com';

// ---- args ------------------------------------------------------------------

function parseArgs(argv) {
  const out = { onlyRace: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'dry' || key === 'keep-staging') {
      out[key] = true;
      continue;
    }
    const val = argv[++i];
    if (key === 'only-race') out.onlyRace.push(String(val));
    else out[key] = val;
  }
  return out;
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.slug) die('--slug <event-slug> is required (e.g. --slug ozone-chelan-open-2024).');
const HOST = (args.host ?? DEFAULT_HOST).replace(/\/$/, '');

// ---- fetch helpers ---------------------------------------------------------
// curl, not node fetch: curl honors HTTPS_PROXY (needed inside the sandbox).

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
    execFileSync('curl', ['-fsSL', '--max-time', '300', '-o', dest, url]);
  } catch (e) {
    throw new Error(`GET ${url} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}

// ---- event page parsing ----------------------------------------------------

/** Bracket-match a JSON array starting at html[start] ('['). */
function readJsonArray(html, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('unterminated JSON array');
}

const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();

/** The event page -> { contestId, title, entries: [{raceId, date, timeoffset, zipUrl, title}] }. */
function parseEventPage(html) {
  const cid = html.match(/contestId["']?\s*[:=]\s*["']?(\d+)/)?.[1];
  if (!cid) throw new Error('no contestId on the event page — wrong slug?');
  const title = decodeEntities(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');

  // The array shows up either inline in an ATDATA JSON blob ("blog": [...])
  // or as a script assignment (window.ATDATA.blog = [...]); some pages carry
  // an unrelated "blog" meta object too — try every candidate site.
  let blog = null;
  for (const m of html.matchAll(/blog["']?\s*[:=]\s*\[/g)) {
    try {
      const arr = readJsonArray(html, m.index + m[0].length - 1);
      if (Array.isArray(arr) && arr.some((e) => e?.topWidget)) {
        blog = arr;
        break;
      }
    } catch {
      /* not this one */
    }
  }
  if (!blog) throw new Error('no blog data on the event page');

  const entries = blog
    .filter((e) => e?.topWidget?.type === 'task' && e.topWidget.raceId)
    .map((e) => ({
      raceId: String(e.topWidget.raceId),
      date: e.date ?? null,
      timeoffset: Number(e.timeoffset ?? 0),
      zipUrl: e.tracks?.inner?.[0]?.url ?? null,
      title: decodeEntities(e.title),
    }))
    // The blog lists newest first; import oldest first so day numbering reads naturally.
    .reverse();
  return { contestId: cid, title, entries };
}

// ---- reconstruct .xctsk from the task JSON ---------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** "2024-06-24T21:00:00" (UTC, naive) -> "21:00:00Z". */
function isoToGate(iso) {
  const m = String(iso ?? '').match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}Z` : null;
}

const CP_TYPE = { to: 'TAKEOFF', ss: 'SSS', es: 'ESS' };

function buildXcTask(task) {
  const turnpoints = (task.checkpoints ?? []).map((cp, i) => {
    const type = CP_TYPE[cp.type] ?? null; // tp/goal carry no type in .xctsk
    const waypoint = {
      lon: Number(cp.lon),
      lat: Number(cp.lat),
      altSmoothed: Math.round(Number(cp.alt) || 0),
      name: cp.name ?? `TP${i}`,
      description: '',
    };
    const radius = Math.round(Number(cp.radius) || (type === 'TAKEOFF' ? 1 : 400));
    return type ? { radius, waypoint, type } : { radius, waypoint };
  });

  const goalCp = (task.checkpoints ?? []).find((cp) => cp.is_goal);
  const gate = isoToGate(task.start_time);

  return {
    version: 1,
    taskType: 'CLASSIC',
    turnpoints,
    sss: {
      type: String(task.type).toLowerCase().includes('elapsed') ? 'ELAPSED-TIME' : 'RACE',
      direction: 'EXIT',
      timeGates: gate ? [gate] : [],
    },
    goal: {
      type: goalCp?.checked_on === 'line' ? 'LINE' : 'CYLINDER',
      ...(task.deadline ? { deadline: isoToGate(task.deadline) } : {}),
    },
    earthModel: 'WGS84',
  };
}

/** "2024-06-29" -> "Jun 29" (UTC-safe). */
function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return isNaN(d)
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---- main ------------------------------------------------------------------

function main() {
  const { contestId, title, entries } = parseEventPage(getText(`${HOST}/${args.slug}/`));
  if (entries.length === 0) die(`no task entries in ${HOST}/${args.slug}/`);

  const wanted = args.onlyRace.length
    ? entries.filter((e) => args.onlyRace.includes(e.raceId))
    : entries;
  if (wanted.length === 0)
    die(`--only-race ${args.onlyRace.join(',')} matched none of: ${entries.map((e) => e.raceId).join(', ')}`);

  const compSlug = args.comp ?? args.slug;
  const compLabel = args['comp-label'] ?? title;
  console.log(`Event ${args.slug} (contest ${contestId}): ${title}`);
  console.log(`  archive slug: ${compSlug}   races: ${wanted.map((e) => e.raceId).join(', ')}`);

  let fallbackNum = 0;
  for (const entry of wanted) {
    const task = JSON.parse(getText(`${HOST}/api/contest/${contestId}/tasks/${entry.raceId}`));
    const xctsk = buildXcTask(task);

    // "Day 7 — Task 4 — 61.5 km" -> 4. Falls back to import order.
    fallbackNum++;
    const num =
      (entry.title.match(/task\s*(\d+)/i) ?? String(task.title ?? '').match(/task\s*(\d+)/i))?.[1] ??
      fallbackNum;
    const day = `day${num}`;
    const dayLabel = `Task ${num}${entry.date ? ` — ${shortDate(entry.date)}` : ''}`;

    console.log(
      `\n• Task ${num} (race ${entry.raceId}): "${entry.title}" ${entry.date ?? ''} — ` +
        `${xctsk.turnpoints.length} turnpoints, gate ${xctsk.sss.timeGates[0] ?? '?'}` +
        `${xctsk.goal.type === 'LINE' ? ', goal LINE' : ''}`,
    );
    if (!entry.zipUrl) {
      console.warn('    ! no IGC zip on this entry — skipped');
      continue;
    }

    if (args.dry) {
      console.log(`    [dry] would import -> public/archive/${compSlug}/${day}/`);
      console.log(
        `    ${JSON.stringify(xctsk.turnpoints.map((t) => `${t.type ?? 'TP'}:${t.waypoint.name}@${t.radius}m`))}`,
      );
      continue;
    }

    const staging = mkdtempSync(join(tmpdir(), `airtribune-${entry.raceId}-`));
    try {
      const taskPath = join(staging, 'task.xctsk');
      writeFileSync(taskPath, JSON.stringify(xctsk));

      const zipPath = join(staging, 'igc.zip');
      // Some zip URLs contain literal spaces ("…igc5961_2024-06-16 (1).zip").
      download(encodeURI(entry.zipUrl), zipPath);
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
        '--utc-offset', String(Math.round(entry.timeoffset / 60)),
      ];
      if (entry.date) archiveArgs.push('--date', entry.date);
      if (entry.title) archiveArgs.push('--title', entry.title);
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
