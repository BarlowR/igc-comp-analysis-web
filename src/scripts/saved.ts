// Saved-comps page controller. Two modes off one static page:
//   /saved            — list this account's saved comps (open / delete)
//   /saved?id=<uuid>  — render one comp from its cached results JSON, with a
//                       recompute banner when the cache predates the engine.
//
// Comp names are user input, so all rendering is createElement/textContent —
// never innerHTML.
import { renderArchivedResults, runAnalysis, type ArchivedResults } from './analysis';
import {
  deleteComp,
  fetchComp,
  isStale,
  listMyComps,
  loadInputs,
  loadResults,
  saveResults,
  savedTitle,
  type SavedComp,
} from '../lib/saved-comps';
import { currentUser, hasStoredSession, isConfigured } from '../lib/supabase';

const $ = (id: string) => document.getElementById(id)!;
const statusEl = $('status');
const resultsEl = $('results');
const listCard = $('saved-list-card');
const listEl = $('saved-list');
const staleCard = $('stale-card');
const recomputeBtn = $('recompute-btn') as HTMLButtonElement;
const titleEl = $('saved-title');

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

function setStatus(message: string): void {
  statusEl.textContent = message;
}

// ---- list mode --------------------------------------------------------------

async function renderList(): Promise<void> {
  setStatus('Loading your comps…');
  const comps = await listMyComps();
  setStatus('');
  listCard.removeAttribute('hidden');
  listEl.replaceChildren();

  if (comps.length === 0) {
    const hint = el('p', 'field-hint', 'Nothing saved yet. Run a day on the ');
    const link = el('a', undefined, 'analyze page');
    (link as HTMLAnchorElement).href = '/analyze';
    hint.appendChild(link);
    hint.appendChild(document.createTextNode(' and save it here.'));
    listEl.appendChild(hint);
    return;
  }

  // Tasks filed under a comp share one card, titled by the comp; standalone
  // tasks get a card each. Cards keep listMyComps order (newest saved first).
  const byComp = new Map<string, SavedComp[]>();
  const cardsInOrder: { label: string; tasks: SavedComp[]; compId?: string }[] = [];
  for (const comp of comps) {
    if (!comp.comp_id) {
      cardsInOrder.push({ label: comp.name, tasks: [comp] });
      continue;
    }
    const group = byComp.get(comp.comp_id);
    if (group) group.push(comp);
    else {
      const tasks: SavedComp[] = [comp];
      byComp.set(comp.comp_id, tasks);
      cardsInOrder.push({ label: comp.comp?.name ?? comp.comp_id, tasks, compId: comp.comp_id });
    }
  }
  for (const { label, tasks, compId } of cardsInOrder) {
    listEl.appendChild(compCard(label, tasks, compId));
  }

  // Deep link from a notebook: /saved#c/<comp id> scrolls to that comp's card.
  const linked = /^#c\/(.+)$/.exec(decodeURIComponent(window.location.hash));
  if (linked) {
    listEl
      .querySelector(`.claim-card[data-comp-id="${CSS.escape(linked[1])}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

/** One card: the comp's (or standalone task's) name, then a row per task. */
function compCard(label: string, tasks: SavedComp[], compId?: string): HTMLElement {
  const card = el('div', 'claim-card');
  if (compId) card.dataset.compId = compId;
  const head = el('div', 'claim-card-head');
  head.appendChild(el('span', 'claim-name', label));
  card.appendChild(head);

  const list = el('ul', 'claim-days');
  for (const task of tasks) list.appendChild(taskRow(task, list, card));
  card.appendChild(list);
  return card;
}

function taskRow(comp: SavedComp, list: HTMLElement, card: HTMLElement): HTMLLIElement {
  const item = el('li', 'claim-day');

  const link = el('a', 'claim-day-link', comp.name) as HTMLAnchorElement;
  link.href = `/saved?id=${comp.id}`;
  item.appendChild(link);

  const date = new Date(comp.created_at);
  const when = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
  item.appendChild(
    el('span', 'claim-day-date', `${when} · ${comp.pilot_count} pilot${comp.pilot_count === 1 ? '' : 's'}`),
  );

  const view3d = el('a', 'claim-day-3d', '◈ 3D') as HTMLAnchorElement;
  view3d.href = `/saved/3d?id=${comp.id}`;
  view3d.title = 'Fly this task in 3D';
  item.appendChild(view3d);

  const drop = el('button', 'claim-remove', 'Delete');
  drop.type = 'button';
  drop.addEventListener('click', async () => {
    if (!window.confirm(`Delete "${comp.name}"? The uploaded tracklogs go with it.`)) return;
    drop.disabled = true;
    try {
      await deleteComp(comp.id);
      item.remove();
      // Last task gone: fold the card away too; last card gone: back to the
      // empty-state hint.
      if (!list.querySelector('.claim-day')) card.remove();
      if (!listEl.querySelector('.claim-card')) void renderList();
    } catch (err) {
      drop.disabled = false;
      setStatus(`Delete failed: ${(err as Error).message}`);
    }
  });
  item.appendChild(drop);

  return item;
}

// ---- viewer mode -------------------------------------------------------------

async function renderComp(id: string): Promise<void> {
  setStatus('Loading…');
  const comp = await fetchComp(id);
  if (!comp) {
    // RLS makes "someone else's" and "doesn't exist" the same answer, which is
    // exactly the right amount of information to give out.
    setStatus('Comp not found. It may belong to a different account.');
    return;
  }

  const title = savedTitle(comp);
  titleEl.textContent = title;
  document.title = `${title} — Outclimb.app`;

  const results = (await loadResults(comp)) as ArchivedResults;
  renderArchivedResults({ results, resultsEl, statusEl, threeDUrl: `/saved/3d?id=${comp.id}` });

  if (isStale(comp)) {
    staleCard.removeAttribute('hidden');
    recomputeBtn.addEventListener('click', () => void recompute(comp), { once: true });
  }
}

/** Re-run the analysis from the stored raw inputs and refresh the cache. */
async function recompute(comp: SavedComp): Promise<void> {
  recomputeBtn.disabled = true;
  try {
    setStatus('Downloading tracklogs…');
    const inputs = await loadInputs(comp);
    const results = await runAnalysis({ ...inputs, resultsEl, statusEl });
    setStatus('Saving updated results…');
    await saveResults(comp, results);
    staleCard.setAttribute('hidden', '');
    setStatus(`Loaded ${comp.pilot_count} pilot${comp.pilot_count === 1 ? '' : 's'}. Recomputed and saved.`);
  } catch (err) {
    console.error(err);
    recomputeBtn.disabled = false;
    setStatus(`Recompute failed: ${(err as Error).message}`);
  }
}

// ---- entry -------------------------------------------------------------------

async function init(): Promise<void> {
  if (!isConfigured) {
    setStatus('Accounts are not configured in this build.');
    return;
  }
  // No session ever stored on this device: nothing here can load, so go sign
  // in and come straight back (the account page honours ?next=). A stored but
  // expired token is NOT redirected — supabase-js refreshes those, which
  // currentUser() below waits for.
  const here = `${window.location.pathname}${window.location.search}`;
  const signIn = () => window.location.replace(`/account?next=${encodeURIComponent(here)}`);
  if (!hasStoredSession()) {
    signIn();
    return;
  }

  const id = new URLSearchParams(window.location.search).get('id');
  try {
    setStatus('Checking your session…');
    if (!(await currentUser())) {
      // The token couldn't be refreshed. Without this check the queries below
      // would run as anon and read as "nothing saved" rather than "signed out".
      signIn();
      return;
    }
    if (id) await renderComp(id);
    else await renderList();
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${(err as Error).message}`);
  }
}

void init();
