#!/usr/bin/env node
// Replay a Dungeon playthrough input file, capturing {turn, input, scene}
// tuples for use as LLM-parser test fixtures.
//
// A "scene" here is the game output that was buffered between the previous
// input request and this one — the same text dungeonlm shows the player,
// which is also what we feed to the LLM as Scene: context on parse-fail.
//
// Usage:
//   node test/node-webgpu/capture-scenes.mjs \
//     --input test/node-webgpu/fixtures/speedrun-2.input \
//     --out   test/node-webgpu/fixtures/speedrun-2.scenes.json

import { readFileSync, writeFileSync } from 'node:fs';
import { DungeonGame } from '../../game/game.js';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1]]] : []
  )
);
if (!args.input || !args.out) {
  console.error('usage: capture-scenes.mjs --input <path> --out <path>');
  process.exit(1);
}

const data = JSON.parse(readFileSync(
  new URL('../../game/dungeon-data.json', import.meta.url), 'utf8'));
const text = JSON.parse(readFileSync(
  new URL('../../game/dungeon-text.json', import.meta.url), 'utf8'));
const inputLines = readFileSync(args.input, 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l.length > 0 && !l.startsWith('#'));

const game = new DungeonGame();
game.init(data, text);

const captures = [];
let buffered = [];
let turn = 0;
let inputIdx = 0;

const output = (s) => {
  for (let line of (s || '').split('\n')) {
    if (line.startsWith(' ')) line = line.slice(1);
    buffered.push(line);
  }
};

const input = async () => {
  // The scene associated with THIS input is whatever was buffered since
  // the last input request.
  const scene = buffered
    .filter(l => l !== '>')      // drop the bare ">" prompt marker
    .join('\n')
    .trimEnd();
  buffered = [];

  if (inputIdx >= inputLines.length) return null;
  const cmd = inputLines[inputIdx++];
  turn++;
  captures.push({ turn, scene, input: cmd });
  return cmd;
};

try {
  await game.run(input, output, {});
} catch (e) {
  if (e?.message !== 'quit') console.error('game error:', e.message);
}

writeFileSync(args.out, JSON.stringify(captures, null, 2) + '\n');
console.log(`captured ${captures.length} turns to ${args.out}`);
