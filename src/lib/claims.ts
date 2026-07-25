// Pilot claims: "this pilot, in this comp, is me".
//
// One row per (comp, pilot_key) — the table is uniquely keyed on that pair, so
// the first account to claim a result owns it. Claiming a pilot who flew three
// comps writes three rows, which is what lets the account page stitch a history
// together that the archive itself cannot infer.
import { getSupabase } from './supabase';

export interface PilotClaim {
  id: string;
  comp: string;
  pilot_key: string;
  pilot_label: string | null;
  verified: boolean;
}

/** Postgres unique_violation — someone already claimed that pilot. */
const UNIQUE_VIOLATION = '23505';

export async function listMyClaims(): Promise<PilotClaim[]> {
  const sb = await getSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data, error } = await sb
    .from('pilot_claims')
    .select('id, comp, pilot_key, pilot_label, verified')
    .eq('user_id', user.id);
  if (error) throw error;
  return data ?? [];
}

export interface ClaimResult {
  claimed: string[];
  /** Comps where this pilot was already claimed (by anyone, including you). */
  taken: string[];
}

/**
 * Claim one pilot across the given comps. Rows are inserted individually so a
 * comp that's already taken doesn't roll back the ones that aren't.
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

  const result: ClaimResult = { claimed: [], taken: [] };
  for (const comp of comps) {
    const { error } = await sb
      .from('pilot_claims')
      .insert({ user_id: user.id, comp, pilot_key: pilotKey, pilot_label: pilotLabel });
    if (!error) result.claimed.push(comp);
    else if (error.code === UNIQUE_VIOLATION) result.taken.push(comp);
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
