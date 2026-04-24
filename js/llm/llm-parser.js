// LLM parser fallback runtime.
//
// Translates natural-language input into a canonical Dungeon command when
// the classic parser rejects the user's input. The LLM is never in the
// critical path — it only runs after a parse failure.
//
// This file is a scaffold: it loads the Web-LLM engine on demand and
// exposes `translate(raw)` returning `{ command, confidence, explanation }`
// or null. See docs/LLM_PARSER_DESIGN.md for architecture.

let enginePromise = null;
let grammarPromise = null;

async function loadGrammar() {
    if (!grammarPromise) {
        grammarPromise = fetch('./js/llm/grammar.ebnf').then(r => {
            if (!r.ok) throw new Error(`grammar.ebnf fetch failed: ${r.status}`);
            return r.text();
        });
    }
    return grammarPromise;
}

async function loadEngine(onProgress) {
    if (enginePromise) return enginePromise;
    enginePromise = (async () => {
        const { CreateMLCEngine } = await import(
            'https://esm.run/@mlc-ai/web-llm@0.2.82'
        );
        return CreateMLCEngine(
            'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
            {
                initProgressCallback: (p) => {
                    if (onProgress) onProgress(p);
                },
            },
        );
    })();
    return enginePromise;
}

export function isReady() {
    return !!enginePromise;
}

export async function prepare(onProgress) {
    await Promise.all([loadGrammar(), loadEngine(onProgress)]);
}

const SYSTEM = `You are a parser adapter for the 1980 MIT Dungeon game (a Zork clone).
The player typed English that the strict classic parser could not understand.
Translate it into a single canonical Dungeon command that the classic parser
would accept. Canonical commands are UPPERCASE and use only the grammar's
vocabulary.

CRITICAL RULES:
1. ALWAYS preserve the specific object the player mentioned. Never collapse
   "examine the mailbox" into bare "LOOK" — use EXAMINE MAILBOX.
2. Prefer the MOST SPECIFIC verb that matches the intent:
   - "inspect", "look at", "look closer", "look closely", "anything special",
     "what is", "describe" → EXAMINE <object>
   - "look around", "what do we see", "what else is here" → LOOK
   - "grab", "pick up", "get" → TAKE <object>
   - "smash", "break", "destroy" → BREAK <object>
   - "head north", "go north", "move north" → NORTH
3. If the player asks a question like "is there X" or "what about Y",
   treat it as the closest imperative: usually EXAMINE or LOOK.
4. Drop filler words: articles, politeness, adverbs. Keep the key noun.

Examples:

  "grab the brass lantern"
    -> {"command": "TAKE BRASS LANTERN", "confidence": 0.95, "explanation": "grab -> TAKE"}
  "head north quickly"
    -> {"command": "NORTH", "confidence": 0.9, "explanation": "head north -> NORTH"}
  "smash the window open"
    -> {"command": "BREAK WINDOW", "confidence": 0.85, "explanation": "smash -> BREAK"}
  "look closer at the mailbox"
    -> {"command": "EXAMINE MAILBOX", "confidence": 0.9, "explanation": "look closer -> EXAMINE, keep object"}
  "is there anything special about the mailbox"
    -> {"command": "EXAMINE MAILBOX", "confidence": 0.85, "explanation": "inspect question -> EXAMINE"}
  "what else do we see"
    -> {"command": "LOOK", "confidence": 0.8, "explanation": "general survey -> LOOK"}
  "please put the leaflet inside the mailbox"
    -> {"command": "PUT LEAFLET IN MAILBOX", "confidence": 0.9, "explanation": "verb + object + prep + object"}

If the intent is unclear, pick the most likely reading and lower confidence.
Reply ONLY with the JSON object. No prose.`;

export async function translate(raw, { context } = {}) {
    const [grammar, engine] = await Promise.all([loadGrammar(), loadEngine()]);
    const userMsg = context
        ? `Scene: ${context}\n\nPlayer input: ${raw}`
        : `Player input: ${raw}`;

    const response = await engine.chat.completions.create({
        messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: userMsg },
        ],
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'grammar', grammar },
    });

    const text = response.choices?.[0]?.message?.content ?? '';
    try {
        const obj = JSON.parse(text);
        if (typeof obj.command !== 'string') return null;
        return obj;
    } catch {
        return null;
    }
}
