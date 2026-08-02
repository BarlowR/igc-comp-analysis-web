/**
 * Upload page controller: wires the task + IGC file inputs to the analysis
 * engine. All computation runs client-side via runAnalysis.
 */
import { runAnalysis } from './analysis';
import { parseTaskKind, type TaskKind } from '../lib/xctsk';

const $ = (id: string) => document.getElementById(id)!;

const taskInput = $('task-input') as HTMLInputElement;
const igcInput = $('igc-input') as HTMLInputElement;
const analyzeBtn = $('analyze-btn') as HTMLButtonElement;
const taskName = $('task-name');
const igcCount = $('igc-count');
const statusEl = $('status');
const results = $('results');

/**
 * The chosen task type. The radios are pre-checked in the markup, so this only
 * falls back if the group is somehow absent — parseTaskKind reads that as XC.
 */
function selectedTaskKind(): TaskKind {
  const checked = document.querySelector<HTMLInputElement>('input[name="task-kind"]:checked');
  return parseTaskKind(checked?.value);
}

function refreshState(): void {
  taskName.textContent = taskInput.files?.[0]?.name ?? 'No task file selected';
  const n = igcInput.files?.length ?? 0;
  igcCount.textContent = n === 0 ? 'No IGC files selected' : `${n} IGC file${n === 1 ? '' : 's'} selected`;
  analyzeBtn.disabled = !(taskInput.files?.length && n);
}

taskInput.addEventListener('change', refreshState);
igcInput.addEventListener('change', refreshState);
analyzeBtn.addEventListener('click', () => void analyze());

async function analyze(): Promise<void> {
  const taskFile = taskInput.files?.[0];
  const igcFiles = Array.from(igcInput.files ?? []);
  if (!taskFile || igcFiles.length === 0) return;

  analyzeBtn.disabled = true;
  statusEl.textContent = 'Reading task…';

  try {
    const taskText = await taskFile.text();
    const igc = await Promise.all(igcFiles.map(async (f) => ({ name: f.name, text: await f.text() })));
    await runAnalysis({ taskText, igc, resultsEl: results, statusEl, taskKind: selectedTaskKind() });
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${(err as Error).message}`;
  } finally {
    analyzeBtn.disabled = false;
  }
}

refreshState();
