// Saved comps: a signed-in user's own analyzed days (see migration
// 0006_saved_comps.sql and docs/decisions/0002-saved-comps.md).
//
// Two things are stored per comp, deliberately:
//   - the raw inputs (task.xctsk + the IGC files, gzipped) — the ground truth,
//     so future analysis fixes can be applied by recomputing;
//   - a cached results JSON — so opening a saved comp is one download and a
//     render, not a full re-analysis of every tracklog.
// The cache records the ANALYSIS_VERSION it was computed with; the viewer
// compares that against the current engine and offers a recompute when stale.
//
// IGC objects are stored as igc/<n>.igc.gz with the ORIGINAL filename kept in
// the row's manifest — pilot names are parsed out of the filename
// (nameFromFile), so the name must survive even though the storage key doesn't
// carry it. Compression uses the browser's native CompressionStream; the rare
// browser without it stores plain files under keys without the .gz suffix, and
// the suffix decides decompression on the way back.
import { getSupabase, currentUser } from './supabase';
import { ANALYSIS_VERSION } from './competition';
import { parseTaskKind, type TaskKind } from './xctsk';

const BUCKET = 'saved-comps';

/**
 * Where a saved comp is filed — which archive tab it appears under, and the
 * kind a recompute runs as. Just parseTaskKind of the stored value: 'free'
 * (task-less, its own account-only tab) is a first-class TaskKind now.
 */
export function savedKind(comp: SavedComp): TaskKind {
  return parseTaskKind(comp.task_kind);
}

export interface SavedCompFile {
  key: string; // object key under the comp folder, e.g. "igc/0.igc.gz"
  name: string; // original filename, e.g. "bill_belcourt_2026-06-14.igc"
}

export interface SavedComp {
  id: string;
  name: string;
  task_kind: string;
  pilot_count: number;
  igc_files: SavedCompFile[];
  analysis_version: number;
  created_at: string;
  /** The user comp this task is filed under; null = standalone. */
  comp_id: string | null;
  /** Joined from user_comps for display; null when comp_id is null. */
  comp: { name: string } | null;
}

/** A competition of the user's own: a named group the save form files tasks under. */
export interface UserComp {
  id: string;
  name: string;
  created_at: string;
}

/** "Comp — Task" when the task is filed under a comp, else just the task name. */
export function savedTitle(comp: SavedComp): string {
  return comp.comp?.name ? `${comp.comp.name} — ${comp.name}` : comp.name;
}

/** Every select of a saved_comps row, one spelling: columns + the comp name join. */
const SAVED_COMP_COLS =
  'id, name, task_kind, pilot_count, igc_files, analysis_version, created_at, comp_id, comp:user_comps(name)';

export interface SavedCompInputs {
  /** Null for a free-flight save — there was no task to store. */
  taskText: string | null;
  igc: { name: string; text: string }[];
  taskKind: TaskKind;
}

/** Whether this saved comp's cached results predate the current engine. */
export function isStale(comp: SavedComp): boolean {
  return comp.analysis_version < ANALYSIS_VERSION;
}

// ---- gzip via the native streams ------------------------------------------

const canGzip = typeof CompressionStream !== 'undefined';

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Compress when the browser can; the key's .gz suffix records which happened. */
async function pack(text: string, key: string): Promise<{ key: string; blob: Blob }> {
  if (!canGzip) return { key, blob: new Blob([text]) };
  return { key: `${key}.gz`, blob: await gzip(text) };
}

async function unpack(blob: Blob, key: string): Promise<string> {
  return key.endsWith('.gz') ? gunzip(blob) : blob.text();
}

// ---- storage plumbing ------------------------------------------------------

async function upload(path: string, blob: Blob): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
    contentType: 'application/octet-stream',
    upsert: true, // recompute rewrites results.json.gz in place
  });
  if (error) throw error;
}

async function download(path: string): Promise<Blob> {
  const sb = await getSupabase();
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error) throw error;
  return data;
}

/** The signed-in user's id, or a sign-in error — every call here needs it. */
async function uid(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('Not signed in.');
  return user.id;
}

const folder = (userId: string, compId: string) => `${userId}/${compId}`;

// The cache key mirrors pack(): .gz when compressed, bare when not. Stored in
// the row? No — derivable from analysis flow, but the suffix must match what
// was uploaded, so probe both on read.
const RESULTS_KEYS = ['results.json.gz', 'results.json'];
const TASK_KEYS = ['task.xctsk.gz', 'task.xctsk'];

async function downloadFirst(base: string, keys: string[]): Promise<{ blob: Blob; key: string }> {
  let lastErr: unknown = null;
  for (const key of keys) {
    try {
      return { blob: await download(`${base}/${key}`), key };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('File not found.');
}

// ---- public API -------------------------------------------------------------

/**
 * Save one analyzed day: inserts the row, then uploads task + IGCs + the
 * results cache. On any upload failure the row and whatever landed are removed
 * best-effort, so a half-saved comp doesn't linger in the list.
 */
export async function saveComp(opts: {
  name: string;
  /** Raw category value ('xc' | 'hike-and-fly' | 'free') — stored as-is. */
  taskKind: string;
  /** Null for a free-flight run: no task file exists, none is stored. */
  taskText: string | null;
  igc: { name: string; text: string }[];
  results: unknown;
  pilotCount: number;
  /** User comp to file this task under; null/omitted = standalone. */
  compId?: string | null;
}): Promise<SavedComp> {
  const sb = await getSupabase();
  const userId = await uid();

  // Manifest first (keys depend on pack()), then the row, then the files: the
  // row must exist before uploads only in the sense that its id names the
  // folder — RLS keys on the user id alone, so order is about cleanup, not
  // permission.
  const packedIgc = await Promise.all(
    opts.igc.map(async (f, i) => ({ ...(await pack(f.text, `igc/${i}.igc`)), name: f.name })),
  );
  const igcFiles: SavedCompFile[] = packedIgc.map((p) => ({ key: p.key, name: p.name }));

  const { data, error } = await sb
    .from('saved_comps')
    .insert({
      user_id: userId,
      name: opts.name,
      task_kind: opts.taskKind,
      pilot_count: opts.pilotCount,
      igc_files: igcFiles,
      analysis_version: ANALYSIS_VERSION,
      comp_id: opts.compId ?? null,
    })
    .select(SAVED_COMP_COLS)
    .single();
  if (error) throw error;
  const comp = data as unknown as SavedComp;

  const base = folder(userId, comp.id);
  try {
    const results = await pack(JSON.stringify(opts.results), 'results.json');
    // Sequential rather than Promise.all: N simultaneous uploads trip rate
    // limits sooner and make partial failure messier to clean up.
    if (opts.taskText !== null) {
      const task = await pack(opts.taskText, 'task.xctsk');
      await upload(`${base}/${task.key}`, task.blob);
    }
    for (const f of packedIgc) await upload(`${base}/${f.key}`, f.blob);
    await upload(`${base}/${results.key}`, results.blob);
  } catch (err) {
    await deleteComp(comp.id).catch(() => {
      // Cleanup is best-effort; the original failure is the story.
    });
    throw err;
  }
  return comp;
}

/** The signed-in user's saved comps, newest first. */
export async function listMyComps(): Promise<SavedComp[]> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .from('saved_comps')
    .select(SAVED_COMP_COLS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as SavedComp[];
}

/** One saved comp by id (RLS returns nothing for other users' ids). */
export async function fetchComp(id: string): Promise<SavedComp | null> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .from('saved_comps')
    .select(SAVED_COMP_COLS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as SavedComp) ?? null;
}

/** The cached results JSON, decompressed and parsed. */
export async function loadResults(comp: SavedComp): Promise<unknown> {
  const base = folder(await uid(), comp.id);
  const { blob, key } = await downloadFirst(base, RESULTS_KEYS);
  return JSON.parse(await unpack(blob, key));
}

/** The raw inputs — task text (null on a free-flight save, which stored none)
 *  and every IGC with its original filename. */
export async function loadInputs(comp: SavedComp): Promise<SavedCompInputs> {
  const base = folder(await uid(), comp.id);
  const taskKind = savedKind(comp);
  let taskText: string | null = null;
  if (taskKind !== 'free') {
    const { blob, key } = await downloadFirst(base, TASK_KEYS);
    taskText = await unpack(blob, key);
  }
  const igc = await Promise.all(
    comp.igc_files.map(async (f) => ({
      name: f.name,
      text: await unpack(await download(`${base}/${f.key}`), f.key),
    })),
  );
  return { taskText, igc, taskKind };
}

/** Replace the cached results after a recompute and stamp the engine version. */
export async function saveResults(comp: SavedComp, results: unknown): Promise<void> {
  const sb = await getSupabase();
  const base = folder(await uid(), comp.id);
  const packed = await pack(JSON.stringify(results), 'results.json');
  await upload(`${base}/${packed.key}`, packed.blob);
  // A recompute may flip the compression suffix (different browser); drop the
  // other spelling so downloadFirst never finds a stale cache first.
  const other = RESULTS_KEYS.filter((k) => k !== packed.key).map((k) => `${base}/${k}`);
  await sb.storage.from(BUCKET).remove(other);

  const { error } = await sb
    .from('saved_comps')
    .update({ analysis_version: ANALYSIS_VERSION, updated_at: new Date().toISOString() })
    .eq('id', comp.id);
  if (error) throw error;
}

/** Delete the row and every stored object under the comp's folder. */
export async function deleteComp(id: string): Promise<void> {
  const sb = await getSupabase();
  const base = folder(await uid(), id);

  // Files first: if removal dies halfway the row is still there to retry from.
  // list() is not recursive, so the igc/ subfolder is listed separately.
  const paths: string[] = [];
  for (const dir of [base, `${base}/igc`]) {
    const { data, error } = await sb.storage.from(BUCKET).list(dir, { limit: 1000 });
    if (error) throw error;
    for (const item of data ?? []) {
      // Folders come back as id:null placeholder entries; only files get removed.
      if (item.id) paths.push(`${dir}/${item.name}`);
    }
  }
  if (paths.length) {
    const { error } = await sb.storage.from(BUCKET).remove(paths);
    if (error) throw error;
  }

  const { error } = await sb.from('saved_comps').delete().eq('id', id);
  if (error) throw error;
}

// ---- user comps -------------------------------------------------------------
// The named groups the save form files tasks under (migration 0007). Deleting
// one un-groups its tasks (comp_id goes null server-side); the tasks stay.

/** The signed-in user's comps, alphabetical — picker order. */
export async function listMyUserComps(): Promise<UserComp[]> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .from('user_comps')
    .select('id, name, created_at')
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as UserComp[];
}

/**
 * Create a comp, or return the existing one of the same name — (user_id, name)
 * is unique, so the violation IS the "already exists" signal and a retyped
 * name never errors or duplicates.
 */
export async function createUserComp(name: string): Promise<UserComp> {
  const sb = await getSupabase();
  const userId = await uid();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Comp name is empty.');

  const { data, error } = await sb
    .from('user_comps')
    .insert({ user_id: userId, name: trimmed })
    .select('id, name, created_at')
    .single();
  if (!error) return data as UserComp;

  if (error.code === '23505') {
    const { data: existing, error: err2 } = await sb
      .from('user_comps')
      .select('id, name, created_at')
      .eq('name', trimmed)
      .maybeSingle();
    if (err2) throw err2;
    if (existing) return existing as UserComp;
  }
  throw error;
}
