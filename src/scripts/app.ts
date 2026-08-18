/**
 * Upload page controller: wires the task + IGC file inputs to the analysis
 * engine. All computation runs client-side via runAnalysis. A finished analysis
 * can be saved to the signed-in user's account (lib/saved-comps.ts); the inputs
 * and results of the LAST run are held here for that.
 */
import { runAnalysis, type ArchivedResults } from './analysis';
import { parseTaskKind, type TaskKind } from '../lib/xctsk';
import { hasStoredSession, isConfigured } from '../lib/supabase';

const $ = (id: string) => document.getElementById(id)!;

const taskInput = $('task-input') as HTMLInputElement;
const taskField = $('task-field');
const igcInput = $('igc-input') as HTMLInputElement;
const analyzeBtn = $('analyze-btn') as HTMLButtonElement;
const taskName = $('task-name');
const igcCount = $('igc-count');
const statusEl = $('status');
const results = $('results');

const saveCard = $('save-card');
const saveForm = $('save-form') as HTMLFormElement;
const saveSignin = $('save-signin');
const saveName = $('save-name') as HTMLInputElement;
const saveCompSel = $('save-comp') as HTMLSelectElement;
const saveCompName = $('save-comp-name') as HTMLInputElement;
const saveSubmit = $('save-submit') as HTMLButtonElement;
const saveStatus = $('save-status');

/** Inputs and results of the last completed run — what "Save comp" uploads. */
let lastRun: {
  /** Null on a free-flight run — there is no task file to keep. */
  taskText: string | null;
  igc: { name: string; text: string }[];
  /** Raw radio value — the save-time category ('free' has its own archive tab). */
  rawKind: string;
  taskKind: TaskKind;
  results: ArchivedResults;
} | null = null;

/**
 * The chosen task type, raw. The radios are pre-checked in the markup, so this
 * only falls back if the group is somehow absent. The raw value is what a save
 * files the comp under; parseTaskKind of it is what the analysis runs as —
 * 'free' means no task at all.
 */
function selectedRawKind(): string {
  const checked = document.querySelector<HTMLInputElement>('input[name="task-kind"]:checked');
  return checked?.value ?? '';
}

function refreshState(): void {
  // Free flights have no task: the task input disappears and only tracklogs
  // gate the button. The comp kinds require both.
  const free = parseTaskKind(selectedRawKind()) === 'free';
  taskField.toggleAttribute('hidden', free);

  taskName.textContent = taskInput.files?.[0]?.name ?? 'No task file selected';
  const n = igcInput.files?.length ?? 0;
  igcCount.textContent = n === 0 ? 'No IGC files selected' : `${n} IGC file${n === 1 ? '' : 's'} selected`;
  analyzeBtn.disabled = !(n && (free || taskInput.files?.length));
}

taskInput.addEventListener('change', refreshState);
igcInput.addEventListener('change', refreshState);
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="task-kind"]')) {
  radio.addEventListener('change', refreshState);
}
analyzeBtn.addEventListener('click', () => void analyze());

async function analyze(): Promise<void> {
  const rawKind = selectedRawKind();
  const taskKind = parseTaskKind(rawKind);
  const free = taskKind === 'free';

  const taskFile = free ? null : taskInput.files?.[0];
  const igcFiles = Array.from(igcInput.files ?? []);
  if ((!free && !taskFile) || igcFiles.length === 0) return;

  analyzeBtn.disabled = true;
  statusEl.textContent = free ? 'Reading tracklogs…' : 'Reading task…';

  try {
    const taskText = taskFile ? await taskFile.text() : null;
    const igc = await Promise.all(igcFiles.map(async (f) => ({ name: f.name, text: await f.text() })));
    const analysed = await runAnalysis({ taskText, igc, resultsEl: results, statusEl, taskKind });
    lastRun = { taskText, igc, rawKind, taskKind, results: analysed };
    showSaveCard(taskFile?.name ?? igcFiles[0].name);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${(err as Error).message}`;
  } finally {
    analyzeBtn.disabled = false;
  }
}

/**
 * Offer to save the run. The session check is the stored-token peek, not a
 * round-trip — an expired-but-refreshable token still counts, because
 * supabase-js refreshes it when the save actually runs. It only decides which
 * prompt to show; the save itself is authenticated (and RLS-checked)
 * server-side regardless.
 */
function showSaveCard(taskFileName: string): void {
  if (!isConfigured) return; // accounts are off in this build — no card at all
  const signedIn = hasStoredSession();
  saveForm.toggleAttribute('hidden', !signedIn);
  saveSignin.toggleAttribute('hidden', signedIn);
  saveStatus.textContent = '';
  saveStatus.className = 'form-status';
  if (signedIn && !saveName.value) {
    saveName.value = taskFileName.replace(/\.(xctsk|igc)$/i, '').slice(0, 120);
  }
  if (signedIn) void fillCompPicker();
  saveCard.removeAttribute('hidden');
}

/** True once the account's comps are in the picker; re-runs are cheap no-ops. */
let compsLoaded = false;

/**
 * Put the account's comps into the select, between the fixed "no comp" and
 * "new comp" options. Failure is silent — the save works without a comp, and
 * "new comp" still lets one be typed.
 */
async function fillCompPicker(): Promise<void> {
  if (compsLoaded) return;
  try {
    const { listMyUserComps } = await import('../lib/saved-comps');
    const comps = await listMyUserComps();
    const newOpt = saveCompSel.querySelector('option[value="__new__"]');
    for (const comp of comps) {
      const opt = document.createElement('option');
      opt.value = comp.id;
      opt.textContent = comp.name;
      saveCompSel.insertBefore(opt, newOpt);
    }
    compsLoaded = true;
  } catch (err) {
    console.error('[save] comp list unavailable', err);
  }
}

saveCompSel.addEventListener('change', () => {
  saveCompName.toggleAttribute('hidden', saveCompSel.value !== '__new__');
  if (saveCompSel.value === '__new__') saveCompName.focus();
});

/**
 * Give the results map card the same "◈ View in 3D →" control an archived or
 * saved day shows, pointing at the just-saved comp. The card was rendered
 * before the save existed, so the link is added after the fact — markup
 * matching mapSection in analysis.ts.
 */
function addMapThreeDLink(url: string): void {
  const head = results.querySelector('.map-head');
  if (!head || head.querySelector('.map-3d-link')) return;
  const link = document.createElement('a');
  link.className = 'map-3d-link';
  link.href = url;
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '◈';
  const arrow = document.createElement('span');
  arrow.className = 'map-3d-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '→';
  link.append(icon, document.createTextNode(' View in 3D '), arrow);
  head.appendChild(link);
}

saveForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!lastRun) return;
  const name = saveName.value.trim();
  if (!name) return;

  saveSubmit.disabled = true;
  saveStatus.textContent = 'Saving… (uploading tracklogs)';
  saveStatus.className = 'form-status';
  try {
    // Loaded on demand: pulls in supabase-js, which the analyze page otherwise
    // never needs.
    const { saveComp, createUserComp } = await import('../lib/saved-comps');

    // Which comp to file under: an existing one, a new one (created — or
    // fetched, if the name already exists — before the save), or none.
    let compId: string | null = null;
    if (saveCompSel.value === '__new__') {
      const compName = saveCompName.value.trim();
      if (!compName) {
        saveCompName.reportValidity?.();
        saveCompName.focus();
        throw new Error('Give the new comp a name (or pick "No comp").');
      }
      compId = (await createUserComp(compName)).id;
      compsLoaded = false; // picker is stale now; refill on next open
    } else if (saveCompSel.value) {
      compId = saveCompSel.value;
    }

    const comp = await saveComp({
      name,
      taskKind: lastRun.rawKind,
      taskText: lastRun.taskText,
      igc: lastRun.igc,
      results: lastRun.results,
      pilotCount: lastRun.results.table.completed.length + lastRun.results.table.incomplete.length,
      compId,
    });
    addMapThreeDLink(`/saved/3d?id=${comp.id}`);
    saveStatus.className = 'form-status ok';
    saveStatus.replaceChildren('Saved. ');
    const link = document.createElement('a');
    link.href = `/saved?id=${comp.id}`;
    link.textContent = 'Open it';
    saveStatus.appendChild(link);
    saveStatus.appendChild(
      document.createTextNode(' or fly it in 3D from the map card below. It is also on the archive page.'),
    );
  } catch (err) {
    console.error(err);
    saveStatus.className = 'form-status error';
    saveStatus.textContent = `Save failed: ${(err as Error).message}`;
  } finally {
    saveSubmit.disabled = false;
  }
});

refreshState();
