-- 0004 — annotations: a note against one moment on one pilot's flight.
--
-- Anchored to (comp, day, pilot_key, time_ms), NOT to a fix index. The tracks in
-- the day JSON are downsampled, so an index moves whenever the archive is
-- re-exported while a timestamp does not. positionAt()/altAt() interpolate a
-- position from the time, so one row renders correctly on the globe, the
-- altitude scrubber, and anything added later.
--
-- Apply with: supabase db push   (or paste into the SQL editor).

create table if not exists public.annotations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  comp        text not null,
  day         text not null,
  -- Normalised pilot name (slugifyPilot in src/lib/pilots.ts), same join key the
  -- claims use; pilot_label keeps the name as displayed when the note was made.
  pilot_key   text not null,
  pilot_label text,
  /* Epoch ms of the annotated moment. Well inside float64's exact-integer range,
     so it survives the JSON round-trip PostgREST does with bigint. */
  time_ms     bigint not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint annotations_body_length check (char_length(body) between 1 and 2000)
);

-- Every read is "my notes on this day", which this covers.
create index if not exists annotations_user_day_idx
  on public.annotations (user_id, comp, day);

alter table public.annotations enable row level security;

-- Private, unlike profiles and pilot_claims: an annotation is readable only by
-- the account that wrote it. All four policies are scoped to the owner, so there
-- is no path from the anon key to anyone else's notes.
create policy "a user reads only their own annotations"
  on public.annotations for select to authenticated
  using (auth.uid() = user_id);

create policy "a user creates only their own annotations"
  on public.annotations for insert to authenticated
  with check (auth.uid() = user_id);

create policy "a user updates only their own annotations"
  on public.annotations for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "a user deletes only their own annotations"
  on public.annotations for delete to authenticated
  using (auth.uid() = user_id);

-- ------------------------------------------------------- sharing, eventually --
-- Sharing a day's notes by link is wanted later, so here is the intended shape,
-- deliberately NOT built yet.
--
-- Nothing is added to this table for it. A share is a property of a *set* of
-- notes, and the set already has a natural key — (user_id, comp, day) — so it
-- belongs in its own table:
--
--   create table public.annotation_shares (
--     token uuid primary key default gen_random_uuid(),
--     user_id uuid not null references auth.users on delete cascade,
--     comp text not null, day text not null,
--     created_at timestamptz not null default now(),
--     revoked_at timestamptz,
--     unique (user_id, comp, day)
--   );
--
-- The reader would be a `security definer` function taking the token and
-- returning that user's notes for that day, rather than a select policy widened
-- to anon. A policy would have to authenticate the token out of a request header
-- to work from the browser's anon key; a function keeps this table's policies as
-- they are — owner-only, no exceptions — and makes the function the single door.
-- That is also what lets a share be revoked without touching any note.
