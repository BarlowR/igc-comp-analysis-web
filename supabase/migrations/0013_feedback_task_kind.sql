-- 0013 — feedback.kind gains 'task': a request to add a comp or task to the
-- archive. Filed from the "Missing a comp or a task?" row on /archive
-- (/feedback?kind=task). Triage as for ideas: informational in the gate,
-- cleared by setting resolved_at.
--
-- Apply with: supabase db push   (or paste into the SQL editor).

alter table public.feedback drop constraint if exists feedback_kind_check;
alter table public.feedback
  add constraint feedback_kind_check check (kind in ('bug', 'idea', 'task'));
