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
import { SCENES } from './fixtures/scenes.mjs';

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

// Default scene used when a case doesn't specify one. Most opening-area
// prompt tests work against this. For scenario-specific cases (combat,
// containers, endgame) we attach an explicit scene from SCENES.
const OPENING_SCENE = SCENES.opening;

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

  // ---- Combat (troll room) ----
  { scene: SCENES.trollRoom, input: 'fight the troll',               want: 'ATTACK TROLL' },
  // Accept either ATTACK or KILL — both are valid game verbs with
  // equivalent semantics; the test checks for TROLL in the output.
  { scene: SCENES.trollRoom, input: 'kill the troll with the sword', want: 'TROLL' },
  { scene: SCENES.trollRoom, input: 'attack him',                    want: 'ATTACK TROLL' },
  { scene: SCENES.trollRoom, input: 'take the axe',                  want: 'TAKE AXE' },

  // ---- Combat (cyclops) ----
  { scene: SCENES.cyclopsRoom, input: 'fight the cyclops',           want: 'ATTACK CYCLOPS' },
  { scene: SCENES.cyclopsRoom, input: 'go up the stairs',            want: 'UP' },

  // ---- Containers (kitchen) ----
  // Parser accepts either SACK or BAG — grammar has both.
  { scene: SCENES.kitchen, input: 'grab the sack',                   want: 'TAKE' },
  { scene: SCENES.kitchen, input: 'open the brown sack',             want: 'OPEN SACK' },
  { scene: SCENES.kitchen, input: 'drink the water',                 want: 'DRINK WATER' },
  { scene: SCENES.kitchen, input: 'climb up the staircase',          want: 'UP' },
  { scene: SCENES.kitchen, input: 'go out the window',               want: 'OUT' },

  // ---- Inventory + trophy case (living room) ----
  { scene: SCENES.livingRoom, input: 'take the lantern',             want: 'TAKE LANTERN' },
  { scene: SCENES.livingRoom, input: 'grab the sword off the wall',  want: 'TAKE SWORD' },
  { scene: SCENES.livingRoom, input: 'read the newspaper',           want: 'READ' },  // READ any paper-like noun
  { scene: SCENES.livingRoom, input: 'look under the rug',           want: 'RUG' },   // MOVE/EXAMINE/LOOK-UNDER RUG — any is acceptable; grammar-valid output should mention RUG

  // ---- Egyptian tomb (coffin) ----
  { scene: SCENES.egyptianTomb, input: 'take the gold coffin',       want: 'TAKE' },  // TAKE COFFIN or TAKE GOLD COFFIN
  { scene: SCENES.egyptianTomb, input: 'go south',                   want: 'SOUTH' },

  // ---- Dark / grue ----
  { scene: SCENES.darkGrue, input: 'light my lantern',               want: 'LIGHT' },
  { scene: SCENES.darkGrue, input: 'turn on the lamp',               want: 'LIGHT' },

  // ---- Temple altar ----
  { scene: SCENES.templeAltar, input: 'read the black book',         want: 'READ' },  // READ BOOK
  { scene: SCENES.templeAltar, input: 'put out the candles',         want: 'EXTINGUI' },  // EXTINGUI CANDLES (truncated in grammar)
];

let currentEngine = engine;
let failed = 0, errored = 0;

async function runOne({ input, want, scene = OPENING_SCENE }) {
  if (typeof currentEngine.resetChat === 'function') {
    await currentEngine.resetChat();
  }
  const r = await currentEngine.chat.completions.create({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Scene:\n${scene}\n\nPlayer input: ${input}` },
    ],
    max_tokens: 80, temperature: 0,
    response_format: { type: 'grammar', grammar },
  });
  let cmd = '(parse-err)';
  try { cmd = JSON.parse(r.choices[0].message.content).command; } catch {}
  return cmd;
}

for (const c of cases) {
  const { input, want } = c;
  let cmd, ok = false, tag = 'ok  ';
  try {
    cmd = await runOne(c);
    const wants = want.toUpperCase().split(' ');
    ok = wants.every(w => cmd.toUpperCase().includes(w));
    if (!ok) { failed++; tag = 'FAIL'; }
  } catch (e) {
    // xgrammar state corruption bug: rare per-call crash. Recreate the
    // engine and continue; mark this case as errored (not failed).
    errored++; tag = 'ERR ';
    cmd = `(crash: ${e.message.slice(0, 40)})`;
    console.log(`  ${tag}  ${JSON.stringify(input).padEnd(55)} → ${cmd}`);
    console.log('  (recreating engine...)');
    currentEngine = await webllm.CreateMLCEngine(MODEL, { initProgressCallback: () => {} });
    continue;
  }
  console.log(`  ${tag}  ${JSON.stringify(input).padEnd(55)} → ${cmd.padEnd(35)} (want: ${want})`);
}

const passed = cases.length - failed - errored;
console.log(`\n${passed}/${cases.length} passed, ${failed} failed, ${errored} errored (engine crashes)`);
process.exit((failed + errored) === 0 ? 0 : 1);
