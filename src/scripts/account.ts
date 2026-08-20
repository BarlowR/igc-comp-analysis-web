// Account page island: email/password sign-in and sign-up, password change,
// sign out. The email is the account's only name — same as Supabase shows.
//
// The site is static, so this is the whole auth flow. Password sign-in needs no
// redirect at all; the email flows still do — password reset, the magic-link
// fallback for accounts from before passwords existed, and sign-up
// confirmation. Those land back on /account with ?code=…, and the client
// exchanges it for a session on load (detectSessionInUrl in lib/supabase.ts).
import { byId as el, describeError, setStatus } from '../lib/dom';
import { getSupabase, isConfigured, readCachedSession } from '../lib/supabase';
import { mountClaims } from './account-claims';

const unconfigured = el('account-unconfigured');
const loading = el('account-loading');
const signedOut = el('account-signed-out');
const signedIn = el('account-signed-in');

const signInForm = el<HTMLFormElement>('signin-form');
const emailInput = el<HTMLInputElement>('signin-email');
const passwordInput = el<HTMLInputElement>('signin-password');
const signInButton = el<HTMLButtonElement>('signin-submit');
const signUpButton = el<HTMLButtonElement>('signup-submit');
const forgotButton = el<HTMLButtonElement>('forgot-password');
const magicButton = el<HTMLButtonElement>('magic-link');
const signInStatus = el('signin-status');

const emailLabel = el('account-email');
const passwordForm = el<HTMLFormElement>('password-form');
const newPasswordInput = el<HTMLInputElement>('new-password');
const passwordStatus = el('password-status');
const signOutButton = el<HTMLButtonElement>('sign-out');
const deleteAccountButton = el<HTMLButtonElement>('delete-account');
const accountStatus = el('account-status');

function show(section: HTMLElement | null) {
  for (const s of [unconfigured, loading, signedOut, signedIn]) s?.toggleAttribute('hidden', s !== section);
}

function describe(err: unknown): string {
  const message = describeError(err);
  // Supabase rate-limits sign-in/reset emails per address; say something useful.
  if (/rate limit|too many/i.test(message)) return 'Too many sign-in emails. Try again in a few minutes.';
  // Deliberately vague server-side (it won't say whether the email exists);
  // point at the two ways out. Older accounts signed in by emailed link and
  // have no password until they set one.
  if (/invalid login credentials/i.test(message)) {
    return 'Wrong email or password.';
  }
  return message || 'Something went wrong.';
}

/** Drop the ?code=/#access_token noise the magic link leaves behind. */
function cleanUrl() {
  if (window.location.search || window.location.hash) {
    window.history.replaceState({}, '', window.location.pathname);
  }
}

// ---- returning to where sign-in was asked for ------------------------------
//
// The 3D gate sends people here as /account?next=<path>. The magic link, though,
// comes back on its own — often in a fresh tab — so the path is also parked in
// localStorage while the email is in flight, and consumed when a session turns
// up. It carries a timestamp so an abandoned attempt can't redirect an unrelated
// sign-in later; magic links expire in about an hour anyway. Opening the link on
// a different device simply lands on /account, which is a fine fallback.
//
// Only same-origin paths are honoured, so ?next= can't bounce anyone off-site.

const NEXT_KEY = 'igc-signin-next';
const NEXT_TTL_MS = 60 * 60 * 1000;

function safePath(path: string | null | undefined): string | null {
  if (!path) return null;
  // Resolve it the way the browser will before deciding. A string test isn't
  // enough: "/\evil.com" starts with a single slash but the URL parser reads the
  // backslash as a slash, so location.replace() would leave the site entirely.
  try {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** This page's ?next=, captured before cleanUrl() strips the query. */
const nextParam = safePath(new URLSearchParams(window.location.search).get('next'));

function rememberNext(path: string) {
  try {
    localStorage.setItem(NEXT_KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    // Private mode / storage blocked — sign-in still works, it just ends here.
  }
}

/** The pending return path — this page's ?next=, else a recent stored one. Clears the store. */
function takeNext(): string | null {
  let stored: string | null = null;
  try {
    const raw = localStorage.getItem(NEXT_KEY);
    if (raw) {
      localStorage.removeItem(NEXT_KEY);
      const parsed = JSON.parse(raw) as { path?: string; at?: number };
      if (parsed.at && Date.now() - parsed.at <= NEXT_TTL_MS) stored = safePath(parsed.path);
    }
  } catch {
    // Unreadable or unparseable — no return path, land on /account.
  }
  return nextParam ?? stored;
}

/** Guards against a second onAuthStateChange firing the claims mount again. */
let claimsMounted = false;

/** True after a PASSWORD_RECOVERY arrival: stay on the password form, don't redirect. */
let recovering = false;

async function renderSignedIn(email: string | null) {
  if (emailLabel) emailLabel.textContent = email ?? '';
  show(signedIn);

  if (!claimsMounted) {
    claimsMounted = true;
    await mountClaims();
  }
}

/**
 * Paint what the stored session already tells us — that you're signed in, and
 * your email — before supabase-js has even been fetched. Without this the
 * panel sits blank for a second or two on every load while the SDK downloads,
 * which reads as "signed out" rather than "still loading".
 */
function prefillFromCache(): boolean {
  const cached = readCachedSession();
  if (!cached) return false;
  if (emailLabel) emailLabel.textContent = cached.email ?? '';
  show(signedIn);
  return true;
}

async function init() {
  if (!isConfigured) {
    show(unconfigured);
    return;
  }
  // Already signed in and sent here by a gate: bounce straight back rather than
  // flashing the account page. No loop risk — the gate only links here when the
  // cached session is absent or stale.
  if (nextParam && readCachedSession()) {
    window.location.replace(nextParam);
    return;
  }

  // Show the signed-in panel straight away when the cache says so; only fall
  // back to "Checking your session…" when we genuinely don't know yet.
  if (!prefillFromCache()) show(loading);

  // The check drags on exactly when the auth service is slow or unreachable
  // (getSession() blocks on a token refresh then). After a few seconds, admit
  // that and offer the sign-in form instead of a hint nobody can act on. If the
  // check later comes back signed-in anyway, the panel simply switches over.
  const slowTimer = window.setTimeout(() => {
    el('loading-slow')?.removeAttribute('hidden');
  }, 5000);
  el<HTMLButtonElement>('loading-skip')?.addEventListener('click', () => show(signedOut));

  const sb = await getSupabase();

  // A failed or expired link comes back as an error in the hash, not a throw.
  const hashError = new URLSearchParams(window.location.hash.slice(1)).get('error_description');

  // Subscribed BEFORE getSession(): the ?code= exchange happens during the
  // client's own initialisation, and a password-reset arrival announces itself
  // only through the PASSWORD_RECOVERY event that exchange emits. Subscribing
  // after (as this used to) can miss it. The event ordering is not guaranteed,
  // so recovery also sets a flag that stops SIGNED_IN redirecting away from the
  // set-a-password form; and if the event is missed entirely, the user still
  // lands signed-in with the Change password form available — nothing is stuck.
  sb.auth.onAuthStateChange((event, next) => {
    if (event === 'SIGNED_OUT') {
      show(signedOut);
      setStatus(signInStatus, '');
    } else if (event === 'PASSWORD_RECOVERY') {
      recovering = true;
      void renderSignedIn(next?.user?.email ?? null).then(() => {
        setStatus(passwordStatus, 'Choose a new password below.', 'ok');
        newPasswordInput?.focus();
      });
    } else if (next?.user && event === 'SIGNED_IN') {
      const dest = recovering ? null : takeNext();
      if (dest) {
        window.location.replace(dest);
        return;
      }
      void renderSignedIn(next.user.email ?? null);
    }
  });

  const {
    data: { session },
  } = await sb.auth.getSession();
  window.clearTimeout(slowTimer);
  cleanUrl();

  if (session?.user) {
    // A refresh may have revived a stale session, or an emailed link may have
    // just been exchanged — either way, honour a pending return path (but not
    // mid-recovery: the point of that arrival is the password form here).
    const dest = recovering ? null : takeNext();
    if (dest) {
      window.location.replace(dest);
      return;
    }
    await renderSignedIn(session.user.email ?? null);
  } else if (!recovering) {
    show(signedOut);
    if (hashError) setStatus(signInStatus, hashError, 'error');
  }
}

// ---- password sign-in / sign-up ---------------------------------------------
// One form, two buttons: submit signs in, "Create account" signs up with the
// same fields. Password sign-in needs no email round-trip, so the SIGNED_IN
// event (and any ?next= redirect) fires immediately.

signInForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = emailInput?.value.trim();
  const password = passwordInput?.value ?? '';
  if (!email || !password) return;

  if (signInButton) signInButton.disabled = true;
  setStatus(signInStatus, 'Signing in…');
  try {
    const sb = await getSupabase();
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // The SIGNED_IN handler renders or redirects; nothing more to do here.
    setStatus(signInStatus, '');
  } catch (err) {
    setStatus(signInStatus, describe(err), 'error');
  } finally {
    if (signInButton) signInButton.disabled = false;
  }
});

signUpButton?.addEventListener('click', async () => {
  // The button is type=button so it doesn't submit; validity is checked
  // explicitly to get the browser's own messages for a bad email / short
  // password.
  if (!signInForm?.reportValidity()) return;
  const email = emailInput!.value.trim();
  const password = passwordInput!.value;

  signUpButton.disabled = true;
  setStatus(signInStatus, 'Creating account…');
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      // Only used when the project requires email confirmation: the confirm
      // link lands back here and detectSessionInUrl signs the user in.
      options: { emailRedirectTo: `${window.location.origin}/account` },
    });
    if (error) throw error;
    if (data.session) {
      setStatus(signInStatus, ''); // confirmation off — SIGNED_IN takes it from here
    } else {
      setStatus(signInStatus, `Check ${email} for a confirmation link.`, 'ok');
    }
  } catch (err) {
    setStatus(signInStatus, describe(err), 'error');
  } finally {
    signUpButton.disabled = false;
  }
});

// ---- email fallbacks ----------------------------------------------------------
// Both need only the email field. The links land back on /account, so the
// return path is parked in localStorage while the email is in flight (the URL
// can't carry it — a query on the redirect risks missing Supabase's allow-list).

/** The email field alone, validated; reports on the field if empty/invalid. */
function emailForLink(): string | null {
  const email = emailInput?.value.trim();
  if (!email || !emailInput?.checkValidity()) {
    emailInput?.reportValidity();
    emailInput?.focus();
    return null;
  }
  return email;
}

forgotButton?.addEventListener('click', async () => {
  const email = emailForLink();
  if (!email) return;

  forgotButton.disabled = true;
  setStatus(signInStatus, 'Sending…');
  try {
    const sb = await getSupabase();
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/account`,
    });
    if (error) throw error;
    setStatus(signInStatus, `Check ${email} for a password reset link.`, 'ok');
  } catch (err) {
    setStatus(signInStatus, describe(err), 'error');
  } finally {
    forgotButton.disabled = false;
  }
});

magicButton?.addEventListener('click', async () => {
  const email = emailForLink();
  if (!email) return;

  if (nextParam) rememberNext(nextParam);

  magicButton.disabled = true;
  setStatus(signInStatus, 'Sending…');
  try {
    const sb = await getSupabase();
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/account` },
    });
    if (error) throw error;
    setStatus(signInStatus, `Check ${email} for a sign-in link.`, 'ok');
  } catch (err) {
    setStatus(signInStatus, describe(err), 'error');
  } finally {
    magicButton.disabled = false;
  }
});

// ---- change / set password (signed in) ----------------------------------------

passwordForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = newPasswordInput?.value ?? '';
  if (!password) return;

  setStatus(passwordStatus, 'Saving…');
  try {
    const sb = await getSupabase();
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw error;
    recovering = false; // the reset that brought us here is complete
    passwordForm.reset();
    setStatus(passwordStatus, 'Password set.', 'ok');
  } catch (err) {
    setStatus(passwordStatus, describe(err), 'error');
  }
});

signOutButton?.addEventListener('click', async () => {
  signOutButton.disabled = true;
  try {
    const sb = await getSupabase();
    await sb.auth.signOut();
    show(signedOut);
    setStatus(signInStatus, 'Signed out.', 'ok');
  } catch (err) {
    setStatus(accountStatus, describe(err), 'error');
  } finally {
    signOutButton.disabled = false;
  }
});

// ---- delete account -----------------------------------------------------------

deleteAccountButton?.addEventListener('click', async () => {
  const sure = window.confirm(
    'Delete your account? Everything in it goes too — claimed results, notes, ' +
      'annotations, notebooks, and saved comps with their uploaded tracklogs. ' +
      'There is no undo.',
  );
  if (!sure) return;
  deleteAccountButton.disabled = true;
  try {
    // Saved-comp storage first, through the same per-comp path the saved page
    // uses — the owner's API delete is the clean removal; the delete_account
    // RPC (migration 0011) only sweeps stray object rows after it.
    setStatus(accountStatus, 'Removing saved comps…');
    const { listMyComps, deleteComp } = await import('../lib/saved-comps');
    for (const comp of await listMyComps()) await deleteComp(comp.id);

    setStatus(accountStatus, 'Deleting your account…');
    const sb = await getSupabase();
    const { error } = await sb.rpc('delete_account');
    if (error) throw error;

    // The user no longer exists server-side, so a global sign-out would just
    // 403; clear the local session and show the signed-out card.
    await sb.auth.signOut({ scope: 'local' });
    show(signedOut);
    setStatus(signInStatus, 'Your account and its data are deleted.', 'ok');
  } catch (err) {
    setStatus(accountStatus, describe(err), 'error');
    deleteAccountButton.disabled = false;
  }
});

void init().catch((err: unknown) => {
  // Reached when supabase-js itself fails to load or getSession() rejects
  // (offline, CDN failure). Without this the page sat on whichever panel was
  // last shown — possibly the cache-prefilled signed-in card — forever.
  console.error(err);
  if (signedIn?.hidden !== false) show(signedOut);
  setStatus(signedIn?.hidden === false ? accountStatus : signInStatus, describe(err), 'error');
});
