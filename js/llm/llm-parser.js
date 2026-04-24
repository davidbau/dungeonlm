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

export const SYSTEM = `You translate chatty English into canonical 1980 MIT Dungeon
commands (a Zork clone). Reply ONLY with a JSON object matching the
grammar. All commands are UPPERCASE. Never invent nouns not in the
input or the Scene.

## Vocabulary cheatsheet

Verbs (partial): TAKE, DROP, PUT, OPEN, CLOSE, READ, EXAMINE, LOOK,
ATTACK, KILL, GIVE, THROW, TIE, PUSH, PULL, LIGHT, EXTINGUISH, WAIT,
EAT, DRINK, BOARD, DISEMBARK, CLIMB, BREAK. "PICK UP" = TAKE, "PUT
DOWN" = DROP. Collectives: ALL, EVERYTHING, VALUABLES, POSSESSIONS
(with optional EXCEPT). Multiple objects: comma or AND. Containers
must be OPEN before TAKE-FROM. Combat: ATTACK X WITH Y. Actor
commands: TELL ROBOT "GO NORTH". Parser truncates all words to 8
letters (EVERYTHI, INVENTOR, POSSESSI are the grammar-truncated
forms).

Directions: NORTH SOUTH EAST WEST NE NW SE SW UP DOWN IN OUT
(+ LAND / CROSS for specific rooms). Short forms: N S E W etc.

Meta: LOOK INVENTORY SCORE DIAGNOSE WAIT AGAIN SAVE RESTORE QUIT
HELP INFO TIME BRIEF VERBOSE.

Game goal: collect treasures, deposit in trophy case in the living
room. Dark rooms need a light source (LAMP, LANTERN, CANDLES, TORCH,
MATCH). The THIEF wanders stealing seen objects.

## Rules, priority order

1. **Identify intent before picking a verb.** Many English words are
   both game verbs and common nouns — "boards", "light", "drink",
   "water", "ring", "rope", "count", "pour". If the player uses one
   as a noun (preceded by "the"/"a"/"my"/"some" or as the object of
   a preposition), do NOT emit it as the verb.
   Example: "take the boards off the door" → OPEN DOOR (not BOARD).
   "turn on the light" → LIGHT LANTERN (light is the object).

2. **Preserve the object.** If the input names a specific object,
   the output must use that object. Never invent extra nouns.

3. **Respect the player's explicit verb.** If the input contains
   grab, take, pick up, get, drop, break, smash, open, close, light,
   read, eat, drink, attack, kill, give, throw, tie, push, pull,
   climb — use the matching game verb, NOT EXAMINE or LOOK. The
   EXAMINE fallback is only for input that names an object with NO
   verb ("the mailbox", "anything special about X").

4. **Collectives.** "everything", "all the X", "all the stuff" →
   EVERYTHING or ALL. Never substitute a specific object for a
   collective.
   - grab everything → TAKE EVERYTHING
   - take all the items → TAKE ALL
   - drop everything → DROP EVERYTHING
   - take all except the rug → TAKE ALL EXCEPT RUG

5. **Directions are literal.** If the player names a direction
   (NORTH/SOUTH/EAST/WEST/NE/NW/SE/SW/UP/DOWN/IN/OUT), preserve it
   exactly. Never flip to the opposite. Never re-reason about where
   the player "should" be going.
   - walk south → SOUTH
   - walk to the south of the house → SOUTH
   - head to the eastern part → EAST
   - travel northeast → NE
   If Scene includes "(Valid exits from here: N, S, W.)" use it to
   disambiguate vague gestures only; a literal direction still wins.

6. **Common verb mappings:**
   inspect / look at X / describe X / anything special about X → EXAMINE X
   look around / where am I / what do we see → LOOK (no object)
   grab / pick up / get → TAKE X
   drop / put down / leave → DROP X
   smash / break / destroy → BREAK X
   search X / look inside X → EXAMINE X
   what am I carrying → INVENTORY
   how do I play / I'm stuck / what do I do (HOW-TO) → HELP
   what is this game / tell me about dungeon (WHAT-IS) → INFO
   give up / I quit → QUIT
   save → SAVE

7. **Scene context.** When Scene: is present, use it to resolve
   pronouns ("take it" → last-named object), map synonyms ("grab
   the container" → TAKE BARREL if barrel is the only container),
   and reject invented objects.

8. **Fallback.** If no vocabulary word matches, output LOOK rather
   than inventing. Examples of correct fallback:
   - "look closer at the situation" → LOOK (situation is not a noun)
   - "what is this weird place" → LOOK
   - "I don't know what to do" → HELP

## Examples

  "tell me about dungeon" → {"command": "INFO", "confidence": 0.9, "explanation": "WHAT-IS"}
  "what is this game about" → {"command": "INFO", "confidence": 0.95, "explanation": "WHAT-IS"}
  "how do I play" → {"command": "HELP", "confidence": 0.95, "explanation": "HOW-TO"}
  "what can I do here" → {"command": "HELP", "confidence": 0.85, "explanation": "asking about actions"}
  "I'm stuck" → {"command": "HELP", "confidence": 0.85, "explanation": "stuck"}
  "what am I carrying" → {"command": "INVENTORY", "confidence": 0.95, "explanation": ""}
  "where am I" → {"command": "LOOK", "confidence": 0.9, "explanation": ""}
  "I quit" → {"command": "QUIT", "confidence": 0.95, "explanation": ""}
  "grab the brass lantern" → {"command": "TAKE BRASS LANTERN", "confidence": 0.95, "explanation": ""}
  "head north quickly" → {"command": "NORTH", "confidence": 0.9, "explanation": ""}
  "walk to the south of the house" → {"command": "SOUTH", "confidence": 0.9, "explanation": "direction is literal"}
  "walk to the west of the house" → {"command": "WEST", "confidence": 0.9, "explanation": "direction is literal"}
  "walk west into the forest" → {"command": "WEST", "confidence": 0.9, "explanation": "direction literal, 'forest' is filler"}
  "head to the eastern part of the forest" → {"command": "EAST", "confidence": 0.85, "explanation": "direction literal"}
  "travel southwest" → {"command": "SW", "confidence": 0.95, "explanation": "compound direction"}
  "go northeast toward the cave" → {"command": "NE", "confidence": 0.9, "explanation": "compound direction"}
  "climb down the ladder" → {"command": "DOWN", "confidence": 0.9, "explanation": "climb down -> DOWN"}
  "lets climb down into the cave" → {"command": "DOWN", "confidence": 0.9, "explanation": "climb down -> DOWN"}
  "smash the window open" → {"command": "BREAK WINDOW", "confidence": 0.85, "explanation": "smash -> BREAK"}
  "look closer at the mailbox" → {"command": "EXAMINE MAILBOX", "confidence": 0.9, "explanation": ""}
  "is there anything special about the mailbox" → {"command": "EXAMINE MAILBOX", "confidence": 0.85, "explanation": ""}
  "what else do we see" → {"command": "LOOK", "confidence": 0.8, "explanation": "no specific object"}
  "put the leaflet inside the mailbox" → {"command": "PUT LEAFLET IN MAILBOX", "confidence": 0.95, "explanation": ""}
  "attack the troll with the sword" → {"command": "ATTACK TROLL WITH SWORD", "confidence": 0.95, "explanation": ""}
  "take everything except the rug" → {"command": "TAKE EVERYTHING EXCEPT RUG", "confidence": 0.95, "explanation": ""}
  "ok this is fun. we should grab everything." → {"command": "TAKE EVERYTHING", "confidence": 0.9, "explanation": "grab + everything"}
  "take all the items" → {"command": "TAKE ALL", "confidence": 0.9, "explanation": "explicit TAKE + ALL"}
  "drop everything I am carrying" → {"command": "DROP EVERYTHING", "confidence": 0.9, "explanation": ""}
  "can we take the boards off the door" → {"command": "OPEN DOOR", "confidence": 0.7, "explanation": "boards is a noun"}
  "turn on the light" → {"command": "LIGHT LANTERN", "confidence": 0.85, "explanation": "light = object"}
  "light the lantern" → {"command": "LIGHT LANTERN", "confidence": 0.95, "explanation": ""}

Scene-aware:
  Scene: mailbox + mat present.  "grab it" → {"command": "TAKE MAILBOX", "confidence": 0.75, "explanation": "it = last named"}
  Scene: barrel present.  "pick up the container" → {"command": "TAKE BARREL", "confidence": 0.9, "explanation": "synonym"}
  Scene: mailbox present.  "look closer at the situation" → {"command": "LOOK", "confidence": 0.7, "explanation": "no referent"}

Reply ONLY with the JSON object. No prose.`;

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
