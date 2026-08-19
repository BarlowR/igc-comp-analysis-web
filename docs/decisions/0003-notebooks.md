# 0003 — Notebooks

- **Status:** Accepted
- **Date:** 2026-08-18

## What

A notebook is a collection of markdown notes that a user creates (migration 0008). The `Notebooks` tab shows only for a signed-in session (`nav-account.ts` reveals it). The page is `/notebooks`; `?id=` opens one notebook. Notes list oldest first, so a notebook is a journal in time order.

## Links

A `note` points at comps, tasks, and annotations with standard site URLs in the markdown. Type `/link` in the editor to open a menu at the caret, filter, and select a target. The menu is a tree: comp, then task, then pilot, then annotation. Each level shows its own items, and `›` opens an item. When you type, the menu examines the full tree and shows the items it finds, each with its path. The link text stays selected after insertion, so typed text replaces it. The schema does not record what a `note` points at — the target pages resolve the links:

- `/#c/<comp>` — the archive index opens that comp's row and scrolls to it.
- `/saved#c/<comp id>` — the saved list scrolls to that comp's card.
- `/archive/<comp>/<day>` and `/saved?id=<task>` — the task pages, unchanged.
- The 3D URL + `#note=<annotation id>` — the viewer opens the notes panel, pins the pilot, and moves the playhead to the moment.

## The `Back to note` chip

A link in a `note` moves you away from the notebook. Then each page shows a `← Back to note` chip (`back-chip.ts`, loaded by `Base.astro`). The chip is a link that returns you to that `note`. You can pull the chip to a different point on the screen. The chip stays at that point across pages. The chip goes away when you open its notebook again, when you remove it with its `×`, or after 6 hours. The chip's data is in `sessionStorage`, so the chip stays in one tab.

## Markdown

`src/lib/markdown.ts` is a small renderer that makes DOM nodes and does not touch innerHTML. It covers headings, paragraphs, lists, quotes, code, bold, italic, rules, and links. It does not accept `javascript:` or other dangerous link schemes — those become plain text. We did not add a markdown package: packages render to HTML text, and that path needs a sanitizer.
