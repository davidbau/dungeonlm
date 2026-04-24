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

// The typical opening-scene context that the live app passes to the LLM.
const OPENING_SCENE = `Welcome to Dungeon (with an LLM parser).\t\t\tThis version created 2-Dec-81.
This is an open field west of a white house with a boarded front door.
There is a small mailbox here.
A rubber mat saying "Welcome to Dungeon!" lies by the door.`;

const cases = [
  // Meta-intent distinction (HELP for HOW-TO, INFO for WHAT-IS)
  { input: 'tell me about dungeon?',                       want: 'INFO' },
  { input: 'what is this game about',                      want: 'INFO' },
  { input: 'how do I play',                                want: 'HELP' },
  // HELP is the preferred answer for clear how-to / stuck / need-help
  // phrasings. "what can I do here" is intentionally NOT in this set —
  // we accept LOOK as a reasonable answer there because "here" biases
  // the model toward describing the room, which is also useful.
  { input: 'I need help',                                  want: 'HELP' },
  { input: 'I have no idea what to do',                    want: 'HELP' },
  { input: 'show me the commands',                         want: 'HELP' },
  { input: 'how does this work',                           want: 'HELP' },
  { input: 'what can I do here',                           want: 'LOOK' },
  { input: 'what am I carrying',                           want: 'INVENTORY' },
  { input: 'where am I',                                   want: 'LOOK' },
  { input: 'I quit',                                       want: 'QUIT' },

  // Object-preservation
  { input: 'look closer at the mailbox',                   want: 'EXAMINE MAILBOX' },
  { input: 'is there anything special about the mailbox', want: 'EXAMINE MAILBOX' },
  { input: 'what else do we see',                          want: 'LOOK' },
  { input: 'grab the shiny egg',                           want: 'TAKE EGG' },
  { input: 'smash the window open',                        want: 'BREAK WINDOW' },

  // Directions — the literal-direction rule under test
  { input: 'head north quickly',                           want: 'NORTH' },
  { input: 'walk to the south of the house',               want: 'SOUTH' },
  { input: 'walk to the west of the house',                want: 'WEST' },
  { input: 'walk west into the forest',                    want: 'WEST' },
  { input: 'head to the eastern part of the forest',       want: 'EAST' },
  { input: 'let us proceed northward',                     want: 'NORTH' },
  { input: 'travel southwest',                             want: 'SW' },
  { input: 'I want to go up',                              want: 'UP' },
  { input: 'lets climb down into the cave',                want: 'DOWN' },

  // Verb-vs-noun confusables
  { input: 'can we take the boards off the door',          want: 'OPEN DOOR' },
  { input: 'turn on the light',                            want: 'LIGHT' },

  // Explicit-verb-respect + collectives (regression from user report)
  { input: 'ok this is fun. we should grab everything.',   want: 'TAKE' },  // TAKE EVERYTHING or TAKE ALL
  { input: 'take all the items',                           want: 'TAKE' },
  { input: 'drop everything',                              want: 'DROP' },
  { input: 'pick up the lantern',                          want: 'TAKE LANTERN' },
];

let failed = 0;
for (const { input, want } of cases) {
  // resetChat() clears any lingering Web-LLM/xgrammar state between
  // cases. patch.mjs disables matcher reuse, but there appears to be
  // another state leak (observed crashes at ~case 13 even with the
  // patch). resetChat adds ~2s KV-reprefill per call and makes the
  // suite fully stable.
  if (typeof engine.resetChat === 'function') {
    await engine.resetChat();
  }
  const r = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Scene:\n${OPENING_SCENE}\n\nPlayer input: ${input}` },
    ],
    max_tokens: 80, temperature: 0,
    response_format: { type: 'grammar', grammar },
  });
  let cmd = '(parse-err)';
  try { cmd = JSON.parse(r.choices[0].message.content).command; } catch {}
  // Accept if every space-separated token of `want` appears in the output.
  const wants = want.toUpperCase().split(' ');
  const out = cmd.toUpperCase();
  const ok = wants.every(w => out.includes(w));
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${JSON.stringify(input).padEnd(55)} → ${cmd.padEnd(35)} (want: ${want})`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
