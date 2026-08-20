-- 0007 — user comps: group saved tasks into a competition of the user's own.
--
-- 0006 stored each analyzed day as a standalone row, so three tasks from one
-- weekend event listed as three unrelated entries. This adds the grouping the
-- archive already has: a "comp" a user creates once and files tasks under. The
-- save form on /analyze offers the account's existing comps or creates a new
-- one; the archive index and /saved then list a comp's tasks together, the way
-- archived comps list their days.
--
-- Apply with: supabase db push   (or paste into the SQL editor).

-- --------------------------------------------------------------- user_comps --
create table if not exists public.user_comps (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  constraint user_comps_name_length check (char_length(name) between 1 and 120),
  -- One name per account: the picker stays free of duplicates, and "create or
  -- get" on the client can treat the unique violation as "already exists".
  unique (user_id, name)
);

alter table public.user_comps enable row level security;

drop policy if exists "a user reads only their own comps" on public.user_comps;
create policy "a user reads only their own comps"
  on public.user_comps for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "a user creates only their own comps" on public.user_comps;
create policy "a user creates only their own comps"
  on public.user_comps for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "a user renames only their own comps" on public.user_comps;
create policy "a user renames only their own comps"
  on public.user_comps for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "a user deletes only their own comps" on public.user_comps;
create policy "a user deletes only their own comps"
  on public.user_comps for delete to authenticated
  using (auth.uid() = user_id);

-- ------------------------------------------------- saved_comps gets a group --
-- Null = a standalone task (every pre-0007 row, and any save without a comp
-- picked). Deleting a comp un-groups its tasks rather than deleting them: the
-- tracklogs are the valuable part, the grouping is just a label.
alter table public.saved_comps
  add column if not exists comp_id uuid references public.user_comps(id) on delete set null;

create index if not exists saved_comps_comp_idx on public.saved_comps (comp_id);

-- The FK alone would let a row point at ANOTHER account's comp id (foreign-key
-- checks don't run through RLS). Harmless to that account — their reads filter
-- on saved_comps.user_id — but wrong, so the write policies now also require
-- any comp_id to be the writer's own.
drop policy if exists "a user creates only their own saved comps" on public.saved_comps;
create policy "a user creates only their own saved comps"
  on public.saved_comps for insert to authenticated
  with check (
    auth.uid() = user_id
    and (comp_id is null
      or exists (select 1 from public.user_comps c where c.id = comp_id and c.user_id = auth.uid()))
  );

drop policy if exists "a user updates only their own saved comps" on public.saved_comps;
create policy "a user updates only their own saved comps"
  on public.saved_comps for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (comp_id is null
      or exists (select 1 from public.user_comps c where c.id = comp_id and c.user_id = auth.uid()))
  );
