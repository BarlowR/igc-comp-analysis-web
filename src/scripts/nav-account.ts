// The session-derived bits of chrome that run on every page: the nav account
// chip, and the "sign in" hint on links to account-only features.
//
// Runs everywhere, so it deliberately does NOT load supabase-js — it reads the
// persisted session out of localStorage. See readCachedSession() for why that's
// safe here.
import { isConfigured, readCachedSession } from '../lib/supabase';

if (isConfigured) {
  const session = readCachedSession();

  const slot = document.getElementById('nav-account');
  if (slot) {
    const link = document.createElement('a');
    link.href = '/account';
    link.className = 'nav-account-link';

    if (session) {
      const label = session.displayName?.trim() || session.email?.split('@')[0] || 'Account';
      link.textContent = label;
      link.title = session.email ?? 'Account';
    } else {
      link.textContent = 'Sign in';
    }

    if (window.location.pathname.startsWith('/account')) link.classList.add('active');
    slot.replaceChildren(link);
  }

  // Entry points to account-only features (today: the 3D viewer) carry a hint
  // that stays hidden for signed-in users, so a signed-out click isn't a
  // surprise trip to a sign-in wall.
  if (!session) {
    for (const note of document.querySelectorAll<HTMLElement>('[data-account-only-note]')) {
      note.removeAttribute('hidden');
    }
  }
}
