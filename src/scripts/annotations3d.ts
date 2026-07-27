/**
 * Annotations on the 3D viewer: notes against a moment on one pilot's flight.
 *
 * Display is "pin + panel": a numbered chip sits on the track at the annotated
 * fix, the note's text lives in the left panel, and the two stay in sync — click
 * a pin to focus its row, click a row to seek the playhead there, show that
 * pilot and pin them so the follow-cam flies to the moment. Each note also gets
 * a pennant on the altitude scrubber's time axis, which is how you find one
 * without hunting the globe.
 *
 * Placing one is a single button: "Add note here" takes the pinned pilot at
 * wherever the playhead sits. The moment is not frozen at that point — an open
 * composer rides the playhead (see onFrame), so scrubbing to a better instant
 * and then saving moves the note. Editing works the same way, which is why
 * opening an edit seeks to the note first: composing against a playhead parked
 * somewhere else would silently move the note on save.
 *
 * Notes are private to the account that wrote them. Sharing a day's notes by
 * link is planned — see the tail of supabase/migrations/0004_annotations.sql —
 * so nothing here assumes a rendered note belongs to the reader.
 */
import * as Cesium from 'cesium';
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotationsForDay,
  updateAnnotation,
  MAX_BODY_LENGTH,
  type Annotation,
} from '../lib/annotations';
import { slugifyPilot } from '../lib/pilots';
import { isConfigured, readCachedSession } from '../lib/supabase';
import { showNotesDock } from './dock3d';
import { altAt, formatClock, positionAt, DESELECTED_GREY, type Selection, type Timeline } from './analysis';
import type { MapTrack } from '../lib/competition';

/** What the layer needs to know about a pilot to place and draw a note. */
export interface AnnotationTarget {
  pilot: string;
  track: MapTrack;
}

export interface AnnotationOptions {
  viewer: Cesium.Viewer;
  targets: AnnotationTarget[];
  colors: Map<string, string>;
  sel: Selection;
  timeline: Timeline | null;
  getScrubMs: () => number;
  utcOffsetMinutes: number | null;
  comp: string;
  day: string;
}

export interface AnnotationLayer {
  /** First refusal on a globe click. True when the layer consumed it. */
  handleClick(picked: unknown): boolean;
  /**
   * Called on every scrub/playback tick. An open composer follows the playhead,
   * so moving the time and saving moves the note.
   */
  onFrame(timeMs: number): void;
}

const INERT: AnnotationLayer = { handleClick: () => false, onFrame: () => {} };

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

/**
 * A message worth showing a user.
 *
 * PostgrestError is a plain object, not an Error, so `String(err)` on a failed
 * query renders the literal "[object Object]" — which is what a missing table or
 * a denied policy looks like from here. Read `message` off anything that carries
 * one before falling back.
 */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const { message, details } = err as { message?: unknown; details?: unknown };
    if (typeof message === 'string' && message) return message;
    if (typeof details === 'string' && details) return details;
  }
  return String(err);
}

export function mountAnnotations(opts: AnnotationOptions): AnnotationLayer {
  const { viewer, sel, colors, timeline } = opts;

  // Accounts off, or nobody signed in: no notes UI at all. (gate3d lets everyone
  // through when accounts are off, so this really can be reached.)
  const host = document.getElementById('notes3d');
  const session = isConfigured ? readCachedSession() : null;
  if (!host || !session) return INERT;
  showNotesDock();

  // The viewer is fixed to the whole viewport, so it covers the site nav — these
  // are the only route to the account page from here. Two slots: the notes dock
  // bar on a wide screen, the phone header on a narrow one. Only one is ever
  // visible, and which is the stylesheet's business, so fill both.
  const who = session.displayName?.trim() || session.email?.split('@')[0] || 'Account';
  for (const slot of document.querySelectorAll('.dock-account')) {
    const link = document.createElement('a');
    link.href = '/account';
    link.textContent = who;
    link.title = session.email ?? 'Account';
    slot.replaceChildren(link);
  }

  const listEl = document.getElementById('notes3dList') as HTMLUListElement;
  const composerEl = document.getElementById('notes3dComposer')!;
  const statusEl = document.getElementById('notes3dStatus')!;
  const addBtn = document.getElementById('noteAdd') as HTMLButtonElement;

  const byPilot = new Map(opts.targets.map((t) => [t.pilot, t]));
  const colorOf = (pilot: string): string => colors.get(pilot) ?? DESELECTED_GREY;
  const clock = (ms: number): string => formatClock(ms, opts.utcOffsetMinutes);

  let notes: Annotation[] = [];
  let pins = new Map<string, Cesium.Entity>();
  let focusedId: string | null = null;
  /**
   * Open composer: a new note, or an edit of an existing one.
   *
   * `timeMs` tracks the playhead for as long as the composer is open, so
   * scrubbing to a better moment and hitting save moves the note there.
   * `timeEl` is the header's clock, repainted on each frame.
   */
  let composing: {
    pilot: string;
    timeMs: number;
    editing?: Annotation;
    timeEl: HTMLElement;
  } | null = null;

  const setStatus = (message: string, kind: 'ok' | 'error' | '' = ''): void => {
    statusEl.textContent = message;
    statusEl.className = kind ? `notes3d-status ${kind}` : 'notes3d-status';
  };

  // ---- pins on the globe --------------------------------------------------

  /** Where a note sits in the world, or null if its moment is off the track. */
  const worldPos = (note: Annotation): Cesium.Cartesian3 | null => {
    const target = byPilot.get(labelToPilot(note));
    if (!target) return null;
    const pos = positionAt(target.track, note.time_ms);
    const alt = altAt(target.track, note.time_ms);
    if (!pos || alt == null) return null;
    return Cesium.Cartesian3.fromDegrees(pos[1], pos[0], alt);
  };

  /**
   * The display name this note refers to. Notes store the slug, so a name that
   * differs only in case or a trailing entry number still resolves.
   */
  function labelToPilot(note: Annotation): string {
    if (byPilot.has(note.pilot_label ?? '')) return note.pilot_label!;
    for (const pilot of byPilot.keys()) if (slugifyPilot(pilot) === note.pilot_key) return pilot;
    return note.pilot_label ?? note.pilot_key;
  }

  /** Rebuild every pin. Cheap — a day holds tens of notes, not thousands. */
  const rebuildPins = (): void => {
    for (const entity of pins.values()) viewer.entities.remove(entity);
    pins = new Map();
    notes.forEach((note, i) => {
      const position = worldPos(note);
      if (!position) return; // moment isn't on this day's track; the row still lists it
      const color = Cesium.Color.fromCssColorString(colorOf(labelToPilot(note)));
      pins.set(
        note.id,
        viewer.entities.add({
          position,
          point: {
            pixelSize: 9,
            color,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: String(i + 1),
            font: '500 11px Roboto, sans-serif',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: color.withAlpha(0.95),
            backgroundPadding: new Cesium.Cartesian2(6, 4),
            // Hangs BELOW the fix, while the pilot's name label sits above it.
            // Focusing a note seeks the playhead onto its moment, so the pilot's
            // live marker lands on the pin every time — same offset would print
            // the number straight through their name.
            verticalOrigin: Cesium.VerticalOrigin.TOP,
            pixelOffset: new Cesium.Cartesian2(0, 10),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    });
    stylePins();
  };

  /** Pins follow their pilot's visibility, and the focused one swells. */
  const stylePins = (): void => {
    for (const note of notes) {
      const entity = pins.get(note.id);
      if (!entity) continue;
      entity.show = sel.has(labelToPilot(note));
      const isFocused = note.id === focusedId;
      entity.point!.pixelSize = new Cesium.ConstantProperty(isFocused ? 14 : 9);
      entity.label!.scale = new Cesium.ConstantProperty(isFocused ? 1.15 : 1);
    }
  };

  const syncMarkers = (): void => {
    timeline?.setMarkers(
      notes.map((note) => ({ timeMs: note.time_ms, color: colorOf(labelToPilot(note)) })),
    );
  };

  // ---- focus --------------------------------------------------------------

  /**
   * Take the viewer to a note: show its pilot, pin them (which hands the
   * follow-cam over), and seek the playhead to the moment.
   */
  const focus = (note: Annotation, scroll = true): void => {
    focusedId = note.id;
    const pilot = labelToPilot(note);
    if (byPilot.has(pilot)) {
      if (!sel.has(pilot)) sel.setMany([pilot], true);
      if (sel.highlight() !== pilot) sel.togglePin(pilot); // togglePin would UNpin the current one
    }
    timeline?.seek(note.time_ms);
    stylePins();
    paintList();
    if (scroll) listEl.querySelector(`[data-id="${note.id}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  // ---- composer -----------------------------------------------------------

  const closeComposer = (): void => {
    composing = null;
    composerEl.replaceChildren();
  };

  const openComposer = (pilot: string, timeMs: number, editing?: Annotation): void => {
    const head = el('div', 'note-compose-head');
    const dot = el('span', 'note-dot');
    dot.style.background = colorOf(pilot);
    const timeEl = el('span', undefined, `${pilot} · ${clock(timeMs)}`);
    head.append(dot, timeEl);
    composing = { pilot, timeMs, editing, timeEl };

    const hint = el(
      'p',
      'note-compose-hint',
      'Scrub the timeline to move the moment; saving keeps wherever you leave it.',
    );

    const area = el('textarea', 'note-compose-text');
    area.maxLength = MAX_BODY_LENGTH;
    area.rows = 3;
    area.placeholder = 'What happened here?';
    area.value = editing?.body ?? '';

    const save = el('button', 'account-btn small', editing ? 'Save' : 'Add note');
    save.type = 'button';
    const cancel = el('button', 'note-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      closeComposer();
      setStatus('');
    });

    const submit = async (): Promise<void> => {
      const body = area.value.trim();
      if (!body) {
        setStatus('A note needs some text.', 'error');
        area.focus();
        return;
      }
      // The playhead may have been scrubbed since the composer opened — that is
      // how a note is moved — so take the time as it stands now, and make sure
      // the pilot is actually flying at it.
      const when = composing?.timeMs ?? timeMs;
      const target = byPilot.get(pilot);
      if (!target || positionAt(target.track, when) == null) {
        setStatus(`${pilot} isn't flying at ${clock(when)} — scrub back into their flight.`, 'error');
        return;
      }
      save.disabled = true;
      setStatus('Saving…');
      try {
        if (editing) {
          const updated = await updateAnnotation(editing.id, body, when);
          notes = notes.map((n) => (n.id === updated.id ? updated : n)).sort((a, b) => a.time_ms - b.time_ms);
        } else {
          const created = await createAnnotation({
            comp: opts.comp,
            day: opts.day,
            pilotKey: slugifyPilot(pilot),
            pilotLabel: pilot,
            timeMs: when,
            body,
          });
          notes = [...notes, created].sort((a, b) => a.time_ms - b.time_ms);
          focusedId = created.id;
        }
        closeComposer();
        setStatus('');
        refresh();
      } catch (err) {
        setStatus(describe(err), 'error');
        save.disabled = false;
      }
    };
    save.addEventListener('click', () => void submit());
    // Cmd/Ctrl+Enter saves; plain Enter stays a newline, since notes run long.
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      } else if (e.key === 'Escape') {
        closeComposer();
      }
    });

    const actions = el('div', 'note-compose-actions');
    actions.append(save, cancel);
    const box = el('div', 'note-compose');
    box.append(head, hint, area, actions);
    composerEl.replaceChildren(box);
    area.focus();
  };

  // ---- the list -----------------------------------------------------------

  const paintList = (): void => {
    listEl.replaceChildren();
    if (notes.length === 0) {
      listEl.append(
        el(
          'li',
          'notes3d-empty',
          'No notes yet. Pin a pilot, scrub to a moment, then “Add note here”.',
        ),
      );
      return;
    }

    notes.forEach((note, i) => {
      const pilot = labelToPilot(note);
      const row = el('li', 'note-row');
      row.dataset.id = note.id;
      if (note.id === focusedId) row.classList.add('focused');
      if (!byPilot.has(pilot)) row.classList.add('orphan');

      const index = el('span', 'note-index', String(i + 1));
      index.style.background = colorOf(pilot);

      const meta = el('div', 'note-meta', `${clock(note.time_ms)} · ${pilot}`);
      const body = el('div', 'note-body', note.body);

      const edit = el('button', 'note-btn', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        // Seek to the note first. The composer rides the playhead from here, so
        // opening it against a playhead parked somewhere else would silently
        // move the note the moment you saved.
        focus(note, false);
        openComposer(pilot, note.time_ms, note);
      });

      // Two-step delete rather than a browser confirm(): a modal dialog would
      // freeze the Cesium canvas behind it, and this is one click to undo a
      // misclick.
      const del = el('button', 'note-btn danger', 'Delete');
      del.type = 'button';
      let confirming = false;
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirming) {
          confirming = true;
          del.textContent = 'Sure?';
          window.setTimeout(() => {
            if (!confirming) return;
            confirming = false;
            del.textContent = 'Delete';
          }, 4000);
          return;
        }
        del.disabled = true;
        setStatus('Deleting…');
        try {
          await deleteAnnotation(note.id);
          notes = notes.filter((n) => n.id !== note.id);
          if (focusedId === note.id) focusedId = null;
          setStatus('');
          refresh();
        } catch (err) {
          setStatus(describe(err), 'error');
          del.disabled = false;
        }
      });

      const actions = el('div', 'note-actions');
      actions.append(edit, del);
      const main = el('div', 'note-main');
      main.append(meta, body, actions);
      row.append(index, main);
      row.addEventListener('click', () => focus(note, false));
      listEl.appendChild(row);
    });
  };

  /** Repaint everything that depends on the note list. */
  const refresh = (): void => {
    rebuildPins();
    paintList();
    syncMarkers();
  };

  // ---- placement ----------------------------------------------------------

  // One way in: the pinned pilot, at wherever the playhead sits. The moment can
  // still be adjusted after the fact — the open composer follows the playhead
  // (see onFrame), so scrubbing and saving moves the note.
  addBtn.addEventListener('click', () => {
    const pilot = sel.highlight();
    if (!pilot) {
      setStatus('Pin a pilot first — click their name in the list.', 'error');
      return;
    }
    const t = opts.getScrubMs();
    const target = byPilot.get(pilot);
    if (!target || !Number.isFinite(t) || positionAt(target.track, t) == null) {
      setStatus(`${pilot} isn't flying at this moment — scrub into their flight.`, 'error');
      return;
    }
    setStatus('');
    openComposer(pilot, t);
  });

  // Pins and rows both follow selection, so a hidden track hides its notes.
  sel.subscribe(stylePins);

  // ---- load ---------------------------------------------------------------

  paintList();
  setStatus('Loading your notes…');
  void listAnnotationsForDay(opts.comp, opts.day)
    .then((rows) => {
      notes = rows;
      setStatus('');
      refresh();
    })
    .catch((err: unknown) => {
      // An expired cached session lands here. The viewer keeps working; the nav
      // chip and the account page handle re-authenticating.
      setStatus(`Couldn't load your notes: ${describe(err)}`, 'error');
    });

  const noteFromPick = (picked: unknown): Annotation | null => {
    const id = (picked as { id?: unknown } | undefined)?.id;
    if (!(id instanceof Cesium.Entity)) return null;
    for (const [noteId, entity] of pins) {
      if (entity === id) return notes.find((n) => n.id === noteId) ?? null;
    }
    return null;
  };

  return {
    handleClick(picked) {
      const note = noteFromPick(picked);
      if (!note) return false; // not ours — let the viewer pin/unpin as usual
      focus(note);
      return true;
    },
    onFrame(timeMs) {
      // An open composer rides the playhead: whatever moment it shows when you
      // save is the moment the note gets. Guarded on a real change so playback
      // doesn't rewrite the header text 60 times a second for nothing.
      if (!composing || !Number.isFinite(timeMs) || composing.timeMs === timeMs) return;
      composing.timeMs = timeMs;
      composing.timeEl.textContent = `${composing.pilot} · ${clock(timeMs)}`;
    },
  };
}
