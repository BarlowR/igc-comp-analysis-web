// "← Back to note": a draggable floating chip that returns to the notebook
// note you followed a link out of.
//
// notebooks.ts stashes {notebook, note, title} in sessionStorage when a link
// inside a rendered note is clicked (stashBackNote below). This module runs on
// every page from Base.astro: if a fresh stash exists it shows the chip; on
// the note's own notebook page it instead consumes the stash — you're back.
// The chip can be dragged anywhere (position survives navigation, in the same
// stash) and dismissed with its ×. sessionStorage scopes the whole thing to
// one tab, which is exactly the "I went down a rabbit hole from my note" span.

import { notebookUrl } from '../lib/links';

const KEY = 'outclimb-back-note';
const TTL_MS = 6 * 60 * 60 * 1000;
/** Movement beyond this is a drag, and the click that follows it is swallowed. */
const DRAG_SLOP_PX = 4;

interface BackStash {
  nb: string;
  note: string;
  title: string;
  at: number;
  x?: number;
  y?: number;
}

function readStash(): BackStash | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const stash = JSON.parse(raw) as BackStash;
    if (!stash.nb || !stash.note || Date.now() - stash.at > TTL_MS) return null;
    return stash;
  } catch {
    return null;
  }
}

function writeStash(stash: BackStash | null): void {
  try {
    if (stash) sessionStorage.setItem(KEY, JSON.stringify(stash));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked — the chip just won't follow along.
  }
}

/** Called by notebooks.ts when a link inside a rendered note is followed. */
export function stashBackNote(notebookId: string, noteId: string, title: string): void {
  // Keep the chip where the user last dragged it, across re-stashes.
  const prev = readStash();
  writeStash({ nb: notebookId, note: noteId, title, at: Date.now(), x: prev?.x, y: prev?.y });
}

function mount(): void {
  const stash = readStash();
  if (!stash) return;

  // Back at the source notebook: the journey is over, the chip retires.
  // (Static hosting may serve the page as /notebooks/ — trailing slash.)
  const params = new URLSearchParams(window.location.search);
  const path = window.location.pathname.replace(/\/$/, '');
  if (path === '/notebooks' && params.get('id') === stash.nb) {
    writeStash(null);
    return;
  }

  const chip = document.createElement('div');
  chip.className = 'back-chip';

  const link = document.createElement('a');
  link.href = notebookUrl(stash.nb, stash.note);
  link.textContent = '← Back to note';
  link.title = stash.title;
  chip.appendChild(link);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = '✕';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.addEventListener('click', () => {
    writeStash(null);
    chip.remove();
  });
  chip.appendChild(dismiss);

  // Position: where it was last dragged, clamped to the viewport; default
  // bottom-right, clear of the 3D viewer's scrubber.
  const place = (x: number, y: number): void => {
    const maxX = window.innerWidth - chip.offsetWidth - 8;
    const maxY = window.innerHeight - chip.offsetHeight - 8;
    chip.style.left = `${Math.min(Math.max(8, x), Math.max(8, maxX))}px`;
    chip.style.top = `${Math.min(Math.max(8, y), Math.max(8, maxY))}px`;
  };
  document.body.appendChild(chip);
  if (stash.x !== undefined && stash.y !== undefined) {
    place(stash.x, stash.y);
  } else {
    place(window.innerWidth - chip.offsetWidth - 24, window.innerHeight - chip.offsetHeight - 88);
  }

  // Drag anywhere on the chip (the × keeps its own click). A real drag
  // swallows the click so releasing over the link doesn't navigate.
  let start: { px: number; py: number; x: number; y: number } | null = null;
  let dragged = false;
  chip.addEventListener('pointerdown', (e) => {
    if (e.target === dismiss) return;
    start = { px: e.clientX, py: e.clientY, x: chip.offsetLeft, y: chip.offsetTop };
    dragged = false;
  });
  chip.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.px;
    const dy = e.clientY - start.py;
    if (!dragged && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
    if (!dragged) {
      dragged = true;
      // Capture only once it IS a drag. Capturing on pointerdown retargets
      // the eventual click to the chip itself, so the link inside would
      // never activate — a plain click on "← Back to note" would do nothing.
      chip.setPointerCapture(e.pointerId);
    }
    place(start.x + dx, start.y + dy);
  });
  chip.addEventListener('pointerup', () => {
    if (start && dragged) {
      const current = readStash();
      if (current) writeStash({ ...current, x: chip.offsetLeft, y: chip.offsetTop });
    }
    start = null;
  });
  chip.addEventListener(
    'click',
    (e) => {
      if (dragged) {
        e.preventDefault();
        e.stopPropagation();
        dragged = false;
      }
    },
    true,
  );
}

mount();
