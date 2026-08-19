-- 0008 — notebooks: collections of markdown notes with links into the site.
--
-- A notebook is a user-created collection ("2026 season", "SIV debriefs");
-- each note in it is a markdown document. Links to comps, tasks, and single
-- annotations are ordinary markdown links whose targets are site URLs — the
-- editor's link picker inserts them, and the pages they point at handle the
-- deep-linking (see docs/decisions/0003-notebooks.md). Nothing here needs to
-- know what a note links TO, which is what keeps this schema two tables.
--
-- Apply with: supabase db push   (or paste into the SQL editor).

create table if not exists public.notebooks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notebooks_name_length check (char_length(name) between 1 and 120),
  -- One name per account: the list stays free of duplicates.
  unique (user_id, name)
);

alter table public.notebooks enable row level security;

create policy "a user reads only their own notebooks"
  on public.notebooks for select to authenticated
  using (auth.uid() = user_id);

create policy "a user creates only their own notebooks"
  on public.notebooks for insert to authenticated
  with check (auth.uid() = user_id);

create policy "a user updates only their own notebooks"
  on public.notebooks for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "a user deletes only their own notebooks"
  on public.notebooks for delete to authenticated
  using (auth.uid() = user_id);

-- -------------------------------------------------------------------- notes --
-- No title column: a note is markdown, and its first heading (or line) is its
-- display title. Ordered by created_at — a notebook reads as a journal.
create table if not exists public.notebook_notes (
  id          uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  user_id     uuid not null references auth.users on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint notebook_notes_body_length check (char_length(body) between 1 and 20000)
);

create index if not exists notebook_notes_notebook_idx
  on public.notebook_notes (notebook_id, created_at);

alter table public.notebook_notes enable row level security;

-- Owner-only, and a note may only land in a notebook the writer owns — the FK
-- alone would accept another account's notebook id (FK checks bypass RLS).
create policy "a user reads only their own notebook notes"
  on public.notebook_notes for select to authenticated
  using (auth.uid() = user_id);

create policy "a user creates notes only in their own notebooks"
  on public.notebook_notes for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.notebooks n where n.id = notebook_id and n.user_id = auth.uid())
  );

create policy "a user updates only their own notebook notes"
  on public.notebook_notes for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "a user deletes only their own notebook notes"
  on public.notebook_notes for delete to authenticated
  using (auth.uid() = user_id);
