// Nav account chip. Runs on every page, so it deliberately does NOT load
// supabase-js — it reads the persisted session out of localStorage and renders
// a name or a "Sign in" link. See readCachedSession() for why that's safe here.
import { isConfigured, readCachedSession } from '../lib/supabase';

const slot = document.getElementById('nav-account');

if (slot && isConfigured) {
  const session = readCachedSession();
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
