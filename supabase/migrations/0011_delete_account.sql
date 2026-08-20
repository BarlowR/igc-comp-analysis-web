-- Self-service account deletion (the "Delete account" button on /account).
--
-- The client holds only the anon key, which cannot touch auth.users — so a
-- security-definer function does the deletion, scoped hard to the caller.
-- Every public.* user table references auth.users on delete cascade
-- (pilot_claims, annotations, comp_notes, saved_comps, user_comps, notebooks,
-- notebook_notes), so the single delete removes all of the account's rows.
--
-- Storage: the client empties its saved-comps folders first through the
-- normal API path (owners hold delete rights on their folder — migration
-- 0006), which is the clean way to remove objects. The sweep here only
-- catches rows a half-finished upload left behind; it removes the reference
-- (the file becomes unreachable) even where the backing blob lingers.

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

  delete from storage.objects
   where bucket_id = 'saved-comps'
     and (storage.foldername(name))[1] = auth.uid()::text;

  delete from auth.users where id = auth.uid();
end;
$$;

-- Executable by signed-in users only; it acts on the caller alone either way.
revoke execute on function public.delete_account() from public;
revoke execute on function public.delete_account() from anon;
grant execute on function public.delete_account() to authenticated;
