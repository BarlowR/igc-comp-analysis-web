// Pilot claims: "this result is me".
//
// Two scopes. A name claim (day null) says a pilot is you for a whole comp, and
// claiming a pilot who flew three comps writes three such rows — that is what
// lets the account page stitch together a history the archive cannot infer. A
// one-off claim (day set) covers a single task, for when the name on the result
// isn't yours because the tracker was borrowed or shared.
//
// Claims are not exclusive: any number of accounts may claim the same pilot
// (see supabase/migrations/0002_shared_claims.sql). The only uniqueness left is
// per account, so claiming twice from one account is a no-op rather than a
// duplicate row.
import { isUniqueViolation, requireUid } from './db';
import { currentUser, getSupabase } from './supabase';

export interface PilotClaim {
  id: string;
  comp: string;
  /** null = every task this pilot flew in the comp; set = that one task. */
  day: string | null;
  pilot_key: string;
  pilot_label: string | null;
}

export async function listMyClaims(): Promise<PilotClaim[]> {
  const sb = await getSupabase();
  const user = await currentUser();
  if (!user) return [];

  const { data, error } = await sb
    .from('pilot_claims')
    .select('id, comp, day, pilot_key, pilot_label')
    .eq('user_id', user.id);
  if (error) throw error;
  return data ?? [];
}

/** This account's claims covering one archived day, name-level or one-off. */
export async function listMyClaimsForDay(comp: string, day: string): Promise<PilotClaim[]> {
  const sb = await getSupabase();
  const user = await currentUser();
  if (!user) return [];

  // .or() below takes a literal PostgREST filter string — a day containing
  // "," or ")" would corrupt it. Day slugs are [a-z0-9-] by construction;
  // anything else can't be an archived day, so it has no claims.
  if (!/^[A-Za-z0-9_-]+$/.test(day)) return [];

  const { data, error } = await sb
    .from('pilot_claims')
    .select('id, comp, day, pilot_key, pilot_label')
    .eq('user_id', user.id)
    .eq('comp', comp)
    // A comp-wide claim (day is null) covers this day too.
    .or(`day.is.null,day.eq.${day}`);
  if (error) throw error;
  return data ?? [];
}

/**
 * Claim a single task — the result is yours even though the name on it may not
 * be, which is what happens on a borrowed or shared tracker. Returns false if
 * this account already had that claim.
 */
export async function claimDay(
  comp: string,
  day: string,
  pilotKey: string,
  pilotLabel: string,
): Promise<boolean> {
  const sb = await getSupabase();
  const userId = await requireUid();

  const { error } = await sb
    .from('pilot_claims')
    .insert({ user_id: userId, comp, day, pilot_key: pilotKey, pilot_label: pilotLabel });
  if (!error) return true;
  if (isUniqueViolation(error)) return false;
  throw error;
}

export interface ClaimResult {
  claimed: string[];
  /** Comps this account had already claimed for this pilot — nothing to do. */
  already: string[];
}

/**
 * Claim one pilot across the given comps. Rows are inserted individually so one
 * comp already on the account doesn't roll back the rest.
 */
export async function claimPilot(
  pilotKey: string,
  pilotLabel: string,
  comps: string[],
): Promise<ClaimResult> {
  const sb = await getSupabase();
  const userId = await requireUid();

  const result: ClaimResult = { claimed: [], already: [] };
  for (const comp of comps) {
    const { error } = await sb
      .from('pilot_claims')
      .insert({ user_id: userId, comp, day: null, pilot_key: pilotKey, pilot_label: pilotLabel });
    if (!error) result.claimed.push(comp);
    else if (isUniqueViolation(error)) result.already.push(comp);
    else throw error;
  }
  return result;
}

/** Drop a claim. RLS restricts this to the owner's own rows. */
export async function removeClaim(id: string): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.from('pilot_claims').delete().eq('id', id);
  if (error) throw error;
}
