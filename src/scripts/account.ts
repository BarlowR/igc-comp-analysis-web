// Account page island: passwordless sign-in, display name, sign out.
//
// The site is static, so this is the whole auth flow — supabase-js emails a
// magic link, the link lands back on /account with ?code=…, and the client
// exchanges it for a session on load (detectSessionInUrl in lib/supabase.ts).
import { fetchProfile, getSupabase, isConfigured, saveDisplayName } from '../lib/supabase';

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

async function renderSignedIn(email: string | null) {
  if (emailLabel) emailLabel.textContent = email ?? '';
  show(signedIn);
  try {
    const profile = await fetchProfile();
    if (nameInput) nameInput.value = profile?.display_name ?? '';
  } catch (err) {
    setStatus(nameStatus, describe(err), 'error');
  }
}

async function init() {
  if (!isConfigured) {
    show(unconfigured);
    return;
  }
  show(loading);

  const sb = await getSupabase();

  // A failed or expired link comes back as an error in the hash, not a throw.
  const hashError = new URLSearchParams(window.location.hash.slice(1)).get('error_description');

  const {
    data: { session },
  } = await sb.auth.getSession();
  cleanUrl();

  if (session?.user) {
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
      void renderSignedIn(next.user.email ?? null);
    }
  });
}

signInForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = emailInput?.value.trim();
  if (!email) return;

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
