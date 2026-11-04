/**
 * LaTeX structure parsing.
 *
 * Two things here are easy to get wrong and both are fixed below:
 *
 *   1. Commented-out sectioning commands. Parsing the raw text picks up
 *      `% \section{Draft}` and then "section content" boundaries land in the
 *      wrong place. We parse a comment-masked copy that keeps byte offsets
 *      identical, so every index is still valid against the original text.
 *
 *   2. Section extents. A section runs until the next heading at the same or a
 *      higher level (a section swallows its subsections), or until
 *      \end{document}. Naively slicing to "the next heading of any level" makes
 *      rewriting a section silently delete its subsections.
 */

export const SECTION_LEVELS = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

const OPENER =
  /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{/g;

/** Replace comment bodies with spaces, preserving length. */
export function maskComments(src) {
  const chars = [...src];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '%' && src[i - 1] !== '\\') {
      while (i < src.length && src[i] !== '\n') chars[i++] = ' ';
    } else {
      i++;
    }
  }
  return chars.join('');
}

export function parseSections(src) {
  const mask = maskComments(src);
  const sections = [];
  OPENER.lastIndex = 0;

  let m;
  while ((m = OPENER.exec(mask)) !== null) {
    const type = m[1];
    const start = m.index;
    let i = OPENER.lastIndex; // just past the opening brace
    let depth = 1;

    while (i < mask.length && depth > 0) {
      const ch = mask[i];
      if (ch === '\\') {
        i += 2; // escaped brace or control symbol
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }

    if (depth !== 0) break; // unterminated title: stop rather than guess

    const titleEnd = i; // index just past the closing brace
    sections.push({
      type,
      level: SECTION_LEVELS[type] ?? 99,
      title: src.slice(OPENER.lastIndex, titleEnd - 1).trim(),
      start,
      titleEnd,
    });

    OPENER.lastIndex = titleEnd;
  }

  return sections;
}

/** Half-open [start, end) covering the heading and everything it owns. */
export function sectionExtent(src, sections, index) {
  const target = sections[index];
  const endDocIdx = src.lastIndexOf('\\end{document}');
  let end = endDocIdx === -1 ? src.length : endDocIdx;

  for (let j = index + 1; j < sections.length; j++) {
    if (sections[j].level <= target.level) {
      end = sections[j].start;
      break;
    }
  }
  return { start: target.start, end };
}

/** Line number (1-based) of an offset, for diagnostics the model can act on. */
export function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

export function findSection(sections, title) {
  const wanted = String(title).trim();
  const exact = sections.findIndex((s) => s.title === wanted);
  if (exact !== -1) return exact;
  const lower = wanted.toLowerCase();
  return sections.findIndex((s) => s.title.toLowerCase() === lower);
}

/**
 * `\input{...}` / `\include{...}` targets, in document order.
 *
 * CVPR-style templates keep one file per section, so the root document holds
 * almost no prose and parsing only the root yields an empty outline.
 */
export function findIncludes(src) {
  const mask = maskComments(src);
  const re = /\\(?:input|include)\s*\{([^}]+)\}/g;
  const out = [];
  let m;
  while ((m = re.exec(mask)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    out.push(/\.tex$/i.test(raw) ? raw : `${raw}.tex`);
  }
  return out;
}
