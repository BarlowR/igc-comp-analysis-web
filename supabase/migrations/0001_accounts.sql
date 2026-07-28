-- 0001 — accounts: profiles + pilot claims.
--
-- The site is static and talks to Supabase straight from the browser with the
-- anon key, so row-level security here IS the security boundary — there is no
-- server of ours in between. See docs/decisions/0001-user-accounts.md.
--
-- Apply with: supabase db push   (or paste into the SQL editor).

-- ---------------------------------------------------------------- profiles --
-- One row per auth user. Public-readable because display names hang off
-- annotations and pilot claims, which are public.
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are readable by everyone"
  on public.profiles for select
  using (true);

create policy "a user inserts only their own profile"
  on public.profiles for insert to authenticated
  with check (auth.uid() = id);

create policy "a user updates only their own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Create the profile row on signup so the app never has to handle "signed in
-- but no profile yet". security definer: the trigger runs as the table owner
-- because the signing-up user has no rights on public.profiles yet.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------- pilot_claims --
-- "This pilot in this comp is me."
--
-- Pilot identity in the archive is a display name parsed out of the IGC header
-- or the filename, and it is dirty: inconsistent case, stray numeric suffixes,
-- trailing spaces, occasional blanks. Worse, the per-comp entry number in the
-- filename is NOT stable across comps (Bill Belcourt is .4 in chelan2026 and .3
-- in chelan-us-open-2026), so a pilot's history cannot be inferred from the
-- archive at all. Claims are what stitch it together.
--
-- pilot_key is the normalised join key (see slugifyPilot in src/lib/pilots.ts);
-- pilot_label keeps the name as it was displayed when claimed.
create table if not exists public.pilot_claims (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  comp        text not null,
  pilot_key   text not null,
  pilot_label text,
  verified    boolean not null default false,
  created_at  timestamptz not null default now(),
  -- One account per pilot per comp: first claim wins, rather than two people
  -- both claiming the same result.
  unique (comp, pilot_key)
);

create index if not exists pilot_claims_user_id_idx on public.pilot_claims (user_id);

alter table public.pilot_claims enable row level security;

create policy "claims are readable by everyone"
  on public.pilot_claims for select
  using (true);

create policy "a user creates only their own claims"
  on public.pilot_claims for insert to authenticated
  with check (auth.uid() = user_id);

create policy "a user deletes only their own claims"
  on public.pilot_claims for delete to authenticated
  using (auth.uid() = user_id);

-- No update policy: a claim is created or dropped, never edited. That also
-- means `verified` can't be flipped from the client — it is set out-of-band by
-- an organiser (service role) once we have a verification story. Belt and
-- braces, force it false on the way in.
create or replace function public.force_unverified_claim()
returns trigger
language plpgsql
as $$
begin
  new.verified := false;
  return new;
end;
$$;

drop trigger if exists pilot_claims_force_unverified on public.pilot_claims;
create trigger pilot_claims_force_unverified
  before insert on public.pilot_claims
  for each row execute function public.force_unverified_claim();
