#!/usr/bin/env node
// One-shot patch of @mlc-ai/web-llm so it loads under Node's ESM rules.
//
// Node 22+ raises ERR_AMBIGUOUS_MODULE_SYNTAX on any ESM file that contains
// both top-level `await` and CommonJS markers (`require()`, `__dirname`,
// `__filename`, etc.). Web-LLM's bundle has top-level await AND statically
// includes Emscripten-generated code paths that reference those markers —
// even though at runtime those paths are dead-code for browser contexts.
//
// This script renames the offending identifiers in the installed bundle to
// non-CJS names; `shims.mjs` provides the replacements as globals so the
// code still works at runtime. The patch is idempotent.
//
// Run via npm postinstall, or manually: `node test/node-webgpu/patch.mjs`.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PATH = require.resolve('@mlc-ai/web-llm');   // resolves to lib/index.js
const MARKER = '__nodeRequireEsc(';

const src = readFileSync(PATH, 'utf8');
if (src.includes(MARKER)) {
  console.log('[node-webgpu] @mlc-ai/web-llm already patched');
  process.exit(0);
}

const replacements = [
  // The obfuscated `require('u' + 'rl')` survives Webpack's static analysis
  // but not Node's new ESM/CJS ambiguity check.
  [`require('u' + 'rl')`, `__nodeRequireEsc('url')`],
  // __dirname / __filename are CJS-only in ESM; renaming them keeps the
  // bundle from tripping Node's static CJS-marker scan.
  [/([^a-zA-Z_$0-9])__dirname([^a-zA-Z_$0-9])/g,  '$1__esmDirname$2'],
  [/([^a-zA-Z_$0-9])__filename([^a-zA-Z_$0-9])/g, '$1__esmFilename$2'],
  // NOTE: do NOT rewrite `module.exports` / `module["exports"]`. Most
  // occurrences are inside bundled UMD wrappers where `module` is a local
  // parameter (loglevel's wrapper, for instance) — rewriting there breaks
  // the wrapper. The global `module` is already undefined under ESM.

  // xgrammar state-leak workaround: Web-LLM reuses a cached grammarMatcher
  // across sequential completions that share the same grammar, calling
  // this.grammarMatcher.reset() instead of creating a fresh matcher. But
  // xgrammar's .reset() C++ implementation does not fully clear matcher
  // state — after ~14 rounds the matcher emits out-of-range token ids and
  // the wasm runtime crashes. Force the "cache miss" branch by replacing
  // the reuse test with a literal false; every call now compiles a fresh
  // matcher. Cost: small re-compile overhead per completion. Benefit:
  // stable across any number of rounds.
  // Use a regex to tolerate CRLF vs LF and varying indent widths.
  [
    /if \(curResponseFormatKey === this\.responseFormatCacheKey &&\s+this\.grammarMatcher\) \{/,
    'if (false /* dungeonlm: disable matcher reuse, xgrammar .reset() leaks */ && curResponseFormatKey === this.responseFormatCacheKey && this.grammarMatcher) {',
  ],
];

let out = src, total = 0;
for (const [from, to] of replacements) {
  const before = out;
  out = typeof from === 'string' ? out.split(from).join(to) : out.replace(from, to);
  const hits = typeof from === 'string'
    ? (before.split(from).length - 1)
    : (before.match(from) || []).length;
  total += hits;
}

writeFileSync(PATH, out);
console.log(`[node-webgpu] patched ${total} CJS marker(s) in @mlc-ai/web-llm`);
