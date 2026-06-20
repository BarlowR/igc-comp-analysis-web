#!/usr/bin/env node
/**
 * Import an analyzed task into the archive.
 *
 *   npm run archive -- --comp chelan2026 --day day1 \
 *     --task path/to.xctsk --igc 'path/to/*.igc' \
 *     [--comp-label "Chelan Ozone Open 2026"] [--day-label "Day 1 — Fri"] \
 *     [--date 2026-06-19] [--title "..."] [--notes "..."]
 *
 * Copies the task + tracklogs into public/archive/<comp>/<day>/, writes a
 * meta.json, and rebuilds src/archive-manifest.json. --igc may be repeated and
 * accepts globs.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, globSync, readdirSync, statSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_DIR = join(ROOT, 'public', 'archive');
const MANIFEST = join(ROOT, 'src', 'archive-manifest.json');

function parseArgs(argv) {
  const out = { igc: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    i++;
    if (key === 'igc') out.igc.push(val);
    else out[key] = val;
  }
  return out;
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

/** "chelan2026" -> "Chelan Ozone Open 2026", "day2" -> "Day 2". */
function prettify(s) {
  return s
    .replace(/[-_]/g, ' ')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

const args = parseArgs(process.argv.slice(2));
if (!args.comp || !args.day) die('--comp and --day are required.');
if (!args.task) die('--task <file.xctsk> is required.');
if (args.igc.length === 0) die('at least one --igc <glob> is required.');

// Resolve IGC globs/paths.
const igcPaths = [...new Set(args.igc.flatMap((p) => (globSync(p).length ? globSync(p) : existsSync(p) ? [p] : [])))].sort();
if (igcPaths.length === 0) die('no IGC files matched.');
if (!existsSync(args.task)) die(`task file not found: ${args.task}`);

// Validate the task is a sane XContest task.
try {
  const task = JSON.parse(readFileSync(args.task, 'utf8'));
  if (!Array.isArray(task.turnpoints) || task.turnpoints.length === 0) {
    die('task file has no turnpoints — is it a valid .xctsk?');
  }
} catch (e) {
  die(`task file is not valid JSON: ${e.message}`);
}

// Copy into public/archive/<comp>/<day>/.
const destDir = join(ARCHIVE_DIR, args.comp, args.day);
mkdirSync(destDir, { recursive: true });
copyFileSync(args.task, join(destDir, 'task.xctsk'));

const igcFiles = [];
for (const p of igcPaths) {
  const name = basename(p);
  copyFileSync(p, join(destDir, name));
  igcFiles.push(name);
}

const meta = {
  comp: args.comp,
  compLabel: args['comp-label'] ?? prettify(args.comp),
  day: args.day,
  dayLabel: args['day-label'] ?? prettify(args.day),
  ...(args.date ? { date: args.date } : {}),
  ...(args.title ? { title: args.title } : {}),
  ...(args.notes ? { notes: args.notes } : {}),
  taskFile: 'task.xctsk',
  igcFiles,
};
writeFileSync(join(destDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

rebuildManifest();
console.log(`Archived ${args.comp}/${args.day}: ${igcFiles.length} tracklogs -> ${destDir}`);
console.log('Updated src/archive-manifest.json');

/** Scan public/archive/<comp>/<day>/meta.json into the manifest. */
function rebuildManifest() {
  const entries = [];
  if (existsSync(ARCHIVE_DIR)) {
    for (const comp of dirsIn(ARCHIVE_DIR)) {
      for (const day of dirsIn(join(ARCHIVE_DIR, comp))) {
        const metaPath = join(ARCHIVE_DIR, comp, day, 'meta.json');
        if (existsSync(metaPath)) entries.push(JSON.parse(readFileSync(metaPath, 'utf8')));
      }
    }
  }
  entries.sort(
    (a, b) =>
      a.comp.localeCompare(b.comp) ||
      (a.date ?? '').localeCompare(b.date ?? '') ||
      a.day.localeCompare(b.day),
  );
  writeFileSync(MANIFEST, JSON.stringify(entries, null, 2) + '\n');
}

function dirsIn(dir) {
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
}
