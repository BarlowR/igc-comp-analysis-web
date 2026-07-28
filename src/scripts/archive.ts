/**
 * Archive viewer controller: fetches the precomputed analysis results for this
 * day (built server-side from the archived IGC/task files) and renders them.
 * The client never touches the IGC tracklogs and runs no analysis of its own.
 */
import { renderArchivedResults, type ArchivedResults } from './analysis';
import { installDayClaim } from './day-claim';
import { makeLoading } from './loading-overlay';

interface ArchiveEntry {
  base: string; // e.g. "/archive/chelan-us-open-2026/day1"
}

const $ = (id: string) => document.getElementById(id)!;

async function load(): Promise<void> {
  const statusEl = $('status');
  const results = $('results');
  // Full-cover loading screen, shared with the 3D viewer. It's in the served
  // HTML, so it's already up: this only drives it.
  const loading = makeLoading();

  const dataEl = document.getElementById('archive-entry');
  if (!dataEl?.textContent) {
    loading.done();
    statusEl.textContent = 'No archived analysis found.';
    return;
  }
  const entry = JSON.parse(dataEl.textContent) as ArchiveEntry;

  // Before the render below, so the first pinned pilot already has the control.
  installDayClaim();

  try {
    const data = await fetchJsonWithProgress(`${entry.base}.json`, (received, total) => {
      const mb = (n: number): string => (n / 1048576).toFixed(1);
      // No (or mismatched, e.g. gzipped) Content-Length: bytes so far is all we
      // can honestly say.
      loading.step(
        total > 0 && received <= total
          ? `Loading results… ${mb(received)} / ${mb(total)} MB`
          : `Loading results… ${mb(received)} MB`,
      );
    });
    loading.step('Rendering…');
    // The render below is synchronous and takes a noticeable moment on a big
    // day, so let the step line paint first — otherwise the overlay spends that
    // moment still claiming to be downloading. (The 3D viewer gets this for
    // free: it waits on Cesium's first postRender.) One frame to apply the
    // text, a second to be past its paint.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    renderArchivedResults({ results: data, resultsEl: results, statusEl, threeDUrl: `${entry.base}/3d` });
    loading.done();
  } catch (err) {
    console.error(err);
    // Unlike the 3D viewer, there's a usable page behind this overlay — nav,
    // the day's notes, the way back to the archive — so the error goes in the
    // status line and the overlay gets out of the way.
    loading.done();
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
