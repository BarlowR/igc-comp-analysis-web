-- 0010 — defect fixes from the architecture inspection (ARCHITECTURE_REVIEW.md §1).
--
-- Apply with: supabase db push   (or paste into the SQL editor).

-- a) pilot_claims: owner-only reads.
--
-- The select policy was `using (true)` since 0001, but no code path ever reads
-- another account's claims, and the comments in 0002/claims.ts describe claims
-- as private. Make the stated model the real one. (0009 already removed the
-- public profiles table this could be joined against.)
drop policy if exists "claims are readable by everyone" on public.pilot_claims;
drop policy if exists "a user reads only their own claims" on public.pilot_claims;
create policy "a user reads only their own claims"
  on public.pilot_claims for select to authenticated
  using (auth.uid() = user_id);

-- b) notebook_notes UPDATE: the same notebook-ownership check INSERT has.
--
-- Without it an owner could set notebook_id to another account's notebook
-- (the FK alone accepts it — FK checks bypass RLS). 0007 fixed this class of
-- bug for saved_comps.comp_id on both verbs; 0008 only covered INSERT.
drop policy if exists "a user updates only their own notebook notes" on public.notebook_notes;
create policy "a user updates only their own notebook notes"
  on public.notebook_notes for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.notebooks n where n.id = notebook_id and n.user_id = auth.uid())
  );

-- c) updated_at: the server's clock, not each client's.
--
-- Every module stamped updated_at with new Date() client-side, so a wrong
-- client clock wrote a wrong timestamp ("3 min ago" renders from it). One
-- trigger sets it on every update; inserts keep the column default.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.annotations;
create trigger set_updated_at
  before update on public.annotations
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.comp_notes;
create trigger set_updated_at
  before update on public.comp_notes
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.saved_comps;
create trigger set_updated_at
  before update on public.saved_comps
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.notebooks;
create trigger set_updated_at
  before update on public.notebooks
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.notebook_notes;
create trigger set_updated_at
  before update on public.notebook_notes
  for each row execute function public.set_updated_at();

-- d) pilot_claims.verified has been dead since 0002 made claims shared.
-- Nothing reads it; the trigger that forced it false runs on every insert for
-- no reason. Remove the whole mechanism.
drop trigger if exists pilot_claims_force_unverified on public.pilot_claims;
drop function if exists public.force_unverified_claim();
alter table public.pilot_claims drop column if exists verified;
