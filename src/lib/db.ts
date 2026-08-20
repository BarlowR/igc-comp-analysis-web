// Shared helpers for the Supabase data modules.
import { currentUser } from './supabase';

/**
 * The signed-in user's id, or throw. For writes: a write with nobody signed
 * in is a caller bug and must fail loudly, not silently no-op through RLS.
 * (Reads instead gate with `if (!user) return []` — signed out legitimately
 * means "you have none".)
 */
export async function requireUid(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('Not signed in.');
  return user.id;
}

/** Postgres unique_violation — "this row already exists". */
const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}
