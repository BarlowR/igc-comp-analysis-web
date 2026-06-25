// Build-time endpoint: runs the analysis once per archived day (server-side)
// and emits the precomputed {table, climb, map} JSON. The client fetches this
// instead of downloading every IGC and re-running the analysis in the browser.
// The IGC/xctsk files stay in public/archive but are only read here, at build.
import type { APIRoute, GetStaticPaths } from 'astro';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../../../archive-manifest.json';
import { Competition, nameFromFile } from '../../../lib/competition';

interface Entry {
  comp: string;
  day: string;
  taskFile: string;
  igcFiles: string[];
  utcOffsetMinutes?: number | null;
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
  );
  for (const name of entry.igcFiles) {
    try {
      comp.addPilot(readFileSync(join(dir, name), 'utf8'), nameFromFile(name));
    } catch (err) {
      console.error(`[archive results] skipped ${entry.comp}/${entry.day}/${name}:`, err);
    }
  }

  // NaN cells/metrics serialise to null; the renderer already treats non-finite
  // values as "no value", so this round-trips safely.
  const body = JSON.stringify({
    table: comp.buildStatsTable(),
    climb: comp.buildClimbData(),
    map: comp.buildMapData(),
  });
  return new Response(body, { headers: { 'content-type': 'application/json' } });
};
