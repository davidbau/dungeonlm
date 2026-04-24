# dungeonlm

MIT Dungeon (1980 — the original Zork, ported to JavaScript) in the
browser, with an **optional WebGPU-powered LLM parser fallback** that
translates natural English into the game's canonical parser vocabulary.

Classic commands like `take egg` or `read leaflet` always work. When the
LLM is enabled, phrasing like "please grab the shiny egg" is translated
into `TAKE EGG` before the 1980 parser sees it, using grammar-constrained
decoding against an EBNF derived automatically from the game's own word
tables.

## Run locally

```bash
npm install
npm run serve   # serves on http://localhost:8080
```

Open `http://localhost:8080/`. The LLM toggle is off by default. The
first time you enable it, the browser downloads the Qwen2.5-1.5B weights
(~850 MB, cached thereafter).

## Repo layout

```
dungeonlm/
├── index.html                 Landing page with terminal + LLM toggle
├── game/                      MIT Dungeon game code (self-contained)
│   ├── game.js                Main loop
│   ├── parser.js              Classic 1980 parser (word tables inside)
│   ├── verbs.js, rooms.js     Game logic
│   ├── objects*.js            Object tables / behaviors
│   ├── support.js, timefnc.js Utilities, time-triggered events
│   ├── constants.js
│   └── dungeon-{data,text}.json  Compiled world data + text strings
├── js/
│   ├── app.js                 Landing page glue + input pre-translation
│   ├── terminal.js            Minimal line-I/O terminal
│   └── llm/
│       ├── llm-parser.js      Web-LLM runtime (loaded on demand)
│       ├── grammar.ebnf       Auto-generated EBNF (XGrammar input)
│       ├── vocabulary.json    Source of truth for grammar
│       ├── extract-vocabulary.mjs  Scrapes parser.js → vocabulary.json
│       ├── generate-grammar.mjs    vocabulary.json → grammar.ebnf
│       └── README.md
├── docs/LLM_PARSER_DESIGN.md  Full architecture writeup
└── assets/fonts/              Self-hosted DejaVu Sans Mono
```

## How the LLM fallback works

1. User types a line in the terminal.
2. A lightweight heuristic decides whether it "looks like" canonical
   parser input or natural English. Short uppercase commands pass
   straight through.
3. For natural-language input, the line is sent to Qwen2.5-1.5B-Instruct
   with a system prompt and a grammar constraint
   (`response_format: { type: "grammar", grammar: ... }`). The LLM is
   restricted to emitting a JSON object whose `command` field parses
   against the game's own vocabulary.
4. The translated command is displayed to the user and fed to the
   classic 1980 parser.

The LLM is **never in the critical path**: if it's disabled, or the
translation fails, the original input is passed through. The classic
parser remains byte-for-byte compatible with the Fortran original (the
port is separately parity-tested against the 1980 source).

## Fast dev loop for the LLM parser

For iterating on grammar, prompts, or vocabulary without a browser round-trip,
dungeonlm has a **Node + Dawn WebGPU** test harness that runs the same
Web-LLM engine against your actual GPU from a plain `node` process:

```bash
npm install                   # postinstall patches the Web-LLM bundle
npm run test:node-webgpu      # ~2.8s after first model download (~350 MB cached locally)
```

See [`test/node-webgpu/README.md`](./test/node-webgpu/README.md) for the
full story — it's the first publicly documented path for running
`@mlc-ai/web-llm` unmodified in Node, and exercises the exact same
grammar-constrained decoding (`response_format: { type: "grammar" }`)
that the browser uses.

## Regenerating the grammar

After any change to `game/parser.js` word tables:

```bash
npm run grammar:all
```

This re-scrapes `BWORD`, `PWORD`, `DWORD`, `AWORD`, `OWORD`, `VWORD`
into `vocabulary.json` and rebuilds `grammar.ebnf`. Both are committed.

## Credits

MIT Dungeon by Tim Anderson, Marc Blank, Bruce Daniels, and Dave
Lebling (MIT Laboratory for Computer Science, 1977—1980).

JavaScript port derived from the Fortran V4.0 source with byte-level
parity testing.

## License

MIT, except the dungeon game data files, which carry their original
MIT license from the 1981 distribution.
