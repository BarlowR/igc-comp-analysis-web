/**
 * Breadcrumbs: a small ring buffer of "what just happened this visit", kept in
 * sessionStorage so it survives page navigations and dies with the tab.
 *
 * Written by src/scripts/breadcrumbs.ts on every page (views, clicks, script
 * errors); read by the /feedback form, which attaches the trail to bug
 * reports. Nothing here leaves the browser on its own — the only exit is a
 * submitted report. Also the natural seam for usage analytics later: a beacon
 * would hang off record().
 */

export interface Crumb {
  /** Epoch ms. */
  t: number;
  /** What kind: 'view' | 'click' | 'error'. */
  e: string;
  /** Short detail — a path, a control label, an error message. */
  d: string;
}

const KEY = 'oc-breadcrumbs';
const MAX_CRUMBS = 30;
const MAX_DETAIL = 120;

/** Truncate without splitting a surrogate pair: a lone high surrogate would
 * serialize to an unpaired \ud8xx escape, which Postgres jsonb rejects —
 * failing the whole feedback insert, stickily, until the crumb rotates out. */
const clip = (s: string): string => {
  const cut = s.slice(0, MAX_DETAIL);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/** Read AND sanitize: storage content is user-editable, so shape and size are
 * re-enforced here, not just at record() time. */
export function readBreadcrumbs(): Crumb[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c): c is Crumb =>
          typeof c === 'object' && c !== null &&
          typeof (c as Crumb).t === 'number' &&
          typeof (c as Crumb).e === 'string' &&
          typeof (c as Crumb).d === 'string',
      )
      .slice(-MAX_CRUMBS)
      .map((c) => ({ t: c.t, e: clip(c.e), d: clip(c.d) }));
  } catch {
    return []; // private mode / storage blocked / corrupted
  }
}

export function record(e: string, d: string): void {
  try {
    const crumbs = readBreadcrumbs();
    crumbs.push({ t: Date.now(), e, d: clip(d) });
    sessionStorage.setItem(KEY, JSON.stringify(crumbs.slice(-MAX_CRUMBS)));
  } catch {
    // Storage unavailable — the trail is a nice-to-have, never an error.
  }
}
