-- Self-service account deletion (the "Delete account" button on /account).
--
-- The client holds only the anon key, which cannot touch auth.users — so a
-- security-definer function does the deletion, scoped hard to the caller.
-- Every public.* user table references auth.users on delete cascade
-- (pilot_claims, annotations, comp_notes, saved_comps, user_comps, notebooks,
-- notebook_notes), so the single delete removes all of the account's rows.
--
-- Storage is NOT touched here: direct deletes on storage.objects are not
-- allowed, so the client empties its saved-comps folder first through the
-- Storage API (owners hold delete rights on their folder — migration 0006;
-- see emptyMyStorage in src/lib/saved-comps.ts). The client must finish that
-- before calling this: once the user row is gone, the folder's RLS owner
-- check can never match again and the objects become undeletable.

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  delete from auth.users where id = auth.uid();
end;
$$;

-- Executable by signed-in users only; it acts on the caller alone either way.
revoke execute on function public.delete_account() from public;
revoke execute on function public.delete_account() from anon;
grant execute on function public.delete_account() to authenticated;
