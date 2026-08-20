// Deep links are this app's foreign keys (docs/decisions/0003-notebooks.md):
// a notebook note points at comps, tasks and annotations with ordinary site
// URLs, and the target pages resolve them. Both halves of that contract live
// here — builders and parsers — so a link the app writes is always one the
// app reads. Before this module the three hash grammars (#c/…, #note=…,
// #note-…) were built and parsed by six files with no shared constant.

// ---- builders ---------------------------------------------------------------

/** The archive index, opened and scrolled to one comp's row (index.astro). */
export const archiveCompUrl = (comp: string): string => `/#c/${comp}`;

/** An archived task's 2D page. */
export const archiveTaskUrl = (comp: string, day: string): string => `/archive/${comp}/${day}`;

/** An archived task's 3D viewer. */
export const archiveTask3dUrl = (comp: string, day: string): string =>
  `/archive/${comp}/${day}/3d`;

/** The saved list, scrolled to one comp's card (saved.ts). */
export const savedCompUrl = (compId: string): string => `/saved#c/${compId}`;

/** A saved task's 2D page. */
export const savedTaskUrl = (id: string): string => `/saved?id=${id}`;

/** A saved task's 3D viewer. */
export const savedTask3dUrl = (id: string): string => `/saved/3d?id=${id}`;

/**
 * A task's 2D and 3D pages, archived or saved. Annotations key saved-comp
 * notes as (comp: 'saved', day: <saved_comps.id>) — see track3d.ts — and
 * those pages are query-addressed, not archive paths.
 */
export function taskUrls(comp: string, day: string): { base: string; threeD: string } {
  return comp === 'saved'
    ? { base: savedTaskUrl(day), threeD: savedTask3dUrl(day) }
    : { base: archiveTaskUrl(comp, day), threeD: archiveTask3dUrl(comp, day) };
}

/** The 3D viewer with the notes panel open (dock3d honours the #note prefix). */
export const notesPanelUrl = (comp: string, day: string): string =>
  `${taskUrls(comp, day).threeD}#notes`;

/** The 3D viewer at one annotation: pilot pinned, playhead at its moment. */
export const annotationUrl = (comp: string, day: string, noteId: string): string =>
  `${taskUrls(comp, day).threeD}#note=${encodeURIComponent(noteId)}`;

/** A notebook, optionally scrolled to one of its notes. */
export const notebookUrl = (id: string, noteId?: string): string =>
  `/notebooks?id=${id}${noteId ? `#note-${noteId}` : ''}`;

// ---- parsers ----------------------------------------------------------------

/** "#c/<id>" — the comp deep link on / and /saved. */
export function parseCompHash(hash: string): string | null {
  const m = /^#c\/(.+)$/.exec(decodeURIComponent(hash));
  return m ? m[1] : null;
}

/** "#note=<id>" — one annotation, on the 3D viewer pages. */
export function parseAnnotationHash(hash: string): string | null {
  const m = /^#note=(.+)$/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}

/** "#note-<id>" — one note, on the notebook page. */
export function parseNoteAnchor(hash: string): string | null {
  const m = /^#note-(.+)$/.exec(hash);
  return m ? m[1] : null;
}

/**
 * Any notes-flavoured hash — "#notes" (the panel) or "#note=<id>" (one
 * annotation). The 3D docks open the notes panel for either; arriving on a
 * notes link and landing on a collapsed rail would read as the notes having
 * gone missing.
 */
export const wantsNotesDock = (hash: string): boolean => hash.startsWith('#note');
