/**
 * /feedback — one insert into public.feedback (migration 0012), nothing else.
 *
 * Signed out is fine: the insert policy admits anon with a null user_id. When a
 * session is cached the user_id is stamped and the contact field is dropped —
 * the account email already says how to reach them. The "website" input is a
 * honeypot: humans never see it, so a filled value is a bot and the submit
 * pretends to succeed.
 */
import { getSupabase, isConfigured, readCachedSession } from '../lib/supabase';
import { readBreadcrumbs } from '../lib/breadcrumbs';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const form = $<HTMLFormElement>('feedback-form');
const body = $<HTMLTextAreaElement>('feedback-body');
const kind = $<HTMLSelectElement>('feedback-kind');
const page = $<HTMLInputElement>('feedback-page');
const contact = $<HTMLInputElement>('feedback-contact');
const honeypot = $<HTMLInputElement>('feedback-hp');
const submit = $<HTMLButtonElement>('feedback-submit');
const status = $<HTMLParagraphElement>('feedback-status');

if (!isConfigured) {
  $('feedback-unconfigured').hidden = false;
  $('feedback-card').hidden = true;
}

// Prefill "where" with the page that linked here, when it's one of ours.
try {
  const ref = document.referrer ? new URL(document.referrer) : null;
  if (ref && ref.origin === location.origin && ref.pathname !== location.pathname) {
    page.value = ref.pathname;
  }
} catch {
  // Malformed referrer — leave the field empty.
}

const session = readCachedSession();
if (session) $('feedback-contact-row').hidden = true;

// Field titles follow the kind: a bug report asks what broke and where, an
// idea asks what's missing and where it would live.
const COPY = {
  bug: {
    body: 'What happened?',
    bodyPh: 'What did you do, and what did the site do instead?',
    where: 'Where did it happen?',
    wherePh: 'Page, or comp and day, if it’s about a specific one',
  },
  idea: {
    body: 'What would you like?',
    bodyPh: 'The thing you wanted to do that the site doesn’t do',
    where: 'Where would it fit?',
    wherePh: 'Page or part of the site, if it applies',
  },
} as const;
const applyCopy = (): void => {
  const c = COPY[kind.value as keyof typeof COPY] ?? COPY.bug;
  $('feedback-body-label').textContent = c.body;
  body.placeholder = c.bodyPh;
  $('feedback-page-label').textContent = c.where;
  page.placeholder = c.wherePh;
  $('feedback-trail-note').hidden = kind.value !== 'bug';
};
kind.addEventListener('change', applyCopy);
applyCopy();

const setStatus = (text: string, cls?: 'ok' | 'error'): void => {
  status.textContent = text;
  status.className = `form-status${cls ? ` ${cls}` : ''}`;
};

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const text = body.value.trim();
    if (!text) {
      // `required` passes for whitespace; say why nothing happened.
      setStatus('Write a sentence or two first.', 'error');
      return;
    }
    if (honeypot.value) {
      // A bot: swallow it and look successful.
      setStatus('Thanks — sent.', 'ok');
      form.reset();
      applyCopy();
      return;
    }
    submit.disabled = true;
    setStatus('Sending…');
    try {
      const sb = await getSupabase();
      // Re-read the live session: the cached peek can be stale either way.
      const {
        data: { session: live },
      } = await sb.auth.getSession();
      // Bugs carry debugging context: device snapshot + the visit's breadcrumb
      // trail. Ideas don't need it, so they don't send it.
      const context =
        kind.value === 'bug'
          ? {
              ua: navigator.userAgent,
              viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio || 1}x`,
              signedIn: Boolean(live),
              trail: readBreadcrumbs(),
            }
          : null;
      // The cached peek that hid the contact row can be stale (revoked on
      // another device). When the live check disagrees, unhide the row so the
      // page stops lying; the contact value is taken as typed either way —
      // empty when the row was hidden, kept even for signed-in reporters.
      if (!live) $('feedback-contact-row').hidden = false;
      const { error } = await sb.from('feedback').insert({
        kind: kind.value,
        body: text,
        page: page.value.trim() || null,
        contact: contact.value.trim() || null,
        context,
        user_id: live?.user.id ?? null,
      });
      if (error) throw error;
      setStatus('Thanks — sent.', 'ok');
      form.reset();
      applyCopy();
    } catch (err) {
      setStatus(`Couldn't send: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      submit.disabled = false;
    }
  })();
});
