-- 0009 — remove profiles: the display name did nothing.
--
-- The only reader was the nav chip, which already fell back to the email when
-- no name was set — which was almost always. The account's email is now its
-- one name, the same identity the Supabase dashboard shows. Removing the table
-- also removes the public profiles/pilot_claims join surface flagged in
-- ARCHITECTURE_REVIEW.md.
--
-- Old display_name values may linger in auth.users.raw_user_meta_data; nothing
-- reads them.
--
-- Apply with: supabase db push   (or paste into the SQL editor).

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists public.profiles;
