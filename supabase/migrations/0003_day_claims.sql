-- 0003 — claim a single task, not just a pilot.
--
-- A name-level claim says "this pilot is me in this comp", which is wrong when
-- someone flies a borrowed or shared tracker: the result is theirs, but the
-- name on it isn't. So a claim may now be scoped to one archived day.
--
--   day is null  -> every task this pilot flew in that comp (the name claim)
--   day is set   -> that one task only (the one-off claim)
--
-- Apply with: supabase db push   (or paste into the SQL editor).

alter table public.pilot_claims
  add column if not exists day text;

-- Postgres treats NULLs as distinct in a unique constraint, so one constraint
-- spanning a nullable `day` would let the same comp-wide claim be inserted
-- repeatedly. Two partial indexes instead, one per kind of claim.
alter table public.pilot_claims
  drop constraint if exists pilot_claims_user_comp_pilot_key;

create unique index if not exists pilot_claims_user_comp_pilot_uniq
  on public.pilot_claims (user_id, comp, pilot_key)
  where day is null;

create unique index if not exists pilot_claims_user_comp_day_pilot_uniq
  on public.pilot_claims (user_id, comp, day, pilot_key)
  where day is not null;
