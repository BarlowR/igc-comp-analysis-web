-- 0002 — let several accounts claim the same pilot.
--
-- 0001 made (comp, pilot_key) unique, so the first account to claim a pilot
-- owned that result and everyone else was refused. That protects against
-- something we've decided we don't care about: a duplicate claim costs the real
-- pilot nothing, since each account only ever sees its own claims. Meanwhile it
-- broke legitimate cases — two pilots sharing a name slug, or one person with
-- two accounts.
--
-- Apply with: supabase db push   (or paste into the SQL editor).

alter table public.pilot_claims
  drop constraint if exists pilot_claims_comp_pilot_key_key;

-- Still one row per account per pilot per comp: claiming twice from the same
-- account would just duplicate rows in the "Your flights" list.
alter table public.pilot_claims
  drop constraint if exists pilot_claims_user_comp_pilot_key;
alter table public.pilot_claims
  add constraint pilot_claims_user_comp_pilot_key unique (user_id, comp, pilot_key);

-- `verified` is left in place but is now read by nothing: with claims shared,
-- there is no ownership to adjudicate. It stays only as a hook for an
-- organiser-approval story, and remains unsettable from the client.
