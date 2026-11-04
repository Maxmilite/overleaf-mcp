import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSections, sectionExtent, maskComments, findSection } from '../src/latex.mjs';

const DOC = String.raw`\documentclass{article}
\begin{document}
\section{Introduction}
Intro text % \section{Fake}
\subsection{Motivation}
Why.
% \section{Commented Out}
\section{Method}
\subsection{Setup}
Details.
\subsection{Results}
Numbers.
\end{document}
`;

test('finds every real section and skips commented-out ones', () => {
  const titles = parseSections(DOC).map((s) => s.title);
  assert.deepEqual(titles, ['Introduction', 'Motivation', 'Method', 'Setup', 'Results']);
});

test('maskComments preserves offsets', () => {
  const masked = maskComments(DOC);
  assert.equal(masked.length, DOC.length);
  assert.ok(!masked.includes('Commented Out'));
  assert.equal(masked.indexOf('\\section{Method}'), DOC.indexOf('\\section{Method}'));
});

test('a section owns its subsections', () => {
  const sections = parseSections(DOC);
  const { start, end } = sectionExtent(DOC, sections, 0); // Introduction
  const body = DOC.slice(start, end);
  assert.ok(body.includes('\\subsection{Motivation}'), 'subsection stays inside its parent');
  assert.ok(!body.includes('\\section{Method}'), 'next same-level section is excluded');
});

test('a subsection stops at the next heading of the same level', () => {
  const sections = parseSections(DOC);
  const idx = findSection(sections, 'Setup');
  const body = DOC.slice(sectionExtent(DOC, sections, idx).start, sectionExtent(DOC, sections, idx).end);
  assert.ok(body.includes('Details.'));
  assert.ok(!body.includes('Results'));
});

test('the last section stops before \\end{document}', () => {
  const sections = parseSections(DOC);
  const idx = findSection(sections, 'Results');
  const body = DOC.slice(sectionExtent(DOC, sections, idx).start, sectionExtent(DOC, sections, idx).end);
  assert.ok(body.includes('Numbers.'));
  assert.ok(!body.includes('\\end{document}'));
});

test('handles starred forms, short titles and nested braces', () => {
  const src = String.raw`\section*{Starred}
\section[Short]{Long \emph{title} with {braces}}
\subsection{Deep {nested {three}}}`;
  const sections = parseSections(src);
  assert.deepEqual(
    sections.map((s) => s.title),
    ['Starred', 'Long \\emph{title} with {braces}', 'Deep {nested {three}}'],
  );
});

test('escaped percent does not start a comment', () => {
  const src = String.raw`\section{A} 50\% done
\section{B}`;
  assert.deepEqual(parseSections(src).map((s) => s.title), ['A', 'B']);
});

test('findSection is case-insensitive on the second pass', () => {
  const sections = parseSections(DOC);
  assert.equal(findSection(sections, 'method'), 2);
  assert.equal(findSection(sections, 'Nope'), -1);
});

test('unterminated title does not throw', () => {
  assert.doesNotThrow(() => parseSections('\\section{broken'));
});
