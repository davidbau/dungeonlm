#!/usr/bin/env node
// End-to-end smoke test: load Web-LLM under Node+Dawn, generate a short
// reply, then run a grammar-constrained request (the path dungeonlm uses
// for its LLM parser fallback).
//
// First run downloads ~350 MB for Qwen2.5-0.5B-Instruct into .webllm-cache/
// and takes a minute or two. Subsequent runs hit the filesystem cache and
// start in under a second.

import './shims.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.WEBLLM_MODEL || 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

console.log(`[smoke] model: ${MODEL}`);
const webllm = await import('@mlc-ai/web-llm');

const engine = await webllm.CreateMLCEngine(MODEL, {
  initProgressCallback: (p) => {
    process.stdout.write(`  [${((p.progress || 0) * 100).toFixed(0)}%] ${p.text || ''}\r`);
  },
});
process.stdout.write('\n');

// --- 1. Plain chat ---
const plain = await engine.chat.completions.create({
  messages: [
    { role: 'system', content: 'Reply in one short sentence.' },
    { role: 'user', content: 'What is 2+2?' },
  ],
  max_tokens: 32, temperature: 0,
});
console.log(`[smoke] plain: ${plain.choices[0].message.content.trim()}`);

// --- 2. Grammar-constrained (dungeonlm's actual path) ---
const grammarPath = join(__dirname, '..', '..', 'js', 'llm', 'grammar.ebnf');
const grammar = readFileSync(grammarPath, 'utf8');

const translated = await engine.chat.completions.create({
  messages: [
    { role: 'system', content:
      'Translate the player input into one canonical Dungeon command. ' +
      'Reply ONLY with the JSON object.' },
    { role: 'user', content: 'please grab the lantern' },
  ],
  max_tokens: 100, temperature: 0,
  response_format: { type: 'grammar', grammar },
});
console.log(`[smoke] grammar: ${translated.choices[0].message.content.trim()}`);
console.log('[smoke] ok');
process.exit(0);
