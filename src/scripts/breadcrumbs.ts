/**
 * Site-wide breadcrumb wiring (imported by Base.astro on every page):
 * records the page view, clicks on meaningful controls, and script errors
 * into the sessionStorage ring buffer (src/lib/breadcrumbs.ts).
 */
import { record } from '../lib/breadcrumbs';

record('view', location.pathname);

// Clicks: only controls, labeled by the most stable thing they carry. The
// capture phase sees clicks even when a handler stops propagation.
document.addEventListener(
  'click',
  (ev) => {
    const el = (ev.target as Element | null)?.closest?.('a, button, summary, [role="tab"]');
    if (!el) return;
    const label =
      el.id ||
      el.getAttribute('aria-label') ||
      (el instanceof HTMLAnchorElement && el.getAttribute('href')) ||
      el.textContent?.trim().replace(/\s+/g, ' ') ||
      el.tagName.toLowerCase();
    record('click', label);
  },
  { capture: true, passive: true },
);

window.addEventListener('error', (ev) => {
  const where = ev.filename ? ` @ ${ev.filename.split('/').pop()}:${ev.lineno}` : '';
  record('error', `${ev.message}${where}`);
});
window.addEventListener('unhandledrejection', (ev) => {
  const r: unknown = ev.reason;
  record('error', `unhandled rejection: ${r instanceof Error ? r.message : String(r)}`);
});
