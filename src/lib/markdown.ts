// Minimal markdown → DOM renderer for notebook notes.
//
// Deliberately not a library: the repo's rule is that user text never goes
// through innerHTML, and every markdown package renders to an HTML string.
// This builds DOM nodes directly, so there is no sanitisation step to get
// wrong. It covers the subset a note actually needs — headings, paragraphs,
// lists, blockquotes, code (fenced and inline), bold/italic, rules, links —
// and everything else stays literal text.
//
// Links: relative ("/…", "#…") render as ordinary same-tab links — that's how
// notebook notes point at comps, tasks, and annotations. http(s) and mailto
// open in a new tab. Any other scheme (javascript:, data:, …) is refused and
// rendered as plain text.

/** First heading (or first non-empty line) — the note's display title. */
export function markdownTitle(body: string): string {
  for (const line of body.split('\n')) {
    const text = line.replace(/^#{1,4}\s+/, '').trim();
    if (text) return text.slice(0, 120);
  }
  return 'Untitled note';
}

export function renderMarkdown(body: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = body.split('\n');
  let i = 0;

  /** Consecutive non-blank, non-block lines → one paragraph. */
  const paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInline(p, paragraph.join(' '));
    frag.appendChild(p);
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    // Fenced code: everything to the closing fence, literally.
    if (/^```/.test(line)) {
      flushParagraph();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or EOF)
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code.join('\n');
      pre.appendChild(codeEl);
      frag.appendChild(pre);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      // h1 is the page's own; note headings start at h3 so a note can't outrank
      // the notebook it lives in.
      const level = Math.min(6, heading[1].length + 2);
      const h = document.createElement(`h${level}`);
      appendInline(h, heading[2]);
      frag.appendChild(h);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph();
      frag.appendChild(document.createElement('hr'));
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      const bq = document.createElement('blockquote');
      const p = document.createElement('p');
      appendInline(p, quote.join(' '));
      bq.appendChild(p);
      frag.appendChild(bq);
      continue;
    }

    const listKind = /^\s*[-*]\s+/.test(line) ? 'ul' : /^\s*\d+[.)]\s+/.test(line) ? 'ol' : null;
    if (listKind) {
      flushParagraph();
      const strip = listKind === 'ul' ? /^\s*[-*]\s+/ : /^\s*\d+[.)]\s+/;
      const test = listKind === 'ul' ? /^\s*[-*]\s+/ : /^\s*\d+[.)]\s+/;
      const list = document.createElement(listKind);
      while (i < lines.length && test.test(lines[i])) {
        const item = document.createElement('li');
        appendInline(item, lines[i++].replace(strip, ''));
        list.appendChild(item);
      }
      frag.appendChild(list);
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();
  return frag;
}

// ---- inline ---------------------------------------------------------------

// One scan, earliest match wins: `code`, [text](href), **bold**, *em* / _em_.
const INLINE =
  /(`[^`]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*)\*)|(_([^_\s][^_]*)_)/;

function appendInline(parent: HTMLElement, text: string): void {
  let rest = text;
  for (;;) {
    const m = INLINE.exec(rest);
    if (!m) break;
    if (m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, m.index)));

    if (m[1]) {
      const code = document.createElement('code');
      code.textContent = m[1].slice(1, -1);
      parent.appendChild(code);
    } else if (m[2]) {
      parent.appendChild(linkOrText(m[3], m[4]));
    } else if (m[5]) {
      const strong = document.createElement('strong');
      appendInline(strong, m[6]);
      parent.appendChild(strong);
    } else {
      const em = document.createElement('em');
      appendInline(em, m[8] ?? m[10]);
      parent.appendChild(em);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) parent.appendChild(document.createTextNode(rest));
}

function linkOrText(label: string, href: string): Node {
  const internal = href.startsWith('/') || href.startsWith('#');
  const external = /^(https?:|mailto:)/i.test(href);
  if (!internal && !external) return document.createTextNode(label); // javascript: etc.

  const a = document.createElement('a');
  a.href = href;
  appendInline(a, label);
  if (external) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  return a;
}
