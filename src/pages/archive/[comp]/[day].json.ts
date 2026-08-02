// Build-time endpoint: runs the analysis once per archived day (server-side)
// and emits the precomputed {table, climb, map} JSON. The client fetches this
// instead of downloading every IGC and re-running the analysis in the browser.
// The IGC/xctsk files stay in public/archive but are only read here, at build.
import type { APIRoute, GetStaticPaths } from 'astro';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../../../archive-manifest.json';
import { Competition, nameFromFile } from '../../../lib/competition';
import { parseTaskKind } from '../../../lib/xctsk';

interface Entry {
  comp: string;
  day: string;
  taskFile: string;
  igcFiles: string[];
  utcOffsetMinutes?: number | null;
  /** "xc" (default) or "hike-and-fly" — set by `npm run archive -- --kind`. */
  taskKind?: string;
}

export const getStaticPaths: GetStaticPaths = () =>
  (manifest as Entry[]).map((entry) => ({
    params: { comp: entry.comp, day: entry.day },
    props: { entry },
  }));

export const GET: APIRoute = ({ props }) => {
  const entry = props.entry as Entry;
  const dir = join(process.cwd(), 'public', 'archive', entry.comp, entry.day);

  const comp = new Competition(
    readFileSync(join(dir, entry.taskFile), 'utf8'),
    entry.utcOffsetMinutes ?? null,
    parseTaskKind(entry.taskKind),
  );
  for (const name of entry.igcFiles) {
    try {
      comp.addPilot(readFileSync(join(dir, name), 'utf8'), nameFromFile(name));
    } catch (err) {
      console.error(`[archive results] skipped ${entry.comp}/${entry.day}/${name}:`, err);
    }
  }

  // NaN cells/metrics serialise to null; the renderer already treats non-finite
  // values as "no value", so this round-trips safely. Which metrics and plots are
  // in here depends on the task kind — buildResults makes those choices, so the
  // upload page's live analysis gets the identical set (see runAnalysis).
  const body = JSON.stringify(comp.buildResults());
  return new Response(body, { headers: { 'content-type': 'application/json' } });
};
