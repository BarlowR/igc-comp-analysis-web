// Account page island: passwordless sign-in, display name, sign out.
//
// The site is static, so this is the whole auth flow — supabase-js emails a
// magic link, the link lands back on /account with ?code=…, and the client
// exchanges it for a session on load (detectSessionInUrl in lib/supabase.ts).
import {
  fetchProfile,
  getSupabase,
  isConfigured,
  readCachedSession,
  saveDisplayName,
} from '../lib/supabase';
import { mountClaims } from './account-claims';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const unconfigured = el('account-unconfigured');
const loading = el('account-loading');
const signedOut = el('account-signed-out');
const signedIn = el('account-signed-in');

const signInForm = el<HTMLFormElement>('signin-form');
const emailInput = el<HTMLInputElement>('signin-email');
const signInButton = el<HTMLButtonElement>('signin-submit');
const signInStatus = el('signin-status');

const emailLabel = el('account-email');
const nameForm = el<HTMLFormElement>('name-form');
const nameInput = el<HTMLInputElement>('display-name');
const nameStatus = el('name-status');
const signOutButton = el<HTMLButtonElement>('sign-out');

function show(section: HTMLElement | null) {
  for (const s of [unconfigured, loading, signedOut, signedIn]) s?.toggleAttribute('hidden', s !== section);
}

function setStatus(node: HTMLElement | null, message: string, kind: 'ok' | 'error' | '' = '') {
  if (!node) return;
  node.textContent = message;
  node.className = kind ? `form-status ${kind}` : 'form-status';
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Supabase rate-limits magic links per address; say something useful.
  if (/rate limit|too many/i.test(message)) return 'Too many sign-in emails. Try again in a few minutes.';
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
  return path && path.startsWith('/') && !path.startsWith('//') ? path : null;
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

async function renderSignedIn(email: string | null) {
  if (emailLabel) emailLabel.textContent = email ?? '';
  show(signedIn);

  // Profile and claims are independent round-trips; run them together rather
  // than making the claim list wait on the display name.
  const profilePromise = fetchProfile()
    .then((profile) => {
      // Don't clobber something the user has started typing while we waited.
      if (nameInput && document.activeElement !== nameInput) {
        nameInput.value = profile?.display_name ?? '';
      }
    })
    .catch((err: unknown) => setStatus(nameStatus, describe(err), 'error'));

  const claimsPromise = claimsMounted ? Promise.resolve() : ((claimsMounted = true), mountClaims());
  await Promise.all([profilePromise, claimsPromise]);
}

/**
 * Paint what the stored session already tells us — that you're signed in, your
 * email, your display name — before supabase-js has even been fetched. Without
 * this the panel sits blank for a second or two on every load while the SDK
 * downloads and the profile query round-trips, which reads as "no username set"
 * rather than "still loading".
 */
function prefillFromCache(): boolean {
  const cached = readCachedSession();
  if (!cached) return false;
  if (emailLabel) emailLabel.textContent = cached.email ?? '';
  if (nameInput && cached.displayName) nameInput.value = cached.displayName;
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

  const sb = await getSupabase();

  // A failed or expired link comes back as an error in the hash, not a throw.
  const hashError = new URLSearchParams(window.location.hash.slice(1)).get('error_description');

  const {
    data: { session },
  } = await sb.auth.getSession();
  cleanUrl();

  if (session?.user) {
    // A refresh may have revived a stale session, or the magic link may have
    // just been exchanged — either way, honour a pending return path.
    const dest = takeNext();
    if (dest) {
      window.location.replace(dest);
      return;
    }
    await renderSignedIn(session.user.email ?? null);
  } else {
    show(signedOut);
    if (hashError) setStatus(signInStatus, hashError, 'error');
  }

  // Keeps the page honest across tabs, token refreshes and the link exchange.
  sb.auth.onAuthStateChange((event, next) => {
    if (event === 'SIGNED_OUT') {
      show(signedOut);
      setStatus(signInStatus, '');
    } else if (next?.user && event === 'SIGNED_IN') {
      const dest = takeNext();
      if (dest) {
        window.location.replace(dest);
        return;
      }
      void renderSignedIn(next.user.email ?? null);
    }
  });
}

signInForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = emailInput?.value.trim();
  if (!email) return;

  // Park the return path now: the link lands back on a bare /account, possibly
  // in another tab, so the URL can't carry it. (Nor should it — putting a query
  // on emailRedirectTo risks missing Supabase's redirect allow-list.)
  if (nextParam) rememberNext(nextParam);

  if (signInButton) signInButton.disabled = true;
  setStatus(signInStatus, 'Sending…');
  try {
    const sb = await getSupabase();
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/account` },
    });
    if (error) throw error;
    setStatus(signInStatus, `Check ${email} for a sign-in link.`, 'ok');
    signInForm.reset();
  } catch (err) {
    setStatus(signInStatus, describe(err), 'error');
  } finally {
    if (signInButton) signInButton.disabled = false;
  }
});

nameForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(nameStatus, 'Saving…');
  try {
    await saveDisplayName(nameInput?.value ?? '');
    setStatus(nameStatus, 'Saved.', 'ok');
  } catch (err) {
    setStatus(nameStatus, describe(err), 'error');
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
    setStatus(nameStatus, describe(err), 'error');
  } finally {
    signOutButton.disabled = false;
  }
});

void init();
