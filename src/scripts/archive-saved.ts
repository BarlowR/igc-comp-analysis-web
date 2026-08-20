// Archive index: fold this account's saved comps into the tabs.
//
// The index is built from the archive manifest at build time; saved comps only
// exist per-session, so they are injected here. Tasks filed under one of the
// account's comps (migration 0007) group the way archived comps do — one
// disclosure row per comp, its tasks as day cards inside — and standalone
// tasks get a row of their own. Everything lands at the top of the tab
// matching its kind, marked ✦ as the user's own; free flights get their own
// tab, which ships hidden in the markup and is revealed only when this account
// has some (index.astro listens for `archive-saved:revealed` to honour a #free
// hash). Each card carries the same ◈ 3D corner link an archived day card has,
// plus a delete control — the one thing an archived card doesn't have, because
// these rows are the user's own to remove.
//
// Everything degrades to nothing: signed out, accounts unconfigured, or a
// failed fetch simply leaves the page as built. Comp and task names are user
// input, so rendering is createElement/textContent — never innerHTML.
import { el } from '../lib/dom';
import { savedTask3dUrl, savedTaskUrl } from '../lib/links';
import { deleteComp, listMyComps, savedKind, type SavedComp } from '../lib/saved-comps';
import { currentUser, hasStoredSession, isConfigured } from '../lib/supabase';

const SAVED_MARK = '✦';

/** The disclosure chevron the server-rendered comps draw; same geometry. */
function chevron(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'comp-chevron');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4.5 2 L8.5 6 L4.5 10');
  svg.appendChild(path);
  return svg;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One saved task as an archive-style day card: face → 2D, corner → 3D, ✕ deletes. */
function dayCard(task: SavedComp, onGone: () => void): HTMLLIElement {
  const card = el('li', 'day-card');

  const link = el('a', 'day-link') as HTMLAnchorElement;
  link.href = savedTaskUrl(task.id);
  const title = el('div', 'day-title');
  title.appendChild(el('span', 'day-name', task.name));
  link.appendChild(title);
  link.appendChild(
    el('div', 'day-meta', [fmtDate(task.created_at), `${task.pilot_count} tracks`].filter(Boolean).join(' · ')),
  );
  card.appendChild(link);

  // Same corner control as an archived day card.
  const view3d = el('a', 'day-3d', '◈ 3D') as HTMLAnchorElement;
  view3d.href = savedTask3dUrl(task.id);
  view3d.title = 'Fly this task in 3D';
  view3d.setAttribute('aria-label', `Fly ${task.name} in 3D`);
  card.appendChild(view3d);

  const del = el('button', 'day-del', '✕');
  del.type = 'button';
  del.title = 'Delete this saved task';
  del.setAttribute('aria-label', `Delete ${task.name}`);
  del.addEventListener('click', async () => {
    if (!window.confirm(`Delete "${task.name}"? The uploaded tracklogs go with it.`)) return;
    del.disabled = true;
    try {
      await deleteComp(task.id);
      card.remove();
      onGone();
    } catch (err) {
      del.disabled = false;
      window.alert(`Delete failed: ${(err as Error).message}`);
    }
  });
  card.appendChild(del);

  return card;
}

/** A disclosure row of saved tasks, titled ✦ as the account's own. */
function savedGroup(label: string, tasks: SavedComp[], panel: HTMLElement): HTMLElement {
  const details = el('details', 'archive-comp saved-comp');
  const summary = el('summary');
  summary.appendChild(chevron());

  const name = el('span', 'comp-name', label);
  const mark = el('span', 'saved-mark', ` ${SAVED_MARK}`);
  mark.title = 'Saved in your account';
  mark.setAttribute('aria-label', 'Saved in your account');
  name.appendChild(mark);
  summary.appendChild(name);

  const meta = el('span', 'comp-meta');
  const renderMeta = (n: number): void => {
    const when = fmtDate(tasks[0]?.created_at ?? '');
    meta.textContent = [`${n} task${n === 1 ? '' : 's'}`, when && `saved ${when}`].filter(Boolean).join(' · ');
  };
  renderMeta(tasks.length);
  summary.appendChild(meta);
  details.appendChild(summary);

  const list = el('ul', 'day-list');
  for (const task of tasks) {
    list.appendChild(
      dayCard(task, () => {
        // Card deleted: recount, and fold the whole row away with its last task.
        const left = list.querySelectorAll('.day-card').length;
        if (left === 0) {
          details.remove();
          panelEmptied(panel);
        } else {
          renderMeta(left);
        }
        refreshFreeCount(panel);
      }),
    );
  }
  details.appendChild(list);
  return details;
}

/** Keep the Free Flights tab's count honest as its cards are deleted. */
function refreshFreeCount(panel: HTMLElement): void {
  if (panel.id !== 'panel-free') return;
  const count = document.querySelector('#tab-free .tab-count');
  if (count) count.textContent = String(panel.querySelectorAll('.day-card').length);
}

/**
 * A panel may have lost its last saved row. Only the account-only Free Flights
 * tab exists purely for saved content, so that's the one to fold away — back
 * to the first visible archive tab if it was the one being looked at.
 */
function panelEmptied(panel: HTMLElement): void {
  if (panel.id !== 'panel-free' || panel.querySelector('.archive-comp')) return;
  const tab = document.getElementById('tab-free');
  const wasActive = tab?.getAttribute('aria-selected') === 'true';
  tab?.setAttribute('hidden', '');
  panel.setAttribute('hidden', '');
  if (wasActive) {
    document.querySelector<HTMLButtonElement>('.archive .tab:not([hidden])')?.click();
  }
}

/** Put this tab's saved rows above the archived ones (and clear any
 *  "nothing archived yet" placeholder — the tab isn't empty any more). */
function inject(panel: HTMLElement, tasks: SavedComp[]): void {
  if (!tasks.length) return;
  panel.querySelector('.archive-empty')?.remove();

  // Comp groups first (keyed by comp_id), then standalone tasks — each list
  // newest-saved first, matching listMyComps order.
  const byComp = new Map<string, SavedComp[]>();
  const solo: SavedComp[] = [];
  for (const task of tasks) {
    if (task.comp_id) {
      (byComp.get(task.comp_id) ?? byComp.set(task.comp_id, []).get(task.comp_id)!).push(task);
    } else {
      solo.push(task);
    }
  }

  const rows: HTMLElement[] = [];
  for (const [compId, group] of byComp) {
    rows.push(savedGroup(group[0].comp?.name ?? compId, group, panel));
  }
  for (const task of solo) rows.push(savedGroup(task.name, [task], panel));

  // Prepend in reverse so rows[0] ends up on top.
  for (const row of rows.reverse()) panel.prepend(row);
}

async function init(): Promise<void> {
  // The whole feature is signed-in-only; the stored-session peek keeps
  // supabase-js out of every signed-out archive visit.
  if (!isConfigured || !hasStoredSession()) return;
  if (!document.querySelector('.archive')) return; // empty archive: no tabs to join

  try {
    if (!(await currentUser())) return; // token was stored but couldn't refresh
    const comps = await listMyComps();
    if (!comps.length) return;

    const byKind = new Map<string, SavedComp[]>();
    for (const comp of comps) {
      const kind = savedKind(comp);
      (byKind.get(kind) ?? byKind.set(kind, []).get(kind)!).push(comp);
    }

    for (const [kind, group] of byKind) {
      const panel = document.getElementById(`panel-${kind}`);
      if (panel) inject(panel, group);
    }

    // Reveal the account-only Free Flights tab only when it has content.
    const freeFlights = byKind.get('free') ?? [];
    if (freeFlights.length) {
      const tab = document.getElementById('tab-free');
      if (tab) {
        tab.removeAttribute('hidden');
        const count = tab.querySelector('.tab-count');
        if (count) count.textContent = String(freeFlights.length);
        window.dispatchEvent(new Event('archive-saved:revealed'));
      }
    }
  } catch (err) {
    // A broken account fetch shouldn't cost anyone the archive.
    console.error('[archive-saved]', err);
  }
}

void init();
