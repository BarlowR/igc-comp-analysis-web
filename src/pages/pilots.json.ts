// Build-time endpoint: the pilot roster for the whole archive.
//
// Who flew which task is only knowable by opening the IGC files, so it is
// computed once here rather than in the browser. The account page fetches this
// to offer "which of these is you?" and to list the tasks a claimed pilot flew.
//
// Only the header of each IGC is read (a few KB off the front), not the whole
// file — the roster needs the pilot name and nothing else, and the archive is
// ~560 MB.
import type { APIRoute } from 'astro';
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../archive-manifest.json';
import { nameFromFile } from '../lib/competition';
import { pilotNameFromHeader } from '../lib/igc';
import { cleanPilotLabel, slugifyPilot } from '../lib/pilots';
import type { Roster, RosterDay, RosterPilot } from '../lib/roster';

interface Entry {
  comp: string;
  compLabel?: string;
  day: string;
  dayLabel?: string;
  date?: string;
  igcFiles: string[];
  hidden?: boolean;
}

/** Enough to clear the H-record block of any IGC we've seen. */
const HEADER_BYTES = 8192;

function readHeader(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const read = readSync(fd, buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, read).toString('latin1');
  } finally {
    closeSync(fd);
  }
}

export const GET: APIRoute = () => {
  const entries = (manifest as unknown as Entry[]).filter((e) => !e.hidden);

  const days: RosterDay[] = [];
  // key -> pilot; labels collide across spellings, so the key wins and we keep
  // the longest label seen (usually the one with proper capitalisation).
  const pilots = new Map<string, RosterPilot>();

  for (const entry of entries) {
    const dayIndex = days.length;
    days.push({
      comp: entry.comp,
      compLabel: entry.compLabel ?? entry.comp,
      day: entry.day,
      dayLabel: entry.dayLabel ?? entry.day,
      date: entry.date ?? null,
    });

    const dir = join(process.cwd(), 'public', 'archive', entry.comp, entry.day);
    for (const file of entry.igcFiles) {
      let displayed: string;
      try {
        // Same rule as IgcFlight: the header name if there is one, else the
        // filename — so these keys match the names shown on the day page.
        displayed = pilotNameFromHeader(readHeader(join(dir, file))) ?? nameFromFile(file);
      } catch (err) {
        console.error(`[roster] skipped ${entry.comp}/${entry.day}/${file}:`, err);
        continue;
      }

      const key = slugifyPilot(displayed);
      if (!key) continue; // blank/unkeyable name — not claimable

      const label = cleanPilotLabel(displayed);
      const existing = pilots.get(key);
      if (!existing) {
        pilots.set(key, { key, label, flights: [dayIndex] });
      } else {
        if (label.length > existing.label.length) existing.label = label;
        // A pilot can have two files in one day (relights); list the day once.
        if (existing.flights[existing.flights.length - 1] !== dayIndex) {
          existing.flights.push(dayIndex);
        }
      }
    }
  }

  const roster: Roster = {
    days,
    pilots: [...pilots.values()].sort((a, b) => a.label.localeCompare(b.label)),
  };
  return new Response(JSON.stringify(roster), {
    headers: { 'content-type': 'application/json' },
  });
};
