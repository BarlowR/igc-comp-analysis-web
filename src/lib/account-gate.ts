// The signed-in gate for account-only pages (/saved, /notebooks): the pages
// that are meaningless without a session, so a signed-out visitor is sent
// through sign-in and straight back (the account page honours ?next=).
//
// The ladder, in order:
//   1. accounts not configured in this build — say so, stop;
//   2. no session ever stored on this device — redirect without loading the
//      SDK, nothing here could work;
//   3. a stored token — load the SDK and let it refresh. Expired-but-stored is
//      NOT redirected up front: supabase-js revives those, and currentUser()
//      waits for it. Only a token that can't be refreshed goes to sign-in —
//      without that check the page's queries would run as anon and read as
//      "you have nothing" rather than "signed out".
import { describeError } from './dom';
import { currentUser, hasStoredSession, isConfigured } from './supabase';

export async function gateAccountPage(
  setStatus: (message: string) => void,
  run: () => Promise<void>,
): Promise<void> {
  if (!isConfigured) {
    setStatus('Accounts are not configured in this build.');
    return;
  }

  const here = `${window.location.pathname}${window.location.search}`;
  const signIn = (): void => window.location.replace(`/account?next=${encodeURIComponent(here)}`);
  if (!hasStoredSession()) {
    signIn();
    return;
  }

  try {
    setStatus('Checking your session…');
    if (!(await currentUser())) {
      signIn();
      return;
    }
    await run();
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${describeError(err)}`);
  }
}
