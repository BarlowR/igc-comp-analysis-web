// The session-derived bits of chrome that run on every page: the nav account
// chip, and the "sign in" hint on links to account-only features.
//
// Runs everywhere, so it deliberately does NOT load supabase-js — it reads the
// persisted session out of localStorage. See readCachedSession() for why that's
// safe here.
import { isConfigured, readCachedSession } from '../lib/supabase';

/**
 * (Re)paint the chrome from the cached session. Runs once on every page load;
 * the account page calls it again after sign-in, sign-out and account
 * deletion, so the chip changes with the session instead of showing the old
 * identity until the next full page load.
 */
export function refreshNavAccount(): void {
  if (!isConfigured) return;
  const session = readCachedSession();

  const slot = document.getElementById('nav-account');
  if (slot) {
    const link = document.createElement('a');
    link.href = '/account';
    link.className = 'nav-account-link';

    if (session) {
      // The email IS the username — same identity Supabase shows. The chip
      // keeps just the local part so the nav stays compact; the full address
      // sits in the tooltip and on the account page.
      link.textContent = session.email?.split('@')[0] || 'Account';
      link.title = session.email ?? 'Account';
    } else {
      link.textContent = 'Sign in';
    }

    if (window.location.pathname.startsWith('/account')) link.classList.add('active');
    slot.replaceChildren(link);
  }

  // Notebooks is an account-only page; its nav tab only exists for a session.
  // The cached peek suffices — the page itself gates properly on open.
  document.getElementById('nav-notebooks')?.toggleAttribute('hidden', !session);

  // Entry points to account-only features (today: the 3D viewer) carry a hint
  // that stays hidden for signed-in users, so a signed-out click isn't a
  // surprise trip to a sign-in wall.
  for (const note of document.querySelectorAll<HTMLElement>('[data-account-only-note]')) {
    note.toggleAttribute('hidden', Boolean(session));
  }
}

refreshNavAccount();
