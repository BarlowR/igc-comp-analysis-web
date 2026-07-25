// Pilot claims: "this pilot, in this comp, is me".
//
// Claiming a pilot who flew three comps writes three rows, which is what lets
// the account page stitch together a history the archive itself cannot infer.
//
// Claims are not exclusive: any number of accounts may claim the same pilot
// (see supabase/migrations/0002_shared_claims.sql). The only uniqueness left is
// per account, so claiming twice from one account is a no-op rather than a
// duplicate row.
import { getSupabase } from './supabase';

export interface PilotClaim {
  id: string;
  comp: string;
  pilot_key: string;
  pilot_label: string | null;
}

/** Postgres unique_violation — this account already holds that claim. */
const UNIQUE_VIOLATION = '23505';

export async function listMyClaims(): Promise<PilotClaim[]> {
  const sb = await getSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data, error } = await sb
    .from('pilot_claims')
    .select('id, comp, pilot_key, pilot_label')
    .eq('user_id', user.id);
  if (error) throw error;
  return data ?? [];
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
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const result: ClaimResult = { claimed: [], already: [] };
  for (const comp of comps) {
    const { error } = await sb
      .from('pilot_claims')
      .insert({ user_id: user.id, comp, pilot_key: pilotKey, pilot_label: pilotLabel });
    if (!error) result.claimed.push(comp);
    else if (error.code === UNIQUE_VIOLATION) result.already.push(comp);
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
