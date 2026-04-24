#!/usr/bin/env node
// Extract Dungeon parser vocabulary from parser.js and emit JSON.
//
// The parser's word lists live as flat string arrays (BWORD, PWORD, DWORD,
// AWORD, OWORD, VWORD). We parse them out via simple regex rather than
// importing parser.js, because parser.js imports other modules at load time.
//
// Output: js/llm/vocabulary.json — the authoritative word list used to
// build the EBNF grammar at js/llm/grammar.ebnf.
//
// Usage: node js/llm/extract-vocabulary.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const parserPath = join(__dirname, '..', '..', 'game', 'parser.js');
const outPath = join(__dirname, 'vocabulary.json');

const src = readFileSync(parserPath, 'utf8');

// Extract "const NAME = [ ... ];" — tolerates multi-line, comments inside,
// and captures every quoted string in the array.
function extractList(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`could not find ${name} in parser.js`);
  const body = m[1];
  // Strip // line comments
  const stripped = body.replace(/\/\/[^\n]*/g, '');
  // Grab quoted strings (single or double, no embedded quotes expected)
  const words = [...stripped.matchAll(/'([^']*)'|"([^"]*)"/g)].map(
    m => m[1] ?? m[2]
  );
  return words;
}

// The `*` prefix in VWORD marks "primary synonym" — strip for vocabulary,
// since both * and non-* forms are accepted by the parser.
function cleanWord(w) {
  return w.startsWith('*') ? w.slice(1) : w;
}

function deduplicate(arr) {
  return [...new Set(arr)];
}

const BWORD = extractList('BWORD').map(cleanWord).filter(Boolean);
const PWORD = extractList('PWORD').map(cleanWord).filter(Boolean);
const DWORD = extractList('DWORD').map(cleanWord).filter(Boolean);
const AWORD = extractList('AWORD').map(cleanWord).filter(Boolean);
const OWORD = extractList('OWORD').map(cleanWord).filter(Boolean);
const VWORD = extractList('VWORD').map(cleanWord).filter(Boolean);

const vocabulary = {
  buzzwords:    deduplicate(BWORD).sort(),
  prepositions: deduplicate(PWORD).sort(),
  directions:   deduplicate(DWORD).sort(),
  adjectives:   deduplicate(AWORD).sort(),
  nouns:        deduplicate(OWORD).sort(),
  verbs:        deduplicate(VWORD).sort(),
};

// Flag the meta-verbs that are self-standing (no object follows):
// SCORE, QUIT, INVENTORY, LOOK, DIAGNOSE, WAIT, AGAIN, and similar.
// This list is curated from the Dungeon HELP text.
vocabulary.metaVerbs = deduplicate([
  'SCORE', 'QUIT', 'Q', 'BYE', 'GOODBYE',
  'INVENTORY', 'INVENTOR', 'I', 'LIST',
  'LOOK', 'L', 'ROOM', 'OBJECTS', 'OBJ', 'RNAME',
  'DIAGNOSE',
  'WAIT', 'AGAIN', 'G',
  'TIME', 'VERSION', 'HELP', 'INFO',
  'BRIEF', 'VERBOSE', 'SUPERBRI',
  'SAVE', 'RESTORE',
  'HISTORY', 'UPDATE', 'BACK',
]).sort();

writeFileSync(outPath, JSON.stringify(vocabulary, null, 2) + '\n');

// Summary to stderr
const n = (a) => String(a.length).padStart(4);
process.stderr.write(
  `vocabulary.json written:\n` +
  `  buzzwords:    ${n(vocabulary.buzzwords)}\n` +
  `  prepositions: ${n(vocabulary.prepositions)}\n` +
  `  directions:   ${n(vocabulary.directions)}\n` +
  `  adjectives:   ${n(vocabulary.adjectives)}\n` +
  `  nouns:        ${n(vocabulary.nouns)}\n` +
  `  verbs:        ${n(vocabulary.verbs)}\n` +
  `  metaVerbs:    ${n(vocabulary.metaVerbs)}\n`
);
