// The archive-wide pilot roster: who flew which task.
//
// Built once at build time by src/pages/pilots.json.ts (which owns the types
// below) and fetched by the account page. ~21 KB for the current archive.
import { slugifyPilot } from './pilots';

export interface RosterPilot {
  key: string;
  label: string;
  /** Indices into Roster.days, in manifest order. */
  flights: number[];
}

export interface RosterDay {
  comp: string;
  compLabel: string;
  day: string;
  dayLabel: string;
  date: string | null;
}

export interface Roster {
  days: RosterDay[];
  pilots: RosterPilot[];
}

let cached: Promise<Roster> | null = null;

export function fetchRoster(): Promise<Roster> {
  cached ??= fetch('/pilots.json').then((res) => {
    if (!res.ok) throw new Error(`${res.status} fetching the pilot roster`);
    return res.json() as Promise<Roster>;
  });
  return cached;
}

/** The distinct comps a pilot appears in, in first-flown order. */
export function compsForPilot(roster: Roster, pilot: RosterPilot): RosterDay[] {
  const seen = new Set<string>();
  const out: RosterDay[] = [];
  for (const i of pilot.flights) {
    const day = roster.days[i];
    if (!day || seen.has(day.comp)) continue;
    seen.add(day.comp);
    out.push(day);
  }
  return out;
}

/**
 * Substring search over pilot names, best matches first: exact key, then
 * prefix, then anywhere. Query is slugified so "gutierrez" finds "Gutiérrez"
 * and "bruno subarno" finds "(Bruno) Subarno.1177.131".
 */
export function searchPilots(roster: Roster, query: string, limit = 12): RosterPilot[] {
  const q = slugifyPilot(query);
  if (!q) return [];
  const exact: RosterPilot[] = [];
  const prefix: RosterPilot[] = [];
  const anywhere: RosterPilot[] = [];
  for (const p of roster.pilots) {
    if (p.key === q) exact.push(p);
    else if (p.key.startsWith(q)) prefix.push(p);
    else if (p.key.includes(q)) anywhere.push(p);
  }
  return [...exact, ...prefix, ...anywhere].slice(0, limit);
}
