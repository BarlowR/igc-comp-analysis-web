// Annotations: a note against one moment on one pilot's flight.
//
// A note is anchored to (comp, day, pilot_key, time_ms) — see
// supabase/migrations/0004_annotations.sql for why that's a timestamp rather
// than a fix index.
//
// Notes are private to the account that wrote them; RLS enforces that, so every
// query here is implicitly scoped to the signed-in user and none of them filter
// by user_id on the read side. Link-sharing is planned but not built: when it
// lands it will fetch a *different* user's notes through a token, so nothing in
// the render path should assume these rows are the reader's own.
import { currentUser, getSupabase } from './supabase';

/** Matches the CHECK constraint on annotations.body. */
export const MAX_BODY_LENGTH = 2000;

export interface Annotation {
  id: string;
  comp: string;
  day: string;
  pilot_key: string;
  pilot_label: string | null;
  /** Epoch ms of the annotated moment. */
  time_ms: number;
  body: string;
  updated_at: string;
}

const COLUMNS = 'id, comp, day, pilot_key, pilot_label, time_ms, body, updated_at';

/** Every note on one archived day, oldest moment first. Empty when signed out. */
export async function listAnnotationsForDay(comp: string, day: string): Promise<Annotation[]> {
  const sb = await getSupabase();
  const user = await currentUser();
  if (!user) return [];

  const { data, error } = await sb
    .from('annotations')
    .select(COLUMNS)
    .eq('comp', comp)
    .eq('day', day)
    .order('time_ms', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Annotation[];
}

/**
 * How many notes this account holds on each archived day, keyed "comp/day".
 *
 * One query for the whole account: the account page needs a count per flight,
 * and a select-per-day would be dozens of round-trips for a few hundred bytes.
 * Only the two key columns come back, so the rows stay tiny.
 */
export async function countMyAnnotationsByDay(): Promise<Map<string, number>> {
  const sb = await getSupabase();
  const user = await currentUser();
  const counts = new Map<string, number>();
  if (!user) return counts;

  const { data, error } = await sb.from('annotations').select('comp, day');
  if (error) throw error;
  for (const row of (data ?? []) as { comp: string; day: string }[]) {
    const key = `${row.comp}/${row.day}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface NewAnnotation {
  comp: string;
  day: string;
  pilotKey: string;
  pilotLabel: string;
  timeMs: number;
  body: string;
}

/** Write a note and return the stored row (so the caller gets its id). */
export async function createAnnotation(input: NewAnnotation): Promise<Annotation> {
  const sb = await getSupabase();
  const user = await currentUser();
  if (!user) throw new Error('Not signed in.');

  const { data, error } = await sb
    .from('annotations')
    .insert({
      user_id: user.id,
      comp: input.comp,
      day: input.day,
      pilot_key: input.pilotKey,
      pilot_label: input.pilotLabel,
      // Fix times are whole ms, but round anyway: a fractional value would be
      // rejected by the bigint column.
      time_ms: Math.round(input.timeMs),
      body: input.body,
    })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as Annotation;
}

/**
 * Edit a note's text and the moment it points at — scrubbing while the composer
 * is open moves the note, so the two are always saved together. RLS restricts
 * this to the owner's own rows.
 */
export async function updateAnnotation(id: string, body: string, timeMs: number): Promise<Annotation> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .from('annotations')
    .update({ body, time_ms: Math.round(timeMs), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as Annotation;
}

/** Drop a note. RLS restricts this to the owner's own rows. */
export async function deleteAnnotation(id: string): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.from('annotations').delete().eq('id', id);
  if (error) throw error;
}
