// "Your flights" on the account page: claim your name in the archive, then see
// every task you flew. Below it, "Flights you've annotated" catches the tasks
// this account has written notes on without claiming — someone else's track, or
// your own before the name is claimed.
//
// Pilot labels come out of IGC headers written by whatever instrument the pilot
// flew, so everything user-visible is built with createElement/textContent —
// never innerHTML.
import { listMyAnnotatedDays, type AnnotatedDay } from '../lib/annotations';
import { claimPilot, listMyClaims, removeClaim, type PilotClaim } from '../lib/claims';
import {
  compsForPilot,
  fetchRoster,
  searchPilots,
  type Roster,
  type RosterDay,
  type RosterPilot,
} from '../lib/roster';

const listEl = document.getElementById('claims-list');
const statusEl = document.getElementById('claims-status');
const formEl = document.getElementById('claim-form') as HTMLFormElement | null;
const queryEl = document.getElementById('claim-query') as HTMLInputElement | null;
const resultsEl = document.getElementById('claim-results');
const annotatedEl = document.getElementById('annotated-list');
const annotatedSection = document.getElementById('annotated-section');

let roster: Roster | null = null;
let claims: PilotClaim[] = [];

function setStatus(message: string, kind: 'ok' | 'error' | '' = '') {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = kind ? `form-status ${kind}` : 'form-status';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

/** The claimed pilot keys, each with the comps this user owns. */
function claimedPilots(): Map<string, PilotClaim[]> {
  const byKey = new Map<string, PilotClaim[]>();
  for (const claim of claims) {
    const list = byKey.get(claim.pilot_key);
    if (list) list.push(claim);
    else byKey.set(claim.pilot_key, [claim]);
  }
  return byKey;
}

/** The archived tasks one pilot's claims cover, in roster order. */
function daysForClaims(group: PilotClaim[], pilot: RosterPilot | undefined): RosterDay[] {
  // A name claim (day null) covers every day this pilot flew in that comp; a
  // one-off claim covers just its own day.
  const ownedComps = new Set(group.filter((c) => c.day === null).map((c) => c.comp));
  const ownedDays = new Set(group.filter((c) => c.day !== null).map((c) => `${c.comp}/${c.day}`));
  return (pilot?.flights ?? [])
    .map((i) => roster!.days[i])
    .filter((d) => d && (ownedComps.has(d.comp) || ownedDays.has(`${d.comp}/${d.day}`)));
}

/** A task row: its name, date and 3D link. Callers append their own extras. */
function dayRow(day: RosterDay): HTMLLIElement {
  const item = el('li', 'claim-day');
  const link = el('a', 'claim-day-link', day.dayLabel);
  link.href = `/archive/${day.comp}/${day.day}`;
  item.appendChild(link);
  if (day.date) item.appendChild(el('span', 'claim-day-date', day.date));

  const view3d = el('a', 'claim-day-3d', '◈ 3D');
  view3d.href = `/archive/${day.comp}/${day.day}/3d`;
  view3d.title = 'Fly this task in 3D';
  item.appendChild(view3d);
  return item;
}

/** The "N notes" pill linking into the 3D view's notes panel. */
function notesPill(day: { comp: string; day: string }, count: number): HTMLAnchorElement {
  const notes = el('a', 'claim-day-notes', `${count} note${count === 1 ? '' : 's'}`);
  notes.href = `/archive/${day.comp}/${day.day}/3d#notes`;
  notes.title = 'Open the 3D view with your notes';
  return notes;
}

function renderClaims() {
  if (!listEl) return;
  listEl.replaceChildren();

  const byKey = claimedPilots();
  if (byKey.size === 0) listEl.appendChild(el('p', 'field-hint', 'No flights claimed yet.'));

  for (const [key, group] of byKey) {
    const pilot = roster?.pilots.find((p) => p.key === key);
    const card = el('div', 'claim-card');

    const head = el('div', 'claim-card-head');
    head.appendChild(el('span', 'claim-name', group[0].pilot_label ?? pilot?.label ?? key));

    const drop = el('button', 'claim-remove', 'Remove');
    drop.type = 'button';
    drop.addEventListener('click', async () => {
      drop.disabled = true;
      setStatus('Removing…');
      try {
        for (const claim of group) await removeClaim(claim.id);
        claims = claims.filter((c) => c.pilot_key !== key);
        setStatus('');
        renderClaims();
      } catch (err) {
        setStatus(describe(err), 'error');
        drop.disabled = false;
      }
    });
    head.appendChild(drop);
    card.appendChild(head);

    const days = daysForClaims(group, pilot);

    if (days.length === 0) {
      card.appendChild(el('p', 'field-hint', 'No archived tasks found for this pilot.'));
    } else {
      let lastComp = '';
      const list = el('ul', 'claim-days');
      for (const day of days) {
        if (day.comp !== lastComp) {
          lastComp = day.comp;
          list.appendChild(el('li', 'claim-comp', day.compLabel));
        }
        const item = dayRow(day);

        // Sits at the right, and only appears for tasks that actually carry
        // notes — the count arrives after the list is painted (and not at all if
        // the annotations table isn't reachable), so it starts hidden.
        const notes = el('a', 'claim-day-notes');
        notes.href = `/archive/${day.comp}/${day.day}/3d#notes`;
        notes.hidden = true;
        notes.dataset.dayKey = `${day.comp}/${day.day}`;
        item.appendChild(notes);

        list.appendChild(item);
      }
      card.appendChild(list);
    }

    listEl.appendChild(card);
  }

  void paintAnnotations();
}

/**
 * Fold this account's notes into the page: a count on every claimed task that
 * carries them, and a section listing the annotated tasks that no claim covers.
 *
 * Runs after the claim list is painted rather than blocking it: the flights come
 * from a static roster and shouldn't wait on a Supabase round-trip. A failure
 * here is deliberately silent — the counts stay hidden and the section stays
 * closed. The likeliest cause is an unmigrated project (no annotations table),
 * and "your flights" is still perfectly usable without them.
 */
async function paintAnnotations(): Promise<void> {
  let annotated: Map<string, AnnotatedDay>;
  try {
    annotated = await listMyAnnotatedDays();
  } catch {
    return;
  }
  if (!listEl) return;

  const claimedKeys = new Set<string>();
  for (const node of listEl.querySelectorAll<HTMLAnchorElement>('.claim-day-notes')) {
    const key = node.dataset.dayKey ?? '';
    claimedKeys.add(key);
    const count = annotated.get(key)?.count ?? 0;
    if (count === 0) continue;
    node.textContent = `${count} note${count === 1 ? '' : 's'}`;
    node.title = 'Open the 3D view with your notes';
    node.hidden = false;
  }

  renderAnnotated([...annotated.values()].filter((d) => !claimedKeys.has(`${d.comp}/${d.day}`)));
}

/** Roster order for a "comp/day", so annotated tasks list the way claims do. */
function rosterIndex(day: AnnotatedDay): number {
  const i = roster?.days.findIndex((d) => d.comp === day.comp && d.day === day.day) ?? -1;
  // A day the archive no longer carries still gets listed, just last.
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** "Flights you've annotated": notes on tasks no claim of this account covers. */
function renderAnnotated(days: AnnotatedDay[]) {
  if (!annotatedEl || !annotatedSection) return;
  annotatedSection.toggleAttribute('hidden', days.length === 0);
  annotatedEl.replaceChildren();
  if (days.length === 0) return;

  const card = el('div', 'claim-card');
  const list = el('ul', 'claim-days');
  let lastComp = '';
  for (const entry of [...days].sort((a, b) => rosterIndex(a) - rosterIndex(b))) {
    const day = roster?.days.find((d) => d.comp === entry.comp && d.day === entry.day) ?? {
      // Fall back to the raw ids for a task that has left the archive.
      comp: entry.comp,
      compLabel: entry.comp,
      day: entry.day,
      dayLabel: entry.day,
      date: null,
    };

    if (day.comp !== lastComp) {
      lastComp = day.comp;
      list.appendChild(el('li', 'claim-comp', day.compLabel));
    }

    const item = dayRow(day);
    // Whose track the notes are on — the point of this section, since it isn't
    // a pilot you've claimed.
    item.appendChild(el('span', 'claim-day-pilots', entry.pilots.join(', ')));
    item.appendChild(notesPill({ comp: entry.comp, day: entry.day }, entry.count));
    list.appendChild(item);
  }
  card.appendChild(list);
  annotatedEl.appendChild(card);
}

function renderSearchResults(matches: RosterPilot[]) {
  if (!resultsEl || !roster) return;
  resultsEl.replaceChildren();
  if (matches.length === 0) return;

  const claimedKeys = new Set(claims.map((c) => c.pilot_key));
  for (const pilot of matches) {
    const comps = compsForPilot(roster, pilot);
    const row = el('div', 'claim-option');

    const info = el('div', 'claim-option-info');
    info.appendChild(el('span', 'claim-option-name', pilot.label));
    const taskCount = `${pilot.flights.length} task${pilot.flights.length === 1 ? '' : 's'}`;
    const compNames = comps.map((c) => c.compLabel).join(', ');
    info.appendChild(el('span', 'claim-option-meta', `${taskCount} · ${compNames}`));
    row.appendChild(info);

    const button = el('button', 'account-btn small', claimedKeys.has(pilot.key) ? 'Claimed' : 'This is me');
    button.type = 'button';
    button.disabled = claimedKeys.has(pilot.key);
    button.addEventListener('click', async () => {
      button.disabled = true;
      setStatus('Claiming…');
      try {
        const { claimed } = await claimPilot(
          pilot.key,
          pilot.label,
          comps.map((c) => c.comp),
        );
        claims = await listMyClaims();
        renderClaims();
        // Comps already on this account are a no-op, not a failure — several
        // accounts may claim the same pilot, so the only way to "fail" here is
        // to have claimed it yourself already.
        setStatus(claimed.length === 0 ? 'Already claimed.' : 'Claimed.', 'ok');
        if (queryEl) queryEl.value = '';
        resultsEl.replaceChildren();
      } catch (err) {
        setStatus(describe(err), 'error');
        button.disabled = false;
      }
    });
    row.appendChild(button);
    resultsEl.appendChild(row);
  }
}

/** Called once the user is known to be signed in. */
export async function mountClaims(): Promise<void> {
  if (!listEl) return;
  setStatus('');
  // An empty box reads as "you've claimed nothing"; say we're still looking.
  listEl.replaceChildren(el('p', 'field-hint', 'Loading your flights…'));
  try {
    [roster, claims] = await Promise.all([fetchRoster(), listMyClaims()]);
  } catch (err) {
    setStatus(describe(err), 'error');
    return;
  }
  renderClaims();

  formEl?.addEventListener('submit', (event) => event.preventDefault());
  queryEl?.addEventListener('input', () => {
    if (!roster) return;
    renderSearchResults(searchPilots(roster, queryEl.value));
  });
}
