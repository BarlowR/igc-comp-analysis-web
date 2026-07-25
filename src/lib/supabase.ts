// Browser-side Supabase access.
//
// PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY are baked into the client
// bundle at build, exactly like PUBLIC_CESIUM_ION_TOKEN. Both are public by
// design; row-level security in Postgres is the actual boundary (see
// supabase/migrations/0001_accounts.sql).
//
// supabase-js is ~100 KB, and the archive pages are already heavy, so it is
// pulled in via dynamic import — only pages that actually sign someone in or
// read user data pay for it. The nav chip uses readCachedSession() instead.
import type { SupabaseClient, Session } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;

/**
 * Fixed storage key so readCachedSession() knows where to look. Left to itself
 * supabase-js derives one from the project ref, which we'd have to re-derive.
 */
export const STORAGE_KEY = 'igc-comp-auth';

/** False when the env vars are missing — the UI degrades to "accounts are off". */
export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let clientPromise: Promise<SupabaseClient> | null = null;

/** Lazily construct the shared client. Rejects if the app wasn't built with credentials. */
export function getSupabase(): Promise<SupabaseClient> {
  if (!isConfigured) {
    return Promise.reject(
      new Error('Accounts are not configured: set PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY.'),
    );
  }
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: {
        storageKey: STORAGE_KEY,
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        // Magic-link redirects come back with ?code=…; this exchanges it for a
        // session on whichever page the user lands on.
        detectSessionInUrl: true,
      },
    }),
  );
  return clientPromise;
}

export interface CachedSession {
  userId: string;
  email: string | null;
  displayName: string | null;
}

/**
 * Peek at the persisted session without loading supabase-js — enough to render
 * the nav chip on a page that has no other reason to talk to Supabase.
 *
 * This trusts localStorage: it proves nothing to the server, and a token that
 * expired seconds ago still reads as signed in. That is fine for a name in the
 * nav. Anything that reads or writes data must go through getSupabase(), which
 * validates and refreshes.
 */
export function readCachedSession(): CachedSession | null {
  if (typeof localStorage === 'undefined') return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // private mode / storage blocked
  }
  if (!raw) return null;

  try {
    // supabase-js stores either plain JSON or a "base64-" prefixed payload
    // depending on version, so handle both.
    const json = raw.startsWith('base64-') ? atob(raw.slice('base64-'.length)) : raw;
    const session = JSON.parse(json) as Partial<Session> & { expires_at?: number };
    const user = session?.user;
    if (!user?.id) return null;
    if (session.expires_at && session.expires_at * 1000 < Date.now()) return null;
    return {
      userId: user.id,
      email: user.email ?? null,
      displayName: (user.user_metadata?.display_name as string | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

export interface Profile {
  id: string;
  display_name: string | null;
}

/** The signed-in user's profile row, or null if signed out. */
export async function fetchProfile(): Promise<Profile | null> {
  const sb = await getSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  const { data, error } = await sb
    .from('profiles')
    .select('id, display_name')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  // The signup trigger normally creates this; fall back rather than error out
  // if a user predates the trigger.
  return data ?? { id: user.id, display_name: null };
}

/** Save a display name to both the profile row and the auth metadata (the nav chip reads the latter). */
export async function saveDisplayName(displayName: string): Promise<void> {
  const sb = await getSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const name = displayName.trim() || null;
  const { error } = await sb
    .from('profiles')
    .upsert({ id: user.id, display_name: name, updated_at: new Date().toISOString() });
  if (error) throw error;

  const { error: metaError } = await sb.auth.updateUser({ data: { display_name: name } });
  if (metaError) throw metaError;
}
