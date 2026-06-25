/**
 * Archive viewer controller: fetches the precomputed analysis results for this
 * day (built server-side from the archived IGC/task files) and renders them.
 * The client no longer downloads the IGC tracklogs or re-runs the analysis.
 */
import { renderArchivedResults, type ArchivedResults } from './analysis';

interface ArchiveEntry {
  base: string; // e.g. "/archive/chelan-us-open-2026/day1"
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

  // Progress bar shown while the results JSON downloads.
  const progress = document.createElement('div');
  progress.className = 'progress';
  const barEl = document.createElement('div');
  barEl.className = 'progress-bar';
  progress.appendChild(barEl);
  statusEl.insertAdjacentElement('afterend', progress);

  try {
    statusEl.textContent = 'Loading results…';
    const data = await fetchJsonWithProgress(`${entry.base}.json`, (received, total) => {
      const mb = (n: number): string => (n / 1048576).toFixed(1);
      if (total > 0 && received <= total) {
        barEl.classList.remove('indeterminate');
        barEl.style.width = `${(received / total) * 100}%`;
        statusEl.textContent = `Loading results… ${mb(received)} / ${mb(total)} MB`;
      } else {
        // No (or mismatched, e.g. gzipped) Content-Length: show activity + bytes.
        barEl.classList.add('indeterminate');
        statusEl.textContent = `Loading results… ${mb(received)} MB`;
      }
    });
    progress.remove();
    renderArchivedResults({ results: data, resultsEl: results, statusEl });
  } catch (err) {
    console.error(err);
    progress.remove();
    statusEl.textContent = `Error loading archive: ${(err as Error).message}`;
  }
}

/** Fetch JSON while reporting download progress (received/total bytes). */
async function fetchJsonWithProgress(
  url: string,
  onProgress: (received: number, total: number) => void,
): Promise<ArchivedResults> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching results`);
  const total = Number(res.headers.get('content-length')) || 0;

  // Stream the body so we can report progress; fall back to res.json() if the
  // body isn't readable for some reason.
  if (!res.body) return res.json() as Promise<ArchivedResults>;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }

  const buf = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) {
    buf.set(c, pos);
    pos += c.length;
  }
  return JSON.parse(new TextDecoder().decode(buf)) as ArchivedResults;
}

void load();
