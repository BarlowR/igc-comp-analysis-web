// Claiming a result on an archived day page.
//
// The control lives in the pinned pilot's breakdown panel: pin a pilot, and if
// you're signed in you can say that result is yours. Claims here are scoped to
// this one task and assert nothing about the name, which is what makes them
// usable when the tracker was borrowed or shared.
//
// If you've already claimed a result on this task, it gets pinned on load.
//
// The day page already ships ~2 MB of results JSON, so the 209 KB Supabase SDK
// is only fetched once readCachedSession() says someone is signed in. Signed-out
// visitors pay nothing and see nothing.
import { claimDay, listMyClaimsForDay, removeClaim, type PilotClaim } from '../lib/claims';
import { slugifyPilot } from '../lib/pilots';
import { isConfigured, readCachedSession } from '../lib/supabase';
import { setRenderHooks, type Selection } from './analysis';

interface DayRef {
  comp: string;
  day: string;
}

/** Claims covering this day, once loaded. */
let claims: PilotClaim[] | null = null;
/** The control currently on screen, so it can be repainted when state changes. */
let mounted: { pilot: string; node: HTMLElement } | null = null;
let selection: Selection | null = null;
let autoPinned = false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function claimFor(pilot: string): PilotClaim | undefined {
  const key = slugifyPilot(pilot);
  return claims?.find((c) => c.pilot_key === key);
}

function setStatus(node: HTMLElement, message: string, kind: 'ok' | 'error' | '' = '') {
  const status = node.querySelector('.day-claim-status');
  if (!(status instanceof HTMLElement)) return;
  status.textContent = message;
  status.className = kind ? `day-claim-status ${kind}` : 'day-claim-status';
}

/** Repaint the control in place — pinnedExtra is synchronous, the data isn't. */
function paint(node: HTMLElement, pilot: string, ref: DayRef) {
  const status = el('span', 'day-claim-status');

  if (claims === null) {
    node.replaceChildren(el('span', 'day-claim-note', 'Checking your claims…'));
    return;
  }

  const existing = claimFor(pilot);
  if (existing) {
    node.replaceChildren(
      el(
        'span',
        'day-claim-note',
        existing.day === null ? 'Claimed by you for this comp' : 'Claimed by you',
      ),
    );
    // A comp-wide claim is managed on the account page: dropping it here would
    // silently take this pilot's other tasks with it.
    if (existing.day !== null) {
      const drop = el('button', 'claim-remove', 'Remove');
      drop.type = 'button';
      drop.addEventListener('click', async () => {
        drop.disabled = true;
        setStatus(node, 'Removing…');
        try {
          await removeClaim(existing.id);
          claims = (claims ?? []).filter((c) => c.id !== existing.id);
          paint(node, pilot, ref);
        } catch (err) {
          setStatus(node, describe(err), 'error');
          drop.disabled = false;
        }
      });
      node.appendChild(drop);
    }
    node.appendChild(status);
    return;
  }

  const button = el('button', 'account-btn small', 'This is my result');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus(node, 'Claiming…');
    try {
      await claimDay(ref.comp, ref.day, slugifyPilot(pilot), pilot);
      claims = await listMyClaimsForDay(ref.comp, ref.day);
      paint(node, pilot, ref);
    } catch (err) {
      setStatus(node, describe(err), 'error');
      button.disabled = false;
    }
  });
  node.replaceChildren(button, status);
}

/** Pin the user's own result once we know what it is. */
function autoPin(pilots: string[]) {
  if (autoPinned || !selection || !claims?.length) return;
  if (selection.highlight()) return; // the user already pinned something
  const keys = new Set(claims.map((c) => c.pilot_key));
  const mine = pilots.find((p) => keys.has(slugifyPilot(p)));
  if (!mine) return;
  autoPinned = true;
  // Pinning a pilot who isn't selected would highlight a track nobody can see,
  // so make sure they're on first. setMany re-renders; togglePin then paints.
  if (!selection.has(mine)) selection.setMany([mine], true);
  selection.togglePin(mine);
}

function readDayRef(): DayRef | null {
  const raw = document.getElementById('archive-entry')?.textContent;
  if (!raw) return null;
  // "/archive/<comp>/<day>"
  const parts = ((JSON.parse(raw) as { base?: string }).base ?? '').split('/').filter(Boolean);
  return parts.length >= 3 ? { comp: parts[1], day: parts[2] } : null;
}

/**
 * Install the claim hooks. Call before renderArchivedResults so the first
 * render already has them.
 */
export function installDayClaim(): void {
  if (!isConfigured || !readCachedSession()) return;
  const ref = readDayRef();
  if (!ref) return;

  setRenderHooks({
    pinnedExtra(pilot) {
      const node = el('div', 'day-claim');
      mounted = { pilot, node };
      paint(node, pilot, ref);
      return node;
    },
    onReady(sel, pilots) {
      selection = sel;
      autoPin(pilots);
    },
  });

  void listMyClaimsForDay(ref.comp, ref.day)
    .then((rows) => {
      claims = rows;
      if (mounted) paint(mounted.node, mounted.pilot, ref);
      if (selection) autoPin(selection.all());
    })
    .catch(() => {
      // An expired cached session lands here. Nothing to show; the nav chip and
      // the account page handle re-authenticating.
      claims = [];
      if (mounted) mounted.node.replaceChildren();
    });
}
