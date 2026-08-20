// Shared DOM helpers for the page controllers.
//
// The repo rule is that user text never goes through innerHTML, and el() is
// the load-bearing half of that: everything user-visible is built with
// createElement/textContent. One copy here instead of one per controller —
// before this module, el() existed six times, character-identical.

/** Make an element; className and textContent optional. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** getElementById with the "it's in this page's template" contract baked in. */
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** getElementById for markup that may legitimately be absent. */
export const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

export type StatusKind = 'ok' | 'error' | '';

/**
 * Write a status line: textContent plus an ok/error class layered onto
 * whatever base class the element carries (form-status, comp-notes-status,
 * day-claim-status, …) — the stylesheet colors the compound selectors.
 */
export function setStatus(node: HTMLElement | null, message: string, kind: StatusKind = ''): void {
  if (!node) return;
  node.textContent = message;
  node.classList.remove('ok', 'error');
  if (kind) node.classList.add(kind);
}

/**
 * A message worth showing a user, from an unknown thrown value.
 *
 * PostgrestError is a plain object, not an Error, so `String(err)` on a failed
 * query renders the literal "[object Object]" — which is what a missing table
 * or a denied policy looks like from here. Read `message` off anything that
 * carries one before falling back.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const { message, details } = err as { message?: unknown; details?: unknown };
    if (typeof message === 'string' && message) return message;
    if (typeof details === 'string' && details) return details;
  }
  return String(err);
}
