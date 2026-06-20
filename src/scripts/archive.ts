/**
 * Archive viewer controller: reads the archived analysis descriptor embedded in
 * the page, fetches its task + IGC files from /archive/..., and runs the same
 * analysis engine used by the upload page.
 */
import { runAnalysis } from './analysis';

interface ArchiveEntry {
  base: string; // e.g. "/archive/chelan2026/day1"
  taskFile: string;
  igcFiles: string[];
}

const $ = (id: string) => document.getElementById(id)!;

async function load(): Promise<void> {
  const statusEl = $('status');
  const results = $('results');

  const dataEl = document.getElementById('archive-entry');
  if (!dataEl?.textContent) {
    statusEl.textContent = 'No archived analysis found.';
    return;
  }
  const entry = JSON.parse(dataEl.textContent) as ArchiveEntry;

  try {
    statusEl.textContent = 'Loading task…';
    const taskText = await fetchText(`${entry.base}/${entry.taskFile}`);

    statusEl.textContent = 'Loading tracklogs…';
    const igc = await Promise.all(
      entry.igcFiles.map(async (name) => ({ name, text: await fetchText(`${entry.base}/${name}`) })),
    );

    await runAnalysis({ taskText, igc, resultsEl: results, statusEl });
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error loading archive: ${(err as Error).message}`;
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

void load();
