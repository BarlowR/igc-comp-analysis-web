// Comp notes: one free-text note per account per competition.
//
// The whole-comp counterpart to annotations, which pin a moment on one pilot's
// flight. See supabase/migrations/0005_comp_notes.sql — (user_id, comp) is the
// primary key, so there is exactly one note per comp and saving is an upsert.
//
// Private to the account that wrote them; RLS enforces that, so the read below
// doesn't filter by user_id and can't return anyone else's rows.
import { currentUser, getSupabase } from './supabase';

/** Matches the CHECK constraint on comp_notes.body. */
export const MAX_BODY_LENGTH = 8000;

export interface CompNote {
  comp: string;
  body: string;
  updated_at: string;
}

/**
 * Every comp note this account holds, keyed by comp slug.
 *
 * One query for the whole archive rather than one per comp: the index lists
 * every competition at once, and a select-per-comp would be a round-trip each
 * for a few hundred bytes. Empty when signed out.
 */
export async function listMyCompNotes(): Promise<Map<string, CompNote>> {
  const notes = new Map<string, CompNote>();
  const sb = await getSupabase();
  const user = await currentUser();
  if (!user) return notes;

  const { data, error } = await sb.from('comp_notes').select('comp, body, updated_at');
  if (error) throw error;
  for (const row of (data ?? []) as CompNote[]) notes.set(row.comp, row);
  return notes;
}

/**
 * Write this account's note for one comp, creating or replacing it.
 *
 * An empty body deletes the row instead of storing "": the CHECK constraint
 * forbids it, and "no note" reading as an absent row keeps listMyCompNotes()
 * honest — every key it returns has something in it. Returns the stored note,
 * or null when it was cleared.
 */
export async function saveCompNote(comp: string, body: string): Promise<CompNote | null> {
  const text = body.trim();
  if (!text) {
    await deleteCompNote(comp);
    return null;
  }

  const sb = await getSupabase();
  const user = await currentUser();
  if (!user) throw new Error('Not signed in.');

  const { data, error } = await sb
    .from('comp_notes')
    .upsert(
      { user_id: user.id, comp, body: text, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,comp' },
    )
    .select('comp, body, updated_at')
    .single();
  if (error) throw error;
  return data as CompNote;
}

/** Drop this account's note for one comp. RLS restricts it to the owner's row. */
export async function deleteCompNote(comp: string): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.from('comp_notes').delete().eq('comp', comp);
  if (error) throw error;
}
