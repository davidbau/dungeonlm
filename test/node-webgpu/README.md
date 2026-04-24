# Node + WebGPU + Web-LLM

Fast dev loop for dungeonlm's LLM parser: runs `@mlc-ai/web-llm` **unmodified
except for an idempotent source patch** in a Node process, talking to your
actual GPU via **Dawn's Node bindings**. No Chromium, no sidecar. Grammar-
constrained decoding (`response_format: { type: "grammar", grammar: ... }`)
works identically to the browser path.

## Why this exists

dungeonlm ships a Web-LLM-based natural-language parser fallback. The
browser path is the production target, but iterating on grammar, prompts,
and vocabulary in a real browser is slow (Chrome cold start, IndexedDB
cache, Playwright plumbing). This directory makes the same Web-LLM engine
runnable directly from `node` in ~1 second after first model download.

## Run

```bash
npm install                  # postinstall patches @mlc-ai/web-llm (see patch.mjs)
npm run test:node-webgpu     # runs smoke.mjs
```

First run downloads Qwen2.5-0.5B-Instruct (~350 MB) into
`.webllm-cache/` at the repo root; subsequent runs hit that cache.

Expected last line:

```
[smoke] ok
```

With `WEBLLM_MODEL=...` you can swap models (any MLC-prebuilt id).

## What's in here

| File | Purpose |
|---|---|
| `shims.mjs` | Browser-env polyfills: `navigator.gpu` (Dawn), filesystem-backed Cache API, `fake-indexeddb`, DOM stubs, CJS-marker globals. ~110 lines. |
| `patch.mjs` | One-shot idempotent rewrite of `node_modules/@mlc-ai/web-llm/lib/index.js` to rename `require()`, `__dirname`, `__filename` to non-CJS identifiers. Runs at `postinstall`. |
| `smoke.mjs` | End-to-end: load model, plain chat, grammar-constrained chat. |

## Why the bundle needs patching

Node 22+ throws `ERR_AMBIGUOUS_MODULE_SYNTAX` on any ESM file that
statically contains **both** top-level `await` **and** CJS markers like
`require()`, `__dirname`, `__filename` — even when those markers sit in
dead-code branches for browser contexts. Web-LLM's bundle has exactly
that pattern in the Emscripten-generated portions of TVM's runtime.

The patch renames the offending identifiers (eight total — three
`require('u' + 'rl')`, two `__dirname`, three `__filename`) to harmless
replacements, and `shims.mjs` wires up globals of those names that behave
correctly.

See [dungeonlm#1](https://github.com/davidbau/dungeonlm/issues/1) for the
upstream fix tracker — the long-term fix is a Web-LLM build-config change
(Rollup banner or source-level rewrite) so downstream users don't need
the postinstall step.

## Gotchas

- Worker-based engine (`CreateWebWorkerMLCEngine`) is **not** supported;
  this path only wires up the main-thread `CreateMLCEngine`. Web-LLM's
  worker bridge would need `worker_threads` plumbing.
- The cache scope is process-wide; the Dawn GPU device is a singleton.
  Parallel tests within one process are fine; separate processes each
  hold their own GPU device.
- On Linux, Dawn prebuilts may or may not detect Vulkan — check
  `node test/node-webgpu/shims.mjs` outputs an adapter before expecting
  inference to work.
