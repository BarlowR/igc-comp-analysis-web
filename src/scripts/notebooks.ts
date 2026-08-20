// Notebooks page controller. Two modes off one static page:
//   /notebooks            — list this account's notebooks (create / delete)
//   /notebooks?id=<uuid>  — open one: its notes rendered as markdown, with an
//                           editor whose link picker inserts links to comps,
//                           tasks, and single annotations.
//
// Everything user-written renders through renderMarkdown (DOM nodes, never
// innerHTML) or textContent.
import { renderMarkdown, markdownTitle } from '../lib/markdown';
import {
  createNote,
  createNotebook,
  deleteNote,
  deleteNotebook,
  fetchNotebook,
  listNotebooks,
  listNotes,
  MAX_NOTE_LENGTH,
  updateNote,
  type NotebookNote,
} from '../lib/notebooks';
import { gateAccountPage } from '../lib/account-gate';
import { $, el } from '../lib/dom';
import {
  annotationUrl,
  archiveCompUrl,
  archiveTaskUrl,
  notebookUrl,
  parseNoteAnchor,
  savedCompUrl,
  savedTaskUrl,
} from '../lib/links';
import { stashBackNote } from './back-chip';

const statusEl = $('status');
const titleEl = $('nb-title');
const listCard = $('nb-list-card');
const listEl = $('nb-list');
const createForm = $('nb-create') as HTMLFormElement;
const nameInput = $('nb-name') as HTMLInputElement;
const notesSection = $('nb-notes');
const noteListEl = $('nb-note-list');
const addBtn = $('nb-add') as HTMLButtonElement;

function setStatus(message: string): void {
  statusEl.textContent = message;
}

// ---- notebook list ----------------------------------------------------------

async function renderList(): Promise<void> {
  setStatus('Loading…');
  const notebooks = await listNotebooks();
  setStatus('');
  listCard.removeAttribute('hidden');
  listEl.replaceChildren();

  if (notebooks.length === 0) {
    listEl.appendChild(el('p', 'field-hint', 'No notebooks yet. Create one below.'));
    return;
  }
  for (const nb of notebooks) {
    const card = el('div', 'claim-card');
    const head = el('div', 'claim-card-head');
    const link = el('a', 'claim-day-link', nb.name) as HTMLAnchorElement;
    link.href = notebookUrl(nb.id);
    head.appendChild(link);
    head.appendChild(el('span', 'claim-day-date', new Date(nb.created_at).toLocaleDateString()));

    const drop = el('button', 'claim-remove', 'Delete');
    drop.type = 'button';
    drop.addEventListener('click', async () => {
      if (!window.confirm(`Delete "${nb.name}" and every note in it?`)) return;
      drop.disabled = true;
      try {
        await deleteNotebook(nb.id);
        card.remove();
        if (!listEl.querySelector('.claim-card')) void renderList();
      } catch (err) {
        drop.disabled = false;
        setStatus(`Delete failed: ${(err as Error).message}`);
      }
    });
    head.appendChild(drop);
    card.appendChild(head);
    listEl.appendChild(card);
  }
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  setStatus('Creating…');
  try {
    const nb = await createNotebook(name);
    window.location.href = notebookUrl(nb.id);
  } catch (err) {
    setStatus((err as Error).message);
  }
});

// ---- one notebook -----------------------------------------------------------

let notebookId = '';

async function openNotebook(id: string): Promise<void> {
  setStatus('Loading…');
  const nb = await fetchNotebook(id);
  if (!nb) {
    // RLS makes "someone else's" and "doesn't exist" the same answer.
    setStatus('Notebook not found. It may belong to a different account.');
    return;
  }
  notebookId = id;
  titleEl.textContent = nb.name;
  document.title = `${nb.name} — Outclimb.app`;

  const notes = await listNotes(id);
  setStatus('');
  notesSection.removeAttribute('hidden');
  noteListEl.replaceChildren();
  if (notes.length === 0) {
    noteListEl.appendChild(el('p', 'field-hint', 'Empty notebook — add the first note.'));
  }
  for (const note of notes) noteListEl.appendChild(noteCard(note));

  // Arriving on the back chip's link: #note-<id> scrolls to the note you left.
  const linked = parseNoteAnchor(window.location.hash);
  if (linked) {
    document.getElementById(`note-${linked}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

/** A rendered note: markdown body, then date · Edit · Delete underneath. */
function noteCard(note: NotebookNote): HTMLElement {
  const card = el('section', 'card nb-note');
  card.id = `note-${note.id}`; // the back chip's return anchor

  const body = el('div', 'nb-note-body');
  body.appendChild(renderMarkdown(note.body));
  // Following a link out of a note arms the "← Back to note" chip
  // (src/scripts/back-chip.ts). External links open a new tab and hash-only
  // links stay on this page — neither leaves the notebook, so neither counts.
  body.addEventListener('click', (event) => {
    const a = (event.target as HTMLElement).closest('a');
    if (!a || a.target === '_blank' || a.getAttribute('href')?.startsWith('#')) return;
    stashBackNote(notebookId, note.id, markdownTitle(note.body));
  });
  card.appendChild(body);

  const foot = el('div', 'nb-note-foot');
  foot.appendChild(el('span', 'field-hint', new Date(note.created_at).toLocaleDateString()));

  const edit = el('button', 'linklike', 'Edit');
  edit.type = 'button';
  edit.addEventListener('click', () => {
    card.replaceWith(editorCard(note));
  });
  foot.appendChild(edit);

  const drop = el('button', 'linklike nb-danger', 'Delete');
  drop.type = 'button';
  drop.addEventListener('click', async () => {
    if (!window.confirm(`Delete "${markdownTitle(note.body)}"?`)) return;
    drop.disabled = true;
    try {
      await deleteNote(note.id);
      card.remove();
    } catch (err) {
      drop.disabled = false;
      setStatus(`Delete failed: ${(err as Error).message}`);
    }
  });
  foot.appendChild(drop);

  card.appendChild(foot);
  return card;
}

// ---- editor -----------------------------------------------------------------

/** An editor card: textarea with the /link slash command, save/cancel.
 *  Editing an existing note replaces its card; a new note's editor appends. */
function editorCard(note: NotebookNote | null): HTMLElement {
  const card = el('section', 'card nb-note nb-editing');

  const wrap = el('div', 'nb-text-wrap');
  const area = document.createElement('textarea');
  area.className = 'nb-text';
  area.rows = 10;
  area.maxLength = MAX_NOTE_LENGTH;
  area.value = note?.body ?? '';
  area.placeholder =
    '# Title\n\nMarkdown — **bold**, *italic*, - lists.\nType /link to link a comp, task, or annotation.';
  // The editor grows to fit the whole text — no inner scrollbar; rows=10 is
  // the floor. +2 covers the borders (border-box height = scrollHeight + them).
  const autosize = (): void => {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  };
  area.addEventListener('input', autosize);
  // Not in the DOM yet — scrollHeight is 0 until the caller mounts the card.
  requestAnimationFrame(autosize);
  wrap.appendChild(area);
  card.appendChild(wrap);
  mountSlashMenu(area, wrap);

  const actions = el('div', 'nb-note-foot');
  const save = el('button', 'account-btn small', 'Save');
  save.type = 'button';
  const cancel = el('button', 'linklike', 'Cancel');
  cancel.type = 'button';
  const note_status = el('span', 'field-hint');
  actions.append(save, cancel, note_status);
  card.appendChild(actions);

  save.addEventListener('click', async () => {
    const body = area.value.trim();
    if (!body) {
      note_status.textContent = 'The note is empty.';
      return;
    }
    save.disabled = true;
    note_status.textContent = 'Saving…';
    try {
      const stored = note ? await updateNote(note.id, body) : await createNote(notebookId, body);
      card.replaceWith(noteCard(stored));
      noteListEl.querySelector('p.field-hint')?.remove(); // the "empty notebook" hint
    } catch (err) {
      save.disabled = false;
      note_status.textContent = `Save failed: ${(err as Error).message}`;
    }
  });

  cancel.addEventListener('click', () => {
    if (note) card.replaceWith(noteCard(note));
    else card.remove();
  });

  return card;
}

addBtn.addEventListener('click', () => {
  const editor = editorCard(null);
  noteListEl.appendChild(editor);
  editor.querySelector('textarea')?.focus();
  editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

// ---- link targets -----------------------------------------------------------

/**
 * One entry in the link picker's tree: comp → task → pilot → annotation.
 * A node without a url (a pilot) is a folder only; a node with children can
 * be picked as-is or drilled into.
 */
interface LinkNode {
  /** Top-level section header; root nodes only. */
  group?: string;
  /** Shown in the list at this node's own level. */
  label: string;
  /** Markdown link text on insertion; defaults to label. */
  insert?: string;
  url?: string;
  children?: LinkNode[];
}

let roots: LinkNode[] | null = null;
let rootsLoading: Promise<LinkNode[]> | null = null;

/**
 * Everything a note can link to, as a tree: archive comps (from the public
 * roster) and the account's saved comps, each opening into tasks, then the
 * pilots the account has annotated on that task, then the annotations
 * themselves (deep-linked into the 3D viewer at their moment). Built once per
 * page; each source fails soft so one broken fetch doesn't empty the menu.
 */
function loadTargets(): Promise<LinkNode[]> {
  rootsLoading ??= (async () => {
    const out: LinkNode[] = [];

    // Annotations first, indexed by the day they sit on and grouped by pilot.
    // The comp/task nodes below claim them; whatever nothing claims (the day
    // has left the archive or the saved list) still shows, in a flat group.
    const byDay = new Map<string, Map<string, LinkNode[]>>();
    try {
      const { listMyAnnotations } = await import('../lib/annotations');
      for (const note of await listMyAnnotations()) {
        const pilot = note.pilot_label ?? note.pilot_key;
        const excerpt = note.body.length > 40 ? `${note.body.slice(0, 40)}…` : note.body;
        const url = annotationUrl(note.comp, note.day, note.id);
        const key = `${note.comp}\n${note.day}`;
        const pilots = byDay.get(key) ?? new Map<string, LinkNode[]>();
        byDay.set(key, pilots);
        const notes = pilots.get(pilot) ?? [];
        pilots.set(pilot, notes);
        notes.push({ label: `“${excerpt}”`, insert: `${pilot} — “${excerpt}”`, url });
      }
    } catch (err) {
      console.error('[notebooks] annotations unavailable', err);
    }

    /** The day's annotations as pilot folders; claims them from the index. */
    const pilotFolders = (comp: string, day: string): LinkNode[] | undefined => {
      const key = `${comp}\n${day}`;
      const pilots = byDay.get(key);
      if (!pilots) return undefined;
      byDay.delete(key);
      return [...pilots].map(([pilot, notes]) => ({ label: pilot, children: notes }));
    };

    try {
      const { fetchRoster } = await import('../lib/roster');
      const roster = await fetchRoster();
      const comps = new Map<string, LinkNode>();
      for (const day of roster.days) {
        let comp = comps.get(day.comp);
        if (!comp) {
          comp = {
            group: 'Archive comps',
            label: day.compLabel,
            url: archiveCompUrl(day.comp),
            children: [],
          };
          comps.set(day.comp, comp);
          out.push(comp);
        }
        comp.children!.push({
          label: day.dayLabel,
          insert: `${day.compLabel} — ${day.dayLabel}`,
          url: archiveTaskUrl(day.comp, day.day),
          children: pilotFolders(day.comp, day.day),
        });
      }
    } catch (err) {
      console.error('[notebooks] roster unavailable', err);
    }

    try {
      const lib = await import('../lib/saved-comps');
      const tasks = await lib.listMyComps();
      const taskNode = (task: import('../lib/saved-comps').SavedComp): LinkNode => ({
        label: lib.savedTitle(task),
        url: savedTaskUrl(task.id),
        children: pilotFolders('saved', task.id),
      });
      for (const comp of await lib.listMyUserComps()) {
        const kids = tasks.filter((t) => t.comp_id === comp.id).map(taskNode);
        out.push({
          group: 'My comps',
          label: comp.name,
          url: savedCompUrl(comp.id),
          children: kids.length ? kids : undefined,
        });
      }
      for (const task of tasks.filter((t) => !t.comp_id)) {
        out.push({ group: 'My tasks', ...taskNode(task) });
      }
    } catch (err) {
      console.error('[notebooks] saved comps unavailable', err);
    }

    for (const pilots of byDay.values()) {
      for (const notes of pilots.values()) {
        for (const note of notes) out.push({ ...note, group: 'Annotations', label: note.insert! });
      }
    }

    roots = out;
    return out;
  })();
  return rootsLoading;
}

// ---- /link slash command ----------------------------------------------------

/**
 * Watch the textarea for a literally-typed "/link": remove it and open a
 * target menu anchored at the caret. The menu is the LinkNode tree: pick a
 * row to insert it, or drill into it (the › button, or ArrowRight on an empty
 * search) — comp → task → pilot → annotation. Typing searches the whole tree
 * and shows matches with their path. Picking a target inserts "[label](url)"
 * with the LABEL text selected, so typing immediately replaces the display
 * text; Esc closes, ArrowLeft (empty search) goes back up, arrows and Enter
 * drive the list.
 */
function mountSlashMenu(area: HTMLTextAreaElement, wrap: HTMLElement): void {
  let menu: HTMLElement | null = null;

  const close = (): void => {
    menu?.remove();
    menu = null;
    area.focus();
  };

  area.addEventListener('input', () => {
    if (menu) return;
    const at = area.selectionStart ?? 0;
    if (!area.value.slice(0, at).toLowerCase().endsWith('/link')) return;
    // Swallow the trigger text; the link lands where it was typed.
    area.setRangeText('', at - 5, at, 'end');
    openMenu(at - 5);
  });

  function openMenu(insertAt: number): void {
    menu = el('div', 'nb-slash');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'nb-slash-search';
    search.placeholder = 'Link to…';
    const list = el('div', 'nb-slash-list');
    list.append(el('p', 'field-hint', 'Loading…'));
    menu.append(search, list);

    // Anchor at the caret via the mirror-div trick: clone the textarea's text
    // up to the caret into an identically-styled block and read where a marker
    // span lands.
    const pos = caretPosition(area, insertAt);
    menu.style.left = `${Math.min(pos.left, Math.max(0, wrap.clientWidth - 340))}px`;
    menu.style.top = `${pos.top + 22}px`;
    wrap.appendChild(menu);
    search.focus();

    let shown: { node: LinkNode; display: string }[] = [];
    let active = 0;
    /** Drill trail; empty = top level. */
    const path: LinkNode[] = [];

    const level = (): LinkNode[] =>
      path.length ? (path[path.length - 1].children ?? []) : (roots ?? []);

    // The whole tree flat for search: every pickable node with its path text.
    // Shallow entries first, so a comp outranks its own subtree in results.
    interface FlatEntry {
      node: LinkNode;
      text: string;
      display: string;
      depth: number;
    }
    let flat: FlatEntry[] | null = null;
    const flatten = (): FlatEntry[] => {
      if (flat) return flat;
      const acc: FlatEntry[] = [];
      const walk = (nodes: LinkNode[], trail: string[]): void => {
        for (const node of nodes) {
          const display = [...trail, node.label].join(' › ');
          if (node.url) acc.push({ node, text: display.toLowerCase(), display, depth: trail.length });
          if (node.children) walk(node.children, [...trail, node.label]);
        }
      };
      walk(roots ?? [], []);
      acc.sort((a, b) => a.depth - b.depth);
      flat = acc;
      return acc;
    };

    const drill = (node: LinkNode): void => {
      if (!node.children?.length) return;
      path.push(node);
      search.value = '';
      filter();
      search.focus();
    };

    const paint = (): void => {
      list.replaceChildren();
      const searching = search.value.trim() !== '';
      if (path.length && !searching) {
        const up = el('button', 'nb-slash-item nb-slash-up', `‹ ${path[path.length - 1].label}`);
        up.type = 'button';
        up.addEventListener('click', () => {
          path.pop();
          filter();
          search.focus();
        });
        list.appendChild(up);
      }
      if (!shown.length) {
        list.appendChild(el('p', 'field-hint', 'No matches.'));
        return;
      }
      let lastGroup = '';
      shown.forEach(({ node, display }, i) => {
        if (!searching && !path.length && node.group && node.group !== lastGroup) {
          lastGroup = node.group;
          list.appendChild(el('div', 'nb-slash-group', node.group));
        }
        const row = el('div', 'nb-slash-row');
        const main = el('button', `nb-slash-item${i === active ? ' active' : ''}`, display);
        main.type = 'button';
        main.addEventListener('click', () => (node.url ? pick(node) : drill(node)));
        row.appendChild(main);
        if (node.children?.length) {
          const more = el('button', 'nb-slash-drill', '›');
          more.type = 'button';
          more.title = 'Open';
          more.addEventListener('click', () => drill(node));
          row.appendChild(more);
        }
        list.appendChild(row);
      });
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };

    const filter = (): void => {
      const q = search.value.trim().toLowerCase();
      shown = q
        ? flatten()
            .filter((entry) => entry.text.includes(q))
            .map(({ node, display }) => ({ node, display }))
        : level().map((node) => ({ node, display: node.label }));
      active = 0;
      paint();
    };

    void loadTargets().then(() => {
      if (menu) filter();
    });

    search.addEventListener('input', filter);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!shown.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        paint();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const node = shown[active]?.node;
        if (!node) return;
        if (node.url) pick(node);
        else drill(node);
      } else if (e.key === 'ArrowRight' && !search.value) {
        // Only on an empty search — otherwise the arrows are the caret's.
        e.preventDefault();
        if (shown[active]) drill(shown[active].node);
      } else if (e.key === 'ArrowLeft' && !search.value && path.length) {
        e.preventDefault();
        path.pop();
        filter();
      }
    });
    // Clicking back into the text (or anywhere off the menu) abandons it.
    menu.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        if (menu && !menu.contains(document.activeElement)) close();
      });
    });

    function pick(target: LinkNode): void {
      const label = target.insert ?? target.label;
      const md = `[${label}](${target.url})`;
      area.setRangeText(md, insertAt, insertAt, 'end');
      // setRangeText fires no input event; the editor's autosize needs one.
      area.dispatchEvent(new Event('input', { bubbles: true }));
      close();
      // Select the label so typing replaces the display text.
      area.setSelectionRange(insertAt + 1, insertAt + 1 + label.length);
    }
  }
}

/** Pixel position of a caret offset inside the textarea, relative to `wrap`. */
function caretPosition(area: HTMLTextAreaElement, offset: number): { left: number; top: number } {
  const mirror = document.createElement('div');
  const style = window.getComputedStyle(area);
  for (const prop of [
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  ] as const) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.width = `${area.clientWidth}px`;
  mirror.textContent = area.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  area.parentElement!.appendChild(mirror);
  const left = marker.offsetLeft;
  const top = marker.offsetTop - area.scrollTop;
  mirror.remove();
  return { left, top };
}

// ---- entry ------------------------------------------------------------------

void gateAccountPage(setStatus, async () => {
  const id = new URLSearchParams(window.location.search).get('id');
  if (id) await openNotebook(id);
  else await renderList();
});
