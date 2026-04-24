#!/usr/bin/env node
// Sanity-check the LLM parser's system prompt by running a fixed set of
// problem inputs through the real model and reporting the translations.
// Use this when the live site shows a wrong translation: reproduce here,
// tweak js/llm/llm-parser.js, re-run.

import './shims.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM } from '../../js/llm/llm-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.WEBLLM_MODEL || 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
const grammar = readFileSync(
  join(__dirname, '..', '..', 'js', 'llm', 'grammar.ebnf'), 'utf8'
);

const webllm = await import('@mlc-ai/web-llm');
const engine = await webllm.CreateMLCEngine(MODEL, {
  initProgressCallback: (p) => process.stdout.write(`  [${((p.progress||0)*100).toFixed(0)}%]\r`),
});
process.stdout.write('\n');

const cases = [
  // The two the user reported
  { input: 'tell me about dungeon?',                   want: 'HELP' },
  { input: 'look closer at the mailbox',               want: 'EXAMINE MAILBOX' },
  { input: 'is there anything special about the mailbox', want: 'EXAMINE MAILBOX' },
  { input: 'what else do we see',                      want: 'LOOK' },
  // Sanity checks for the other intents
  { input: 'how do I play',                            want: 'HELP' },
  { input: 'what can I do here',                       want: 'INFO or HELP' },
  { input: 'what am I carrying',                       want: 'INVENTORY' },
  { input: 'where am I',                               want: 'LOOK' },
  { input: 'I quit',                                   want: 'QUIT' },
  { input: 'grab the shiny egg',                       want: 'TAKE EGG' },
  { input: 'head north quickly',                       want: 'NORTH' },
  { input: 'smash the window open',                    want: 'BREAK WINDOW' },
];

for (const { input, want } of cases) {
  const r = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Player input: ${input}` },
    ],
    max_tokens: 200, temperature: 0,
    response_format: { type: 'grammar', grammar },
  });
  let cmd = '(parse-err)';
  try { cmd = JSON.parse(r.choices[0].message.content).command; } catch {}
  const ok = cmd.toUpperCase().includes(want.split(' or ')[0])
    || (want.includes(' or ') && want.split(' or ').some(w => cmd.toUpperCase().includes(w)));
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${JSON.stringify(input).padEnd(55)} → ${cmd.padEnd(30)} (want: ${want})`);
}
process.exit(0);
