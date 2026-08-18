-- 0006 — saved comps: a user's own analyzed days, stored under their account.
--
-- The analyze page runs entirely client-side and forgets everything on reload.
-- This lets a signed-in user keep a day: the raw inputs (task + gzipped IGCs)
-- go to a private storage bucket as ground truth, alongside a cached results
-- JSON so opening a saved comp is a single download with no re-analysis. The
-- cache carries the analysis_version it was computed with; when the engine
-- changes (see ANALYSIS_VERSION in src/lib/competition.ts) the viewer offers a
-- recompute from the raw files instead of silently serving stale numbers.
-- docs/decisions/0002-saved-comps.md has the reasoning.
--
-- Apply with: supabase db push   (or paste into the SQL editor).

-- ------------------------------------------------------------- saved_comps --
-- One row per saved day: the listing metadata plus the IGC manifest. The files
-- themselves live in storage under <user_id>/<id>/; the manifest maps each
-- stored object to its original filename, which matters because pilot names are
-- parsed OUT of the filename (nameFromFile) — lose the name, lose the pilot.
create table if not exists public.saved_comps (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users on delete cascade,
  name             text not null,
  -- 'xc', 'hike-and-fly' or 'free' — the kind the user filed it under, which
  -- is also which archive tab it appears on. Free text here; parseTaskKind
  -- narrows it on read. 'free' is the task-less kind: no task.xctsk is stored
  -- for it, and its analysis runs over the whole flight.
  task_kind        text not null default 'xc',
  pilot_count      integer not null default 0,
  -- [{ "key": "igc/0.igc.gz", "name": "bill_belcourt_2026-06-14.igc" }, …]
  igc_files        jsonb not null default '[]'::jsonb,
  -- ANALYSIS_VERSION the cached results.json was computed with.
  analysis_version integer not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint saved_comps_name_length check (char_length(name) between 1 and 120)
);

-- "My comps, newest first" is the only listing query.
create index if not exists saved_comps_user_idx
  on public.saved_comps (user_id, created_at desc);

alter table public.saved_comps enable row level security;

-- Private, like annotations and comp notes: a saved comp is visible only to the
-- account that saved it. Sharing-by-link, if ever wanted, gets its own table
-- (see the note at the end of 0004) — nothing here anticipates it.
create policy "a user reads only their own saved comps"
  on public.saved_comps for select to authenticated
  using (auth.uid() = user_id);

create policy "a user creates only their own saved comps"
  on public.saved_comps for insert to authenticated
  with check (auth.uid() = user_id);

create policy "a user updates only their own saved comps"
  on public.saved_comps for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "a user deletes only their own saved comps"
  on public.saved_comps for delete to authenticated
  using (auth.uid() = user_id);

-- ------------------------------------------------------------ storage bucket --
-- Object layout: <user_id>/<comp_id>/task.xctsk       (absent for a free-flight
--                                                       save — there is no task)
--                <user_id>/<comp_id>/igc/<n>.igc.gz   (or .igc if the browser
--                                                       lacks CompressionStream)
--                <user_id>/<comp_id>/results.json.gz  (or .json)
--
-- The first path segment being the owner's uid is what every policy below keys
-- on. 50 MB per object is far above anything real (a big day's results JSON is
-- ~10 MB raw, ~2 MB gzipped; a single IGC gzips to well under 1 MB) but keeps a
-- runaway upload from eating the project's storage quota.
insert into storage.buckets (id, name, public, file_size_limit)
values ('saved-comps', 'saved-comps', false, 52428800)
on conflict (id) do nothing;

create policy "saved comp files are readable by their owner"
  on storage.objects for select to authenticated
  using (bucket_id = 'saved-comps' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "a user uploads only into their own saved comp folder"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'saved-comps' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "a user replaces only their own saved comp files"
  on storage.objects for update to authenticated
  using (bucket_id = 'saved-comps' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'saved-comps' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "a user deletes only their own saved comp files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'saved-comps' and (storage.foldername(name))[1] = auth.uid()::text);
