// Saved-comps page controller. Two modes off one static page:
//   /saved            — list this account's saved comps (open / delete)
//   /saved?id=<uuid>  — render one comp from its cached results JSON, with a
//                       recompute banner when the cache predates the engine.
//
// Comp names are user input, so all rendering is createElement/textContent —
// never innerHTML.
import { renderArchivedResults, runAnalysis, computeResults } from './analysis';
import { ANALYSIS_VERSION } from '../lib/competition';
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
import { gateAccountPage } from '../lib/account-gate';
import { $, el } from '../lib/dom';
import { parseCompHash, savedTask3dUrl, savedTaskUrl } from '../lib/links';

const statusEl = $('status');
const resultsEl = $('results');
const listCard = $('saved-list-card');
const listEl = $('saved-list');
const staleCard = $('stale-card');
const recomputeBtn = $<HTMLButtonElement>('recompute-btn');
const staleAllCard = $('stale-all-card');
const recomputeAllBtn = $<HTMLButtonElement>('recompute-all-btn');
const titleEl = $('saved-title');

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

  // One banner for every stale task, so a version bump is one click rather
  // than a visit to each task's own recompute button.
  staleTasks = comps.filter(isStale);
  staleAllCard.toggleAttribute('hidden', staleTasks.length === 0);

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
  const linked = parseCompHash(window.location.hash);
  if (linked) {
    listEl
      .querySelector(`.claim-card[data-comp-id="${CSS.escape(linked)}"]`)
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
  link.href = savedTaskUrl(comp.id);
  item.appendChild(link);

  const date = new Date(comp.created_at);
  const when = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
  item.appendChild(
    el('span', 'claim-day-date', `${when} · ${comp.pilot_count} pilot${comp.pilot_count === 1 ? '' : 's'}`),
  );

  const view3d = el('a', 'claim-day-3d', '◈ 3D') as HTMLAnchorElement;
  view3d.href = savedTask3dUrl(comp.id);
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

  const results = await loadResults(comp);
  renderArchivedResults({ results, resultsEl, statusEl, threeDUrl: savedTask3dUrl(comp.id) });

  if (isStale(comp)) {
    staleCard.removeAttribute('hidden');
    recomputeBtn.addEventListener('click', () => void recompute(comp), { once: true });
  }
}

/** The list's stale tasks, refreshed by renderList; recomputeAll works it off. */
let staleTasks: SavedComp[] = [];

/**
 * Recompute every stale task in place: stored inputs → computeResults →
 * storage, one at a time, with nothing rendered. On a failure the finished
 * tasks stay finished (their version is bumped locally too, so a retry click
 * picks up where this stopped).
 */
async function recomputeAll(): Promise<void> {
  recomputeAllBtn.disabled = true;
  const total = staleTasks.length;
  let done = 0;
  try {
    for (const task of staleTasks) {
      setStatus(`Recomputing ${done + 1}/${total}: ${task.name}…`);
      const inputs = await loadInputs(task);
      const results = await computeResults(inputs);
      await saveResults(task, results);
      task.analysis_version = ANALYSIS_VERSION;
      done++;
    }
    setStatus(`Recomputed ${total} task${total === 1 ? '' : 's'}. All up to date.`);
    staleAllCard.setAttribute('hidden', '');
  } catch (err) {
    console.error(err);
    staleTasks = staleTasks.filter(isStale);
    setStatus(
      `Recompute failed after ${done} of ${total}: ${(err as Error).message}. Click again to retry the rest.`,
    );
  } finally {
    recomputeAllBtn.disabled = false;
  }
}
recomputeAllBtn.addEventListener('click', () => void recomputeAll());

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

void gateAccountPage(setStatus, async () => {
  const id = new URLSearchParams(window.location.search).get('id');
  if (id) await renderComp(id);
  else await renderList();
});
