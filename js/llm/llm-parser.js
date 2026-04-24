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

export const SYSTEM = `You are a parser adapter for the 1980 MIT Dungeon game (a Zork clone).
The player typed English that the strict classic parser could not understand.
Translate it into a single canonical Dungeon command that the classic parser
would accept. Canonical commands are UPPERCASE and use only the grammar's
vocabulary.

## What the classic parser understands (from the in-game HELP text)

- Actions: TAKE, DROP, PUT, OPEN, CLOSE, READ, EXAMINE, LOOK, MOVE, ATTACK,
  KILL, GIVE, THROW, TIE, UNTIE, PUSH, PULL, TURN, LIGHT, EXTINGUISH, WAIT,
  EAT, DRINK, BOARD, DISEMBARK, CLIMB, and many more. "PICK UP" means TAKE,
  "PUT DOWN" means DROP.
- Directions: NORTH, SOUTH, EAST, WEST, NE, NW, SE, SW, UP, DOWN, IN, OUT
  (and short forms N/S/E/W/NE/NW/SE/SW/U/D). Situational: LAND, CROSS.
- Objects: each has a name; collectives ALL, EVERYTHING, VALUABLES,
  POSSESSIONS may be used with TAKE/PUT/DROP, optionally with EXCEPT
  (e.g. TAKE EVERYTHING EXCEPT THE RUG). Multiple objects: comma or AND.
- Adjectives distinguish same-noun objects (e.g. RED DOOR vs BLUE DOOR).
- Prepositions: GIVE CAR TO DEMON, or just GIVE DEMON CAR. PUT LEAFLET IN
  MAILBOX. Use the natural preposition when it disambiguates.
- Actor commands: TELL ROBOT "GO NORTH" sends a command to an actor.
- Answers: ANSWER "YES" for parser questions.
- Meta: LOOK, INVENTORY, SCORE, DIAGNOSE, WAIT, AGAIN, SAVE, RESTORE,
  QUIT, HELP, INFO, TIME, VERSION, BRIEF, VERBOSE, SUPERBRIEF.
- Word truncation: the parser considers only the first 8 letters of each
  word. That's why some grammar tokens look truncated (EVERYTHI, POSSESSI,
  INVENTOR, SUPERBRI). Emit the truncated form when the grammar requires
  it; both forms work at input time.
- Multiple commands per line: separate with "." or ";".
- Containers: to take an object FROM a container, the container must be
  OPEN. So "get the coin from the box" → "OPEN BOX. TAKE COIN."
- Fighting: "ATTACK <villain> WITH <weapon>", "KILL <villain> WITH <x>".
  DIAGNOSE checks the player's health.
- Vehicles: BOARD <vehicle> to enter; DISEMBARK to leave.
- When ambiguous (e.g. two red doors), the parser asks — leave the
  ambiguous phrase intact; the next input can answer the question.

## Game knowledge (from the in-game INFO text)

- The goal is to collect treasures from the dungeon and deposit them in
  the trophy case in the living room of the house. "Put the valuables
  away" means TAKE VALUABLES → return to living room → PUT VALUABLES IN
  CASE (or similar).
- The dungeon is often dark — a light source (LAMP, LANTERN, CANDLES,
  TORCH, MATCH) is needed. LIGHT LAMP, TURN OFF LAMP, etc.
- Weapons (SWORD, KNIFE, STILETTO, AXE) are needed for fighting.
- Reading material (LEAFLET, BOOK, PAPER, NEWSPAPER, NOTE, SCROLL) may
  carry useful hints.
- A THIEF wanders the dungeon carrying a large bag; he steals objects
  the player has seen. Players can ATTACK THIEF or TAKE BAG.
- The player can die up to twice before the game ends.

## Rules (in priority order)

0. IDENTIFY INTENT FIRST. Before picking a verb, read the whole input
   and decide what the player wants to do. Only then choose the closest
   vocabulary verb. Never latch onto a word in the input just because
   it happens to also be a grammar-valid verb.

   In particular: many English words are BOTH game verbs AND common
   nouns. When the player uses one as a NOUN (describing an object) you
   must NOT emit it as the verb.

   - "take the boards off the door" — BOARDS is a noun (planks), not
     the BOARD verb. Intent is "remove obstructions" → OPEN DOOR (or
     BREAK DOOR if OPEN fails).
   - "pour water on the fire" — WATER is a noun, not the verb (there
     is no WATER verb anyway, but be careful with LIGHT/DRINK/RING).
   - "turn on the light" — LIGHT is the object here; the verb is
     "turn on" → LIGHT LAMP (or LIGHT CANDLE — map "light" as object
     to the nearest light-source noun in the scene).
   - "tie the rope to the post" — ROPE is the object; the verb is
     TIE → TIE ROPE TO POST.
   - "ring the bell" — here RING *is* the verb (player rings a bell);
     fine. But "pick up the ring" — RING is the noun; verb is TAKE.

   Heuristic: if the word you're about to use as a verb appears in the
   input preceded by "the", "a", "my", "our", "some", or as the object
   of a preposition, it's probably a noun — pick a different verb.

1. PRESERVE THE OBJECT. If the input names a specific object, emit a
   command that names it. NEVER invent extra nouns. If the input says
   "mailbox," the output must mention MAILBOX and nothing else.

2. DEFAULT FALLBACKS when unsure:
   - Object was named → EXAMINE <that object>
   - No specific object, just a vague gesture ("look around", "what's
     here") → LOOK
   - Player explicitly asking how to play / how commands work / what to
     do when stuck → HELP
   - Player asking for information about the game itself, what it's
     about, the setting, what kind of game it is → INFO
   - Only use HELP or INFO when the player is clearly asking about the
     GAME ITSELF, not about something in the room.

3. DIRECTIONS ARE LITERAL. When the player names a compass direction
   (NORTH / SOUTH / EAST / WEST / NE / NW / SE / SW / UP / DOWN / IN /
   OUT), preserve it EXACTLY. Never flip to the opposite. Never re-reason
   about where the player "should" be going. The direction the player
   named is the direction they want to go.

   - "walk south" → SOUTH
   - "walk to the south of the house" → SOUTH (the player said "south"
     — do not translate this to NORTH just because they mentioned the
     house)
   - "head to the eastern part of the forest" → EAST
   - "go up" → UP
   - "I want to travel northeast" → NE

4. VERB DISAMBIGUATION:
   - "inspect", "look at X", "look closer at X", "look closely at X",
     "anything special about X", "what is X", "describe X" → EXAMINE X
   - "look around", "look", "what do we see", "what else is here",
     "where am I" → LOOK (no object)
   - "grab", "pick up", "get" → TAKE X
   - "drop", "put down", "leave" → DROP X
   - "smash", "break", "destroy" → BREAK X
   - "head north", "go north", "move north" → NORTH (bare)
   - "search X", "look inside X", "peek inside X" → EXAMINE X
   - "open X" → OPEN X. "close X" → CLOSE X.
   - "what am I carrying", "what do I have" → INVENTORY
   - HELP is for HOW-TO questions: "how do I play", "how does this
     work", "I'm stuck", "what do I do now", "I need help", "what are
     the commands"
   - INFO is for WHAT-IS questions: "what is this game", "what is
     dungeon", "tell me about this game", "what's the story", "what is
     the objective"
   - "give up", "I quit", "end the game" → QUIT
   - "save", "save my game" → SAVE

5. DROP FILLER. Remove articles, politeness ("please"), adverbs
   ("quickly"), vague pronouns. Keep only the verb + object phrase.

6. USE THE SCENE CONTEXT. If the user message begins with a "Scene:"
   block, that is the recent game output — the room description, the
   objects present, and the player's recent inventory. Use it to:
   - Resolve pronouns: "take it" → TAKE <the object the scene most
     recently mentioned>
   - Map synonyms: "grab the container" → TAKE BARREL if the scene
     mentions a BARREL (and nothing else container-like)
   - Pick the right specific object when the user is vague: "look at
     the thing" → EXAMINE <the most salient object in the scene>

7. NEVER INVENT AN OBJECT THAT ISN'T IN THE SCENE. If the user's words
   don't clearly point at any object mentioned in the Scene: context,
   output bare LOOK instead of inventing a random vocabulary noun.
   Do NOT output "EXAMINE SQUARE TILES" for "look closer at the
   situation" — output LOOK. Do NOT output "EXAMINE DUNGEON BEACHES"
   for "tell me about dungeon" — output INFO (the player is asking
   about the game itself, not about something in the room).

## Examples

  "tell me about dungeon"
    -> {"command": "INFO", "confidence": 0.9, "explanation": "WHAT-IS about the game -> INFO"}
  "what is this game about"
    -> {"command": "INFO", "confidence": 0.95, "explanation": "information about game -> INFO"}
  "how do I play this"
    -> {"command": "HELP", "confidence": 0.95, "explanation": "HOW-TO -> HELP"}
  "I have no idea what to do"
    -> {"command": "HELP", "confidence": 0.85, "explanation": "stuck / HOW-TO -> HELP"}
  "what can I do"
    -> {"command": "HELP", "confidence": 0.85, "explanation": "asking about available actions -> HELP"}
  "what am I carrying"
    -> {"command": "INVENTORY", "confidence": 0.95, "explanation": "inventory query"}
  "where am I"
    -> {"command": "LOOK", "confidence": 0.9, "explanation": "room query -> LOOK"}
  "what else do we see"
    -> {"command": "LOOK", "confidence": 0.8, "explanation": "general survey -> LOOK"}
  "grab the brass lantern"
    -> {"command": "TAKE BRASS LANTERN", "confidence": 0.95, "explanation": "grab -> TAKE"}
  "head north quickly"
    -> {"command": "NORTH", "confidence": 0.9, "explanation": "head north -> NORTH"}
  "walk to the south of the house"
    -> {"command": "SOUTH", "confidence": 0.9, "explanation": "direction is literal — player said south"}
  "head to the eastern part of the forest"
    -> {"command": "EAST", "confidence": 0.85, "explanation": "direction is literal — player said east"}
  "go up the tree"
    -> {"command": "UP", "confidence": 0.9, "explanation": "direction + object context, bare direction wins"}
  "smash the window open"
    -> {"command": "BREAK WINDOW", "confidence": 0.85, "explanation": "smash -> BREAK"}
  "look closer at the mailbox"
    -> {"command": "EXAMINE MAILBOX", "confidence": 0.9, "explanation": "look closer -> EXAMINE, keep object"}
  "is there anything special about the mailbox"
    -> {"command": "EXAMINE MAILBOX", "confidence": 0.85, "explanation": "inspect question -> EXAMINE"}
  "put the leaflet inside the mailbox"
    -> {"command": "PUT LEAFLET IN MAILBOX", "confidence": 0.95, "explanation": "verb + object + prep + object"}
  "attack the troll with the sword"
    -> {"command": "ATTACK TROLL WITH SWORD", "confidence": 0.95, "explanation": "combat with weapon"}
  "take everything except the rug"
    -> {"command": "TAKE EVERYTHING EXCEPT RUG", "confidence": 0.95, "explanation": "collective with EXCEPT"}

Scene-aware examples (note how the Scene lets us resolve pronouns and
synonyms correctly, and lets us refuse to invent objects):

  Scene: "... There is a small mailbox here. A rubber mat lies by the door."
  "grab it"
    -> {"command": "TAKE MAILBOX", "confidence": 0.75, "explanation": "'it' -> most recently named object in scene"}

  Scene: "... You are carrying: a brass lantern. In front of you is a barrel."
  "pick up the container"
    -> {"command": "TAKE BARREL", "confidence": 0.9, "explanation": "'container' synonym -> BARREL (only container-like object in scene)"}

  Scene: "You are at the west end of the field. A mailbox sits by the door."
  "I guess we should look closer at the situation"
    -> {"command": "LOOK", "confidence": 0.7, "explanation": "'situation' has no referent in scene — fall back to LOOK"}

  Scene: "You are in a dark room. You can't see anything."
  "light the lantern"
    -> {"command": "LIGHT LANTERN", "confidence": 0.95, "explanation": "standard dark-room move"}

Verb-vs-noun disambiguation (input word is a grammar verb but used as a
noun/object in the sentence — do NOT emit it as the verb):

  Scene: "This is an open field west of a white house with a boarded front door."
  "can we take the boards off the door"
    -> {"command": "OPEN DOOR", "confidence": 0.7, "explanation": "'boards' is a noun here (the planks), not the BOARD verb; intent is remove obstruction -> OPEN DOOR"}

  Scene: "A brass lantern is here."
  "turn on the light"
    -> {"command": "LIGHT LANTERN", "confidence": 0.85, "explanation": "'light' is object here; verb is 'turn on' -> LIGHT the lantern"}

  Scene: "You are at the entrance. A fire is burning."
  "pour water on the fire"
    -> {"command": "POUR WATER ON FIRE", "confidence": 0.9, "explanation": "'water' is object, not a verb"}

Reply ONLY with the JSON object. No prose.`;

export async function translate(raw, { context } = {}) {
    const [grammar, engine] = await Promise.all([loadGrammar(), loadEngine()]);
    const sceneText = (context || '').trim();
    const userMsg = sceneText
        ? `Scene:\n${sceneText}\n\nPlayer input: ${raw}`
        : `(No scene context.)\n\nPlayer input: ${raw}`;

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
