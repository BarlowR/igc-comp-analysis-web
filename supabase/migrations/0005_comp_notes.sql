-- 0005 — comp notes: one free-text note per account per competition.
--
-- The counterpart to 0004's annotations at the other end of the scale. An
-- annotation is a pin: one moment, one pilot's flight. This is the whole comp in
-- one block — how the week went, what the air did, what to do differently — and
-- there is exactly one of them per account per comp, so it is edited in place
-- rather than added to a list.
--
-- That "exactly one" is the primary key (user_id, comp), not a uniqueness
-- constraint bolted onto a surrogate id: the pair IS the identity of the row, it
-- gives the upsert its natural conflict target, and it makes a second note for
-- the same comp unrepresentable rather than merely rejected.
--
-- `comp` is the archive slug (e.g. "2026-canadian-nationals"), the same key the
-- manifest, pilot_claims and annotations use. Deliberately not a foreign key —
-- the archive lives in the repo, not in Postgres — so a note survives a comp
-- being re-slugged or temporarily unpublished. It just stops being shown.
--
-- Apply with: supabase db push   (or paste into the SQL editor).

create table if not exists public.comp_notes (
  user_id    uuid not null references auth.users on delete cascade,
  comp       text not null,
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, comp),
  -- Longer than an annotation's 2000: this covers a whole week, not a moment.
  -- The empty case isn't stored — the client deletes the row instead, so "no
  -- note" is an absent row rather than a row holding "".
  constraint comp_notes_body_length check (char_length(body) between 1 and 8000)
);

-- The archive index reads every note this account holds in one query, and the
-- primary key already indexes (user_id, comp) left-to-right, so that scan is
-- covered. No further index.

alter table public.comp_notes enable row level security;

-- Private, like annotations and unlike profiles/pilot_claims: readable only by
-- the account that wrote it. All four policies are scoped to the owner, so there
-- is no path from the anon key to anyone else's notes.
create policy "a user reads only their own comp notes"
  on public.comp_notes for select to authenticated
  using (auth.uid() = user_id);

create policy "a user creates only their own comp notes"
  on public.comp_notes for insert to authenticated
  with check (auth.uid() = user_id);

create policy "a user updates only their own comp notes"
  on public.comp_notes for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "a user deletes only their own comp notes"
  on public.comp_notes for delete to authenticated
  using (auth.uid() = user_id);
