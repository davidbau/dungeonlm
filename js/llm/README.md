# dungeonlm — LLM Parser Fallback

Scaffolding for the optional WebGPU LLM parser that translates natural
English into canonical Dungeon commands when the classic parser rejects
input. See the full design document at
[`../../docs/LLM_PARSER_DESIGN.md`](../../docs/LLM_PARSER_DESIGN.md).

## Model files (not in git)

The model weights and WebGPU kernel are re-fetchable and excluded from
the repo via `.gitignore` (`js/llm/models/`, `js/llm/libs/*.wasm`).

- **`models/Qwen2.5-1.5B-Instruct-q4f16_1-MLC/`** (~840 MB) — MLC-format
  weights. Download with:

  ```bash
  huggingface-cli download mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC \
    --local-dir js/llm/models/Qwen2.5-1.5B-Instruct-q4f16_1-MLC
  ```

- **`libs/Qwen2-1.5B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm`** (~5 MB) —
  precompiled WGSL kernel. Download with:

  ```bash
  curl -sSL -o js/llm/libs/Qwen2-1.5B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm \
    https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_80/Qwen2-1.5B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm
  ```

Production can skip both by letting the browser fetch from HuggingFace +
GitHub-raw on first use. See the design doc for the tradeoffs.

## Runtime

[`@mlc-ai/web-llm`](https://webllm.mlc.ai/) 0.2.82 ships with XGrammar
support for grammar-constrained decoding via `response_format:
{ type: "grammar", grammar: <ebnf> }`.

## Grammar-constrained decoding

The grammar is auto-generated from the game's parser:

- **`extract-vocabulary.mjs`** reads `game/parser.js`'s word tables
  (BWORD/PWORD/DWORD/AWORD/OWORD/VWORD) and emits **`vocabulary.json`** —
  the authoritative list of buzzwords, prepositions, directions,
  adjectives, nouns, verbs, and meta-verbs.

- **`generate-grammar.mjs`** reads `vocabulary.json` and emits
  **`grammar.ebnf`** — a ~70-line W3C-EBNF grammar covering meta
  commands, movement, `TELL actor "…"`, `ANSWER "…"`, `INCANT "…"`,
  and ordinary actions with object phrases (adjectives, collectives,
  EXCEPT clauses), wrapped in a JSON envelope.

Regenerate after any `game/parser.js` vocabulary change:

```bash
npm run grammar:all
```

Both `vocabulary.json` and `grammar.ebnf` are committed — small text
files, and having them versioned makes grammar drift visible in review.

See [`../../docs/LLM_PARSER_DESIGN.md`](../../docs/LLM_PARSER_DESIGN.md)
§5.5 for the full rationale.
