-- 0012 — feedback: bug reports and feature requests from the /feedback form.
--
-- Write-only through the API: anyone (signed in or not) may insert, nobody may
-- read, update, or delete — there are no policies for those, so reports are
-- read in the dashboard or SQL editor. user_id is stamped when the reporter is
-- signed in; contact is a free-text way to reach an anonymous reporter.
--
-- Triage lives in resolved_at: the feedback-gate GitHub Action fails while any
-- bug has resolved_at null. Clear one with:
--   update public.feedback set resolved_at = now() where id = '…';
--
-- Apply with: supabase db push   (or paste into the SQL editor).

create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind       text not null check (kind in ('bug', 'idea')),
  body       text not null,
  -- Where it happened: a site path, prefilled from the referring page.
  page       text,
  contact    text,
  -- Bug reports only: device snapshot + the reporter's recent-activity trail
  -- (src/lib/breadcrumbs.ts). Sent by the form, never collected server-side.
  context    jsonb,
  -- set null, not cascade: a report stays useful after its account is deleted,
  -- and keeping it anonymized is the deliberate retention choice.
  user_id    uuid references auth.users on delete set null,
  -- Triage marker (see header). Only ever set from the dashboard/SQL editor —
  -- no update policy exists, so the API can't touch it.
  resolved_at timestamptz,
  constraint feedback_body_length check (char_length(body) between 1 and 5000),
  constraint feedback_page_length check (page is null or char_length(page) <= 300),
  constraint feedback_contact_length check (contact is null or char_length(contact) <= 200),
  constraint feedback_context_size check (context is null or pg_column_size(context) <= 16384)
);

alter table public.feedback enable row level security;

-- Accepted risk: the anon key is public, the honeypot is client-side, and
-- there is no rate limit — a script could spam rows. Fine at this site's
-- scale; if it bites, the escalations are authenticated-only insert, a per-IP
-- limit in an Edge Function, or a captcha.
drop policy if exists "anyone files feedback, only as themselves" on public.feedback;
create policy "anyone files feedback, only as themselves"
  on public.feedback for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());
