# LLM Parser Fallback — Design Document

> *"You are talking to a moderately stupid parser" — the 1994 Dungeon HELP text.*
> *The parser has been moderately stupid for forty-five years. This proposes to
> put a slightly smarter one behind it, without disturbing the first.*

**Status:** Design  
**Author:** Dungeon project  
**Target:** Mazes of Menace Dungeon / Zork port (MIT 1980 Fortran 4.0, JS port)  
**Runtime:** Browser, WebGPU via [@mlc-ai/web-llm](https://webllm.mlc.ai/)  
**Model:** `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`

---

## 1. Motivation

The Dungeon parser is deterministic, fast, and correct — but it is, by the
designers' own account, "moderately stupid." Many reasonable English
commands are rejected:

| Player types | Parser says |
|:---|:---|
| `slay the troll` | (works, actually — but `slay` is one of three synonyms.) |
| `put the sword away` | *I don't understand "put"* (no unholster verb) |
| `tell the robot to go east` | *I don't understand "tell"* — needs the exact `tell robot "go east"` form |
| `kill troll with the elvish blade` | *I can't see any blade here* (parser wants `sword`) |
| `smash the glacier with the torch` | *I don't understand "smash"* (needs `throw torch at glacier`) |
| `light the dang candles` | *I don't understand "dang"* — uppercase it's fine, the filler word is fatal |

Each rejection is a small friction, and they accumulate. New players
often give up on Dungeon not because the puzzles are hard, but because
the parser will not let them express a reasonable intent.

This design introduces an LLM-powered *fallback translator* that
preserves the existing parser for every command it can handle, and
intervenes only when the parser rejects input. The fallback converts a
free-form English command to a canonical Dungeon command and offers it
to the player for confirmation. The game engine continues to receive
canonical commands. **All parity tests still pass** because the engine
itself is untouched.

---

## 2. Non-goals

- **No narrative generation.** The Fortran output is part of the soul
  of the game. The LLM never writes room descriptions or flavor text.
- **No gameplay reasoning.** The LLM does not decide what to do. It
  translates English into the canonical dialect; the player still
  chooses actions.
- **No training on the fly.** No fine-tuning in the browser. The model
  is a frozen, pre-quantized checkpoint.
- **No new game state.** The LLM reads the game state but never
  modifies it. Only the existing parser and engine mutate `G`.
- **No parity-test regressions.** The LLM is invoked only on
  parser-rejected input. Every byte-for-byte Fortran comparison test
  continues to pass.
- **No required dependency.** Players on browsers without WebGPU, or
  those who turn the feature off, see exactly the existing game.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      User input: "slay the dang troll"            │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
                      ┌───────────────────┐
                      │  Existing parser  │
                      │    (parser.js)    │
                      └─────────┬─────────┘
                         accept │  reject
                        ┌───────┘  └───────────┐
                        ▼                      ▼
               ┌──────────────┐      ┌───────────────────────┐
               │  Game engine │      │  LLM fallback (opt-in) │
               │  (unchanged) │      │  — Web-LLM + Qwen 1.5B │
               └──────┬───────┘      └──────────┬────────────┘
                      ▼                         ▼
              Output to player           JSON: { command, conf, expl }
                                                ▼
                                     ┌────────────────────────┐
                                     │ "Did you mean          │
                                     │  ATTACK TROLL WITH     │
                                     │  SWORD? [Y/n/other]"   │
                                     └──────────┬─────────────┘
                                        accept  │  reject
                                     ┌──────────┘  └────────┐
                                     ▼                       ▼
                               Canonical cmd →          Return control
                               parser (must accept)     to input prompt
                                     ▼
                               Game engine
```

### Flow in more detail

1. Player submits input `S`.
2. `parser.js` attempts to parse `S`. If it returns `prswon === true`,
   the normal turn proceeds; the LLM is never called.
3. If the parser fails, the game normally prints a rejection message
   ("I don't understand…"). Suppress that message when the LLM
   fallback is active.
4. Construct an LLM prompt from:
   - The Dungeon vocabulary summary (~600 words, ~200 lines fits in
     the prompt comfortably)
   - Syntax rules (verb + object + `with` instrument; directions;
     `tell actor "..."`; `answer "..."`; etc.)
   - The current room's short description
   - Player's inventory (`odesc2` of each held object)
   - Last 2–3 accepted commands, so pronouns resolve
   - The rejected input `S`
5. Web-LLM runs the 1.5B model with this prompt. Expected latency:
   300–900 ms on an M2 Air.
6. Parse the JSON response. Expected fields:
   ```json
   {
     "command": "ATTACK TROLL WITH SWORD",
     "confidence": 0.93,
     "explanation": "The player said 'slay the dang troll'; 'dang' is
                     filler, 'slay' maps to ATTACK, 'the troll' is the
                     only troll in the current room."
   }
   ```
7. If `confidence ≥ 0.70` and the command passes a quick parser
   validation (it's not malformed), present it to the player:
   `"Did you mean: attack troll with sword? [Y/n/edit]"`.
   - `Y` or Enter: submit as the player's command for this turn.
   - `N`: drop the suggestion, original rejection message shown.
   - Edit: user types a corrected command.
8. If `confidence < 0.70` or parser rejects the suggestion, show the
   original parser rejection.

### Why "fallback" not "preprocessor"

A preprocessor approach (LLM translates *every* command) would be
cleaner to describe but has three failure modes:

1. **Latency.** Every turn adds 500ms, destroying the game's snappy
   feel.
2. **Drift.** The LLM occasionally mangles canonical commands that
   already work (e.g., rewriting `go north` as `move north`, which
   the parser doesn't recognize).
3. **Parity.** If the LLM is in the critical path, every parity test
   has to mock the LLM or accept non-determinism. Fallback mode
   keeps the LLM entirely out of the parity test path.

The fallback approach hits 90% of commands with zero overhead and
only invokes the LLM on the long tail of rejected input. This is
also where the LLM's value is highest — translating *unfamiliar
phrasing* — so it's a near-perfect match between cost profile and
feature value.

---

## 4. Runtime: Web-LLM + Qwen2.5-1.5B-Instruct

### Why Qwen2.5-1.5B-Instruct?

- **Size**: ~0.95 GB quantized (q4f16_1). Downloads in 30–90 seconds on
  home broadband. Fits comfortably in an 8 GB MacBook Air's browser
  GPU budget.
- **Quality**: Sufficient for closed-vocabulary translation. The task
  is simple pattern matching ("free-form English → one of ~50
  canonical verb forms"). We don't need reasoning.
- **Speed**: ~30–60 tokens/sec on an M-series Air. Our typical response
  is 30–80 tokens (JSON with short command + one-sentence
  explanation) → 0.5–2 seconds per inference.
- **Instruction-tuned**: Qwen2.5 responds to JSON-output requests
  reliably without extensive prompt engineering. Other 1.5B-class
  options (SmolLM2-1.7B, Phi-3.5-mini at 3.8B) are comparable in
  quality; Qwen2.5 has a small edge on structured output.
- **Available in MLC format**: `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`
  is an official release at
  [huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC](https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC),
  tested as part of WebLLM's official model zoo.

### Alternatives considered

| Model | Size | Why not |
|:---|:---|:---|
| SmolLM2-1.7B-Instruct | 1.0 GB | Slightly weaker at structured JSON output |
| Phi-3.5-mini-instruct | 2.3 GB | Overkill; doubles the download for marginal gain |
| Llama-3.2-1B-Instruct | 0.8 GB | Close runner-up; slightly weaker at closed-vocabulary constraints |
| Llama-3.2-3B-Instruct | 2.0 GB | Much better reasoning we don't need; 2× the download |

### Web-LLM integration

Web-LLM is imported as an ES module. The engine instance exposes
`CreateMLCEngine(modelId, options)` which returns an async handle with
an OpenAI-compatible `chat.completions.create()` API:

```js
import { CreateMLCEngine } from "@mlc-ai/web-llm";

const engine = await CreateMLCEngine(
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
  { initProgressCallback: (r) => updateLoadingUI(r) }
);

const reply = await engine.chat.completions.create({
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: userPromptFromGameState(state, rejectedInput) },
  ],
  response_format: {
    type: "grammar",
    grammar: GRAMMAR_EBNF,   // see §5.5 Constrained decoding
  },
  temperature: 0.1,
  max_tokens: 200,
});
```

Web-LLM runs inside a Web Worker by default in recent versions,
isolating the GPU-heavy inference from the UI thread. The initial
model download and WGSL kernel compile take 30–120 seconds on first
load, then are cached in the browser's cache storage; subsequent page
loads initialize in 2–5 seconds.

---

## 5. Prompt design

### System prompt (≈600 tokens)

The system prompt is a fixed constant loaded once at engine init.
Outline:

```
You are a command translator for the 1980 MIT Dungeon text adventure
game. Your job is to convert natural-language commands into the
game's canonical vocabulary. You never play the game; you only
translate.

GRAMMAR RULES:
- Commands are VERB [OBJECT] [WITH INSTRUMENT], or a direction.
- Directions are NORTH, SOUTH, EAST, WEST, NE, NW, SE, SW, UP, DOWN,
  IN, OUT (or abbreviations N/S/E/W/NE/NW/SE/SW/U/D).
- Verbs that accept objects: TAKE, DROP, OPEN, CLOSE, EXAMINE, LOOK
  AT, LOOK IN, READ, MOVE, PUSH, PULL, TURN, TURN ON, TURN OFF,
  LIGHT, EXTINGUISH, EAT, DRINK, BREAK, BURN, CUT, TIE, UNTIE, ...
- Combat verbs are ATTACK, KILL, SLAY, STAB, DISPATCH, HIT (all
  equivalent); they take an object and optionally WITH <weapon>.
- Special verbs: TELL <actor> "<command>", ANSWER "<word>",
  WAIT, AGAIN (G), LOOK (L), INVENTORY (I), SCORE, DIAGNOSE.
- Collective nouns: ALL, EVERYTHING, VALUABLES, POSSESSIONS, with
  optional EXCEPT clause.
- The parser recognizes only the first 8 letters of each word.

STYLE:
- Prefer the shortest canonical form.
- Drop articles ("the", "a") and filler words ("just", "please",
  "dang").
- Resolve pronouns from the recent command history.
- If an object name is ambiguous, pick the one in the current room
  or the player's inventory.

OUTPUT:
Always respond with a JSON object:
{
  "command": "CANONICAL COMMAND",
  "confidence": 0.0-1.0,
  "explanation": "One sentence about why."
}

If you cannot translate, return confidence 0.0 and a brief
explanation of why.
```

### Per-turn user prompt

Built by `llm/prompt.js` from current game state:

```
ROOM: Troll Room. A small room with passages off in all directions.
      Bloodstains and deep scratches (perhaps made by an axe) mar
      the walls. A nasty-looking troll, brandishing a bloody axe,
      blocks all passages out of the room.

INVENTORY: brass lantern (on), elvish sword, glass bottle (water),
           welcome mat.

RECENT COMMANDS: "go down", "go east", "look".

PLAYER TRIED: "slay the dang troll"

Translate.
```

### Expected output

```json
{
  "command": "SLAY TROLL WITH SWORD",
  "confidence": 0.94,
  "explanation": "SLAY is a canonical combat synonym. TROLL is the
                  villain in the current room. WITH SWORD is implied
                  by the weapon in inventory."
}
```

### 5.5 Constrained decoding (EBNF grammar)

A free-form LLM — even one prompted carefully — will occasionally
drift: lowercase commands, extra articles ("take *the* sword"),
invented verbs ("zap monster"), or stray prose outside the JSON
envelope. Qwen2.5-1.5B is particularly susceptible given its size.
To eliminate this class of error we use **grammar-constrained
decoding** via Web-LLM's supported `response_format` modes, which
internally use [XGrammar](https://github.com/mlc-ai/xgrammar) to mask
the token-level logits at each decoding step so the model can only
emit continuations compatible with a supplied EBNF grammar.

The effect is striking for a small model. Without constraints,
Qwen2.5-1.5B produces a valid parseable command maybe 70–80% of the
time. With a grammar, it's 100% by construction — the only question
is *which* valid command, which is the question the model is actually
good at answering. It's equivalent to moving up two model tiers for
this specific task at zero additional runtime cost.

**The grammar has two layers:**

- **Static layer.** A full grammar covering Dungeon's command
  syntax — all verbs, all nouns, all adjectives, all directions, plus
  the structural rules (`VERB [OBJ] [PREP OBJ]`, `TELL actor "…"`,
  `ANSWER "…"`, collective nouns, etc.). Auto-generated from
  `parser.js` by `dungeon/llm/generate-grammar.mjs`, so it can't
  drift from the parser's actual vocabulary. Lives at
  `dungeon/llm/grammar.ebnf` (~70 lines, ~700 terminal strings).

- **Contextual overlay (optional).** A per-turn narrowing of the
  `noun` nonterminal to just objects the player has seen or is
  carrying. Recompiled each turn from `G.oflag1[i] & VISIBT`;
  XGrammar compilation is fast (<10ms) and cacheable by inventory
  hash. The overlay is off by default for the first release, because
  it occasionally over-constrains (a player might want to say "take
  the key" even if the key is in another room the player remembers),
  but it's available behind a `strict_context=true` flag for players
  who want zero hallucination.

**Grammar regeneration pipeline:**

```
dungeon/js/parser.js
     │  (word tables: BWORD, PWORD, DWORD, AWORD, OWORD, VWORD)
     ▼
dungeon/llm/extract-vocabulary.mjs
     │
     ▼
dungeon/llm/vocabulary.json
     │
     ▼
dungeon/llm/generate-grammar.mjs
     │
     ▼
dungeon/llm/grammar.ebnf  ←  loaded at LLM init
```

Both scripts are idempotent; running them after any `parser.js`
vocabulary change regenerates the grammar automatically. A CI check
could verify that `vocabulary.json` and `grammar.ebnf` are up to date
with `parser.js` before merging changes.

**JSON envelope.** The grammar constrains the full JSON object, not
just the command:

```ebnf
root ::= "{" ws
           "\"command\"" ws ":" ws "\"" command "\"" ws "," ws
           "\"confidence\"" ws ":" ws confidence ws "," ws
           "\"explanation\"" ws ":" ws explanation ws
         "}"

command ::= meta | movement | tell | answer | incant | action
...
```

The `confidence` field is constrained to `[0, 1]` at one decimal place;
`explanation` is a free-form short string; and `command` itself is
constrained to the Dungeon syntax. The LLM cannot return malformed
JSON, cannot invent a verb, cannot omit a required field. Every
response parses cleanly into our structured type.

**Calling Web-LLM with a grammar:**

```js
const reply = await engine.chat.completions.create({
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: userPromptFromGameState(state, rejectedInput) },
  ],
  response_format: {
    type: "grammar",
    grammar: GRAMMAR_EBNF,   // loaded from grammar.ebnf at startup
  },
  temperature: 0.1,
  max_tokens: 200,
});
```

**What this does NOT guarantee:**

The grammar enforces syntactic validity. It does not enforce
*semantic* validity. The LLM can still say `TAKE KEY` in a room
with no key — the parser will reject it on round-trip, and we'll
show the original rejection message. This is a feature, not a bug:
we want to preserve the real parser's authority over game state.
The LLM's job is to translate English into the dialect, not to
know what's in the room.

**What happens if the model fights the grammar:**

If the LLM's preferred continuation is incompatible with the grammar
(e.g., wants to lowercase), XGrammar masks out those tokens and the
model picks its highest-probability grammar-compatible alternative.
If the grammar is too restrictive for the input (e.g., input is
genuinely nonsense), the model is forced to emit *some* command, but
it can signal that via a low `confidence`. Our confidence threshold
(≥0.70) does the rest.

---

## 6. Integration points in the codebase

### 6.1 `parser.js` — unchanged

The existing `rdline()` and `parse()` functions are untouched. Parity
tests continue to run as-is.

### 6.2 `game.js` — one branch point

Current command processing (approximate):

```js
G.prswon = parse(G, G.inbuf, G.inlnt, true);
if (!G.prswon) {
  xendmv(G);         // parser rejection message already printed
  continue;
}
```

New version:

```js
G.prswon = parse(G, G.inbuf, G.inlnt, true);
if (!G.prswon && G.llmFallback) {
  const suggestion = await G.llmFallback.translate(G, G.inbuf);
  if (suggestion && suggestion.confidence >= 0.70) {
    const ok = await G.ui.confirmSuggestion(suggestion);
    if (ok) {
      G.inbuf = suggestion.command.toUpperCase();
      G.inlnt = G.inbuf.length;
      G.prswon = parse(G, G.inbuf, G.inlnt, true);
    }
  }
}
if (!G.prswon) {
  xendmv(G);
  continue;
}
```

`G.llmFallback` is a reference to a singleton LLM service. `G.ui`
is the shell's input/display handle, extended with
`confirmSuggestion(s)` (renders `"Did you mean X? [Y/n/edit]"`). Both
default to `null`; if either is `null`, behavior reverts to the
existing parser-only flow.

Parity tests run with both set to `null`, so the code path they
exercise is unchanged.

### 6.3 New files

- `dungeon/llm/llm-fallback.js` — the main module: loads Web-LLM,
  holds the engine handle, exposes `translate(G, inbuf)`.
- `dungeon/llm/prompt.js` — `buildUserPrompt(G, inbuf)` and
  `SYSTEM_PROMPT` constants.
- `dungeon/llm/ui.js` — renders the suggestion confirmation in the
  shell/terminal, handles `Y/n/edit` input.
- `dungeon/llm/extract-vocabulary.mjs` — build-time script: reads
  `parser.js` and emits `vocabulary.json` (buzzwords, prepositions,
  directions, adjectives, nouns, verbs, meta-verbs).
- `dungeon/llm/generate-grammar.mjs` — build-time script: reads
  `vocabulary.json` and emits `grammar.ebnf` (EBNF grammar for
  XGrammar-constrained decoding).
- `dungeon/llm/vocabulary.json` — generated; committed to the repo
  for transparency.
- `dungeon/llm/grammar.ebnf` — generated; committed to the repo.
  Loaded at LLM init time as a text asset.

### 6.4 Opt-in toggle

The feature is off by default for the first release. Enable via:

- Shell command: `dungeon --llm-parser` (opt-in)
- Or a URL parameter: `?llmParser=1` on the dungeon page
- Or a shell env var: `DUNGEON_LLM_PARSER=1`

Once stable, consider flipping to on-by-default with a command to
disable it (`dungeon --no-llm-parser`).

---

## 7. UX considerations

### 7.1 First-run model download

Downloading a 1 GB model is a noticeable event. On the first
invocation of a fallback, we show:

```
> slay the dang troll
I don't understand "dang". Fetching a smarter parser (~1 GB, one-time
download). You can continue playing; this will take ~1 minute.

[████████████░░░░] 78%
```

The download is progressive (Web-LLM reports per-file progress). The
game is fully playable during the download; the fallback simply
isn't active yet. Once ready, we announce:

```
The smarter parser is ready. I'll re-try your last command.
```

### 7.2 Suggestion confirmation

Three options per suggestion:

- **Enter** (or `y`): accept, submit as the real command.
- **`n`**: reject, original rejection message shown, back to prompt.
- **`e`**: edit — pre-fills the input box with the suggestion, cursor
  at the end, so the player can tweak.

### 7.3 Subtle rewriting indicator

In the scrollback, the accepted suggestion is rendered in italics to
distinguish it from player-typed commands:

```
> slay the dang troll
[did you mean: *attack troll with sword*? y]
The troll takes a final blow and slumps to the floor dead.
```

This builds the player's intuition for the canonical dialect without
shaming them.

### 7.4 Low-confidence handling

If the LLM returns confidence < 0.70, don't present a suggestion —
show the standard parser rejection. Silent refusal is better than an
unhelpful guess.

---

## 8. Performance budget

| Stage | Target | Notes |
|:---|:---|:---|
| First-page load (feature dormant) | +0 KB parse, +0 ms boot | Web-LLM lazy-loaded |
| First fallback invocation | 30–120 s | Initial model download + WGSL compile; one-time |
| Subsequent page loads | +2–5 s init | Cached model + kernels |
| Per-fallback inference | 0.5–2 s | 30–80 tokens output, Qwen1.5B at 30–60 tok/s |
| RAM / GPU memory | ~1.5 GB | Model weights + KV cache |
| Parser-accepted command | 0 ms overhead | LLM never invoked |

The hard constraint: **parser-accepted commands must see zero
additional latency**, because those are the common case. The fallback
only touches the uncommon-case input.

---

## 9. Testing strategy

### 9.1 Unit tests for the prompt builder

- `buildUserPrompt(state)` produces a string with expected sections.
- `parseResponse(json)` tolerates minor LLM formatting quirks.
- Vocabulary and syntax rules in the prompt are in sync with the
  actual parser (periodically validated by diffing generated
  vocabulary against `parser.js`).

### 9.2 Integration tests with a canned LLM

For deterministic tests, the `G.llmFallback` object accepts a stub
implementation. A fixture-based test runs through ~20 player-typed
variants of common commands ("slay the troll", "kill it with the
blade", "kill troll") and asserts the stub would return the expected
canonical command. These are prompt quality tests, not LLM-runtime
tests.

### 9.3 Parity tests untouched

`test/sessions/*.input` files and the Fortran-comparison harness
neither set nor invoke `G.llmFallback`. All existing parity tests
continue to pass without modification.

### 9.4 Manual / live-LLM tests

A small human-tested suite of ~100 varied natural-language commands,
run against the live Qwen1.5B model, checking that:

- Common rephrasings succeed at confidence ≥ 0.85.
- Clearly-in-scope but unusual phrasings succeed at ≥ 0.70.
- Out-of-scope or nonsensical inputs are rejected (confidence < 0.70
  or malformed output).
- Latency stays under the 2s budget on a reference MacBook Air.

---

## 10. Privacy

Everything runs in the browser. No server, no API key, no telemetry.
The model weights are served by the MLC HuggingFace mirror the first
time; after that, they live in the browser's cache storage and are
fetched locally. No command data leaves the device.

A privacy note is shown on first feature activation:

> This feature uses a language model that runs entirely in your
> browser. No text you type is sent to any server, ever.

---

## 11. Fallback to non-WebGPU

If the browser lacks WebGPU (older Safari, some mobile), Web-LLM
refuses to initialize. In that case:

- The feature is hidden from the UI.
- The game falls back to the existing parser-only flow.
- A diagnostic message (in the settings panel, not gameplay log)
  explains what WebGPU is and which browsers support it.

Chrome 113+, Edge 113+, Safari 18+ (Tahoe, macOS 14+ Sequoia), and
Firefox Nightly with `dom.webgpu.enabled` are the supported
environments.

---

## 12. Rollout plan

### Phase 1 — Prototype
- Web-LLM integration via npm dependency.
- Qwen2.5-1.5B-Instruct model tested in a standalone page.
- Hand-written prompts, ~30 manual test cases.

### Phase 2 — Shell integration
- `G.llmFallback` wired into `game.js` behind opt-in flag.
- UI for download progress and suggestion confirmation.
- Opt-in via URL parameter.

### Phase 3 — Public beta
- Announce in the dungeon launch page as "Try the Oracle parser."
- Collect feedback on which natural-language phrases are rejected.

### Phase 4 — Calibration
- Fine-tune prompts based on real-user data.
- Consider fine-tuning a small model on canonical↔natural pairs.
- Evaluate whether to flip to on-by-default.

### Phase 5 — Future work
- **Oracle NPC**: a persistent in-game character that answers
  plain-language questions about the world, independent of the
  command parser.
- **Multi-action commands**: "kill the troll and go north" → two
  commands, executed sequentially.
- **Hint-on-demand**: `?` types a gentle hint from the LLM about the
  current situation, tiered like the hint book in Volume I.

---

## 13. Open questions

1. **Where does the model live?** Default: the MLC HuggingFace mirror.
   Alternative: self-host on the mazesofmenace.net CDN (requires ~1
   GB / 20 files served, but gives full offline control).
2. **How does the player discover the feature exists?** On first
   parser rejection that the LLM can translate, we could proactively
   offer: "Would you like to enable the Oracle parser? It helps with
   natural-language commands."
3. **Does the Oracle parser ever see in-game text?** Currently no.
   But we could enrich the prompt with recent game output for
   context (to handle "examine it").
4. **Should the confidence threshold be tunable per player?** A
   purist might set it to 1.0 (never accept LLM suggestions
   silently); a frustrated new player might want 0.5.
5. **Internationalization?** Qwen2.5 speaks many languages. The
   game's parser does not. A French player could type `tue le troll`
   and get `ATTACK TROLL WITH SWORD`. Tempting but probably best
   deferred.

---

## 14. Risks and mitigations

| Risk | Mitigation |
|:---|:---|
| LLM rewrites a command the parser accepted | Only invoke LLM on parser rejection |
| LLM suggests a non-canonical command that parser still rejects | Validate the suggestion through the parser before showing; drop if invalid |
| Model download fails or is slow | Feature is lazy; game plays without it |
| LLM invents an object that isn't in the room | Room description + inventory in prompt; explicit "if unsure, say confidence 0.0" instruction |
| Browser without WebGPU | Graceful fall-through to parser-only |
| Model weights update breaks prompts | Pin model ID to a specific version; update deliberately |
| Parity test regression | LLM path is off during parity tests; architectural invariant |

---

## 15. References

- Web-LLM project: <https://webllm.mlc.ai/>
- Web-LLM source: <https://github.com/mlc-ai/web-llm>
- Qwen2.5 paper: <https://arxiv.org/abs/2412.15115>
- MLC model zoo: <https://huggingface.co/mlc-ai>
- Qwen2.5-1.5B-Instruct-q4f16_1-MLC:
  <https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC>
- Dungeon's 1994 HELP text: `dungeon/docs/dungeon.txt`, sections
  on the parser ("moderately stupid") and vocabulary
- This project's parser implementation: `dungeon/js/parser.js`

---

*First draft. Comments and rewrites welcome.*
