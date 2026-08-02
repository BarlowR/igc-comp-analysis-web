// Everything on the archive index that comes from the signed-in account — both
// kinds of note the app keeps:
//
//   - comp notes: one free-text note per competition, edited in its dropdown.
//     A comp with no note shows only "＋ Add a note"; the editor opens on demand
//     and is then just the text box, saving itself (see the autosave block).
//   - annotated days: a small ✎ emblem on any task this account has notes on in
//     the 3D viewer. Read-only here — the notes themselves live in that viewer.
//
// The landing page is the one page every visitor loads, and supabase-js is
// ~209 KB, so nothing here runs for a signed-out reader: the module checks the
// cached session first (0.4 KB of localStorage, no SDK — see readCachedSession)
// and returns before importing anything heavier. A signed-in reader pays for the
// SDK once, after paint, and the two reads are one query each for the whole
// page — not one per comp or per task — issued together.
import { hasStoredSession, isConfigured } from '../lib/supabase';
import { MAX_BODY_LENGTH } from '../lib/comp-notes';

/** Quiet period after the last keystroke before a write goes out. */
const AUTOSAVE_IDLE_MS = 900;

interface Elements {
  comp: string;
  section: HTMLElement;
  add: HTMLButtonElement;
  editor: HTMLElement;
  text: HTMLTextAreaElement;
  status: HTMLElement;
}

function collect(): Elements[] {
  return [...document.querySelectorAll<HTMLElement>('.comp-notes')].flatMap((section) => {
    const comp = section.dataset.comp;
    const add = section.querySelector<HTMLButtonElement>('.comp-notes-add');
    const editor = section.querySelector<HTMLElement>('.comp-notes-editor');
    const text = section.querySelector<HTMLTextAreaElement>('.comp-notes-text');
    const status = section.querySelector<HTMLElement>('.comp-notes-status');
    return comp && add && editor && text && status
      ? [{ comp, section, add, editor, text, status }]
      : [];
  });
}

/** "just now" / "3 min ago" / a date once it's older than a day. */
function since(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return new Date(then).toLocaleDateString();
}

/**
 * Put a ✎ emblem, with its count, on every task this account has annotated in
 * the 3D viewer. One query for the whole account (listMyAnnotatedDays), and the
 * marks are already in the markup — this only fills them in and reveals them.
 */
async function markAnnotatedDays(): Promise<void> {
  const marks = [...document.querySelectorAll<HTMLElement>('.day-note-mark')];
  if (!marks.length) return;

  const { listMyAnnotatedDays } = await import('../lib/annotations');
  const days = await listMyAnnotatedDays();
  if (!days.size) return;

  for (const mark of marks) {
    const entry = mark.dataset.dayKey ? days.get(mark.dataset.dayKey) : undefined;
    if (!entry) continue;
    const label = `${entry.count} note${entry.count === 1 ? '' : 's'}`;
    // The glyph is decorative; the count carries the meaning, and the title
    // spells it out for a pointer.
    mark.replaceChildren(
      Object.assign(document.createElement('span'), { textContent: '✎', ariaHidden: 'true' }),
      document.createTextNode(` ${entry.count}`),
    );
    mark.title = `You have ${label} on this task`;
    mark.setAttribute('aria-label', label);
    mark.removeAttribute('hidden');
  }
}

async function init(): Promise<void> {
  // Accounts switched off at build, or nobody signed in on this device: nothing
  // is revealed and the SDK is never fetched.
  if (!isConfigured || !hasStoredSession()) return;

  const editors = collect();
  const { listMyCompNotes, saveCompNote } = await import('../lib/comp-notes');

  // Independent reads, so they go out together rather than the emblems waiting
  // on the note bodies. Settled, not all: an unmigrated comp_notes table
  // shouldn't cost the page its emblems, and vice versa.
  const [notes, marked] = await Promise.allSettled([listMyCompNotes(), markAnnotatedDays()]);

  if (notes.status === 'fulfilled') {
    for (const el of editors) mount(el, notes.value.get(el.comp), saveCompNote);
  } else {
    // An unmigrated project (no comp_notes table yet) or a dead session
    // shouldn't leave dead controls on the archive — the rest of the page is
    // what people came for.
    console.error('comp notes unavailable', notes.reason);
  }
  if (marked.status === 'rejected') console.error('annotation marks unavailable', marked.reason);
}

type SaveFn = (comp: string, body: string) => Promise<{ body: string; updated_at: string } | null>;

function mount(
  el: Elements,
  note: { body: string; updated_at: string } | undefined,
  saveCompNote: SaveFn,
): void {
  // Autosave should be felt, not announced: everything but a failure stays in
  // the muted default, so "Saved" doesn't flash colour on every pause.
  const setStatus = (message: string, kind: 'error' | '' = ''): void => {
    el.status.textContent = message;
    el.status.className = kind ? `comp-notes-status ${kind}` : 'comp-notes-status';
  };

  const open = (focus: boolean): void => {
    el.add.hidden = true;
    el.editor.hidden = false;
    if (focus) el.text.focus();
  };

  // Signed in, so the section is theirs to see — as the button alone, until
  // there's a note or they ask for the box.
  el.section.removeAttribute('hidden');

  // What the server holds. An edit that lands back on this doesn't write.
  let committed = note?.body ?? '';
  if (note) {
    el.text.value = note.body;
    setStatus(`Saved ${since(note.updated_at)}`);
    open(false);
  }
  el.add.addEventListener('click', () => open(true));

  // --- autosave ------------------------------------------------------------
  // Debounced on typing, flushed on blur and on the page going away. One write
  // at a time: a save that finishes while the box has moved on schedules the
  // next one itself, so keystrokes during a slow round-trip can't be lost and
  // can't race each other into the wrong order.
  let timer = 0;
  let saving = false;

  const dirty = (): boolean => el.text.value.trim() !== committed.trim();

  const flush = async (): Promise<void> => {
    window.clearTimeout(timer);
    timer = 0;
    if (saving || !dirty()) return;

    const body = el.text.value;
    if (body.length > MAX_BODY_LENGTH) {
      setStatus(`Too long by ${body.length - MAX_BODY_LENGTH} characters`, 'error');
      return;
    }

    saving = true;
    setStatus('Saving…');
    try {
      const next = await saveCompNote(el.comp, body);
      committed = next?.body ?? '';
      setStatus(next ? 'Saved' : 'Note cleared');
    } catch (err) {
      // Left dirty on purpose: the next keystroke or blur retries it.
      console.error('comp note save failed', err);
      setStatus('Could not save — still editing?', 'error');
    } finally {
      saving = false;
      // Typed while that was in flight: go round again.
      if (dirty()) void flush();
    }
  };

  const scheduleSave = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void flush(), AUTOSAVE_IDLE_MS);
  };

  el.text.addEventListener('input', () => {
    if (!dirty()) {
      // Edited back to what's stored — nothing to say, and nothing to write.
      window.clearTimeout(timer);
      setStatus(committed ? 'Saved' : '');
      return;
    }
    setStatus('Editing…');
    scheduleSave();
  });

  // Leaving the box shouldn't wait out the idle timer.
  el.text.addEventListener('blur', () => void flush());

  // Last chance before the tab is hidden or unloaded. Best effort: the request
  // goes out, but nothing can await it here.
  const onLeave = (): void => {
    if (dirty()) void flush();
  };
  window.addEventListener('pagehide', onLeave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave();
  });
}

void init();
