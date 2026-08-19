// Notebooks: user-created collections of markdown notes (migration 0008).
// Notes link to comps, tasks, and annotations with ordinary site URLs inside
// the markdown — this layer neither knows nor cares what a note points at.
import { currentUser, getSupabase } from './supabase';

/** Matches the CHECK constraint on notebook_notes.body. */
export const MAX_NOTE_LENGTH = 20_000;

export interface Notebook {
  id: string;
  name: string;
  created_at: string;
}

export interface NotebookNote {
  id: string;
  notebook_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

const NOTE_COLS = 'id, notebook_id, body, created_at, updated_at';

async function uid(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('Not signed in.');
  return user.id;
}

/** The account's notebooks, newest first. */
export async function listNotebooks(): Promise<Notebook[]> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .from('notebooks')
    .select('id, name, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Notebook[];
}

export async function fetchNotebook(id: string): Promise<Notebook | null> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .from('notebooks')
    .select('id, name, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as Notebook) ?? null;
}

export async function createNotebook(name: string): Promise<Notebook> {
  const sb = await getSupabase();
  const userId = await uid();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Notebook name is empty.');
  const { data, error } = await sb
    .from('notebooks')
    .insert({ user_id: userId, name: trimmed })
    .select('id, name, created_at')
    .single();
  if (error) {
    if (error.code === '23505') throw new Error('You already have a notebook with this name.');
    throw error;
  }
  return data as Notebook;
}

/** Deletes the notebook AND its notes (FK cascade). */
export async function deleteNotebook(id: string): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.from('notebooks').delete().eq('id', id);
  if (error) throw error;
}

/** A notebook's notes, oldest first — it reads as a journal. */
export async function listNotes(notebookId: string): Promise<NotebookNote[]> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .from('notebook_notes')
    .select(NOTE_COLS)
    .eq('notebook_id', notebookId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as NotebookNote[];
}

export async function createNote(notebookId: string, body: string): Promise<NotebookNote> {
  const sb = await getSupabase();
  const userId = await uid();
  const { data, error } = await sb
    .from('notebook_notes')
    .insert({ notebook_id: notebookId, user_id: userId, body })
    .select(NOTE_COLS)
    .single();
  if (error) throw error;
  return data as NotebookNote;
}

export async function updateNote(id: string, body: string): Promise<NotebookNote> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .from('notebook_notes')
    .update({ body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(NOTE_COLS)
    .single();
  if (error) throw error;
  return data as NotebookNote;
}

export async function deleteNote(id: string): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.from('notebook_notes').delete().eq('id', id);
  if (error) throw error;
}
