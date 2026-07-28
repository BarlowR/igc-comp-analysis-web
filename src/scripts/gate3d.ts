/**
 * Sign-in gate for the 3D viewer.
 *
 * The 3D replay is account-only. The page imports this instead of track3d.ts,
 * and the viewer is only pulled in — dynamically — once a session checks out.
 * That ordering matters: Cesium plus a comp day's results JSON is by far the
 * heaviest thing this site serves, and a signed-out visitor now downloads
 * neither.
 *
 * This is a UI gate, not a security boundary, and can't be more than that on a
 * static site: the day JSON under /archive is public and this page's HTML is
 * prerendered, so anyone with devtools can still reach the data. What it gates
 * is the *feature* — which is what "you need an account for the 3D view" means
 * here. Real gating needs server rendering; see
 * docs/decisions/0001-user-accounts.md.
 */
import { getSupabase, hasStoredSession, isConfigured, readCachedSession } from '../lib/supabase';
import { makeLoading, removeLoading } from './loading-overlay';

/** Hand over to the real viewer. Dynamic so Cesium stays out of the gate's chunk. */
const loadViewer = (): Promise<unknown> => import('./track3d');

function setStep(message: string): void {
  makeLoading().step(message);
}

/** Swap the loading overlay for the sign-in panel, pointed back at this page. */
function showGate(): void {
  removeLoading();
  const link = document.getElementById('gate3d-signin') as HTMLAnchorElement | null;
  if (link) link.href = `/account?next=${encodeURIComponent(window.location.pathname)}`;
  document.getElementById('gate3d')?.removeAttribute('hidden');
}

async function gate(): Promise<void> {
  // Accounts are off in this build (no Supabase credentials), so nobody could
  // sign in even if they wanted to. Gating would just break the viewer.
  if (!isConfigured) {
    await loadViewer();
    return;
  }

  // Fast path: a live session in localStorage opens the viewer for free — no
  // supabase-js on this page at all.
  if (readCachedSession()) {
    await loadViewer();
    return;
  }

  // Nothing stored: never signed in here. Gate straight away.
  if (!hasStoredSession()) {
    showGate();
    return;
  }

  // Something is stored but didn't pass — usually just an expired access token,
  // which supabase-js refreshes itself. Worth the SDK load rather than bouncing
  // a genuinely signed-in user to the sign-in page.
  setStep('Checking your account…');
  try {
    const sb = await getSupabase();
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (session?.user) {
      await loadViewer();
      return;
    }
  } catch {
    // Supabase unreachable, or the refresh failed. Gate rather than open the
    // viewer, so the rule still holds when we can't check it.
  }
  showGate();
}

void gate();
