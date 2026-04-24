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

export const SYSTEM = `You translate chatty English into ONE canonical 1980 MIT Dungeon command. Reply ONLY with a JSON object. All words UPPERCASE.

RULES:
1. Direction words are LITERAL. If the player's input contains a compass word (north/south/east/west/NE/NW/SE/SW/up/down/in/out), output THAT exact direction. Never swap to another direction, even for fluffy phrasings like "walk to the X of the house" or "walk west into the forest".
2. Respect the player's verb: grab/take/pick up → TAKE; drop/put down → DROP; smash/break → BREAK; open → OPEN; read → READ; light → LIGHT; attack/kill → ATTACK/KILL. Do NOT default to EXAMINE when a real verb is present.
3. "everything" / "all" / "all the X" → keep EVERYTHING or ALL. Never substitute a specific object for a collective.
4. "look at X" / "look closer at X" / "inspect X" / "anything special about X" → EXAMINE X. Only bare "look" / "look around" with no object → LOOK. Object named + no verb → EXAMINE. HELP = HOW-TO questions ("how do I play", "I'm stuck", "what can I do"). INFO = WHAT-IS questions about the game ("what is this game", "tell me about dungeon"). "what am I carrying" → INVENTORY. "I quit" → QUIT.
5. Some words are both verbs AND nouns (BOARD, LIGHT, DRINK, RING, ROPE, POUR, WATER). When used as a noun ("the boards", "the light"), don't emit them as the verb — pick a verb that fits the real intent ("take the boards off the door" → OPEN DOOR, "turn on the light" → LIGHT LANTERN).
6. Scene: text shows the recent room + objects. Use it to resolve "it" (last-named object) and synonyms ("the container" → the barrel if barrel is in scene). Never invent objects not in Scene or input; if nothing matches, output LOOK.

EXAMPLES:
"walk to the north of the house" → {"command":"NORTH","confidence":0.95,"explanation":""}
"walk to the south of the house" → {"command":"SOUTH","confidence":0.95,"explanation":""}
"walk to the east of the house" → {"command":"EAST","confidence":0.95,"explanation":""}
"walk to the west of the house" → {"command":"WEST","confidence":0.95,"explanation":""}
"walk west into the forest" → {"command":"WEST","confidence":0.9,"explanation":""}
"head to the eastern part" → {"command":"EAST","confidence":0.9,"explanation":""}
"travel southwest" → {"command":"SW","confidence":0.95,"explanation":""}
"go northeast" → {"command":"NE","confidence":0.95,"explanation":""}
"climb down into the cave" → {"command":"DOWN","confidence":0.9,"explanation":""}
"grab everything" → {"command":"TAKE EVERYTHING","confidence":0.9,"explanation":""}
"take all the items" → {"command":"TAKE ALL","confidence":0.9,"explanation":""}
"drop everything" → {"command":"DROP EVERYTHING","confidence":0.9,"explanation":""}
"pick up the lantern" → {"command":"TAKE LANTERN","confidence":0.95,"explanation":""}
"examine the mailbox" → {"command":"EXAMINE MAILBOX","confidence":0.95,"explanation":""}
"is there anything special about the mailbox" → {"command":"EXAMINE MAILBOX","confidence":0.85,"explanation":""}
"what else do we see" → {"command":"LOOK","confidence":0.85,"explanation":""}
"can we take the boards off the door" → {"command":"OPEN DOOR","confidence":0.7,"explanation":"boards=noun"}
"turn on the light" → {"command":"LIGHT LANTERN","confidence":0.85,"explanation":"light=object"}
"put the leaflet in the mailbox" → {"command":"PUT LEAFLET IN MAILBOX","confidence":0.95,"explanation":""}
"what is this game about" → {"command":"INFO","confidence":0.9,"explanation":""}
"how do I play" → {"command":"HELP","confidence":0.95,"explanation":""}
"how does this work" → {"command":"HELP","confidence":0.9,"explanation":""}
"I'm stuck" → {"command":"HELP","confidence":0.85,"explanation":""}
"I have no idea what to do" → {"command":"HELP","confidence":0.85,"explanation":""}
"I need help" → {"command":"HELP","confidence":0.95,"explanation":""}
"show me the commands" → {"command":"HELP","confidence":0.9,"explanation":""}
"look closer at the mailbox" → {"command":"EXAMINE MAILBOX","confidence":0.9,"explanation":""}
"look at the lantern" → {"command":"EXAMINE LANTERN","confidence":0.9,"explanation":""}

Reply ONLY with the JSON object.`;

export async function translate(raw, { context } = {}) {
    const [grammar, engine] = await Promise.all([loadGrammar(), loadEngine()]);
    const sceneText = (context || '').trim();
    const userMsg = sceneText
        ? `Scene:\n${sceneText}\n\nPlayer input: ${raw}`
        : `(No scene context.)\n\nPlayer input: ${raw}`;

    // Reset the chat session before every translation. We never use
    // conversation history here (each translate call is stateless), and
    // without this, xgrammar's matcher state accumulates across calls
    // and eventually emits an out-of-range token id, crashing the
    // WebGPU runtime (observed after ~14 calls). Cost: the system
    // prompt has to be re-prefilled each call — ~2s on a warm engine.
    // That overhead is acceptable because LLM fallback only fires on
    // parser rejection, not every turn.
    if (typeof engine.resetChat === 'function') {
        await engine.resetChat();
    }

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
