// dungeonlm — dungeon game + optional LLM parser fallback.
//
// Wire diagram:
//   Terminal ──input──> app ──(maybe)──> llm-parser ──> dungeon game
//                                                          │
//   Terminal <─────── output ──────────────────────────────┘
//
// The LLM is off by default. When the user toggles it on, app.js loads
// the Web-LLM engine in the background, then pre-translates any
// natural-language-looking input before forwarding to the game's parser.

import { Terminal } from './terminal.js';
import * as llm from './llm/llm-parser.js';

const DATA_URL = './game/dungeon-data.json';
const TEXT_URL = './game/dungeon-text.json';
const SAVE_KEY = 'dungeonlm.save';
const SAVE_WHEN_KEY = 'dungeonlm.save.when';
const LLM_TOGGLE_KEY = 'dungeonlm.llm.enabled';

const state = {
    llmEnabled: false,
    llmLoaded: false,
    loading: false,
};

// ---------------------------------------------------------------------------
// DOM wiring
// ---------------------------------------------------------------------------

const termEl = document.getElementById('terminal');
const statusEl = document.getElementById('status');
const toggle = document.getElementById('llm-toggle');
const progressEl = document.getElementById('llm-progress');

const terminal = new Terminal(termEl);

function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
}

function setProgress(text) {
    if (progressEl) progressEl.textContent = text || '';
}

// Default ON — dungeonlm is specifically the LLM-enhanced build. Users
// who don't want the ~1 GB model download can opt out via the checkbox,
// and that choice persists in localStorage.
const disabled = localStorage.getItem(LLM_TOGGLE_KEY) === '0';
toggle.checked = !disabled;
state.llmEnabled = !disabled;

toggle.addEventListener('change', async () => {
    state.llmEnabled = toggle.checked;
    localStorage.setItem(LLM_TOGGLE_KEY, toggle.checked ? '1' : '0');
    if (toggle.checked && !state.llmLoaded && !state.loading) {
        await ensureLlmLoaded();
    } else {
        setStatus(toggle.checked ? 'LLM parser: on' : 'LLM parser: off');
    }
});

function formatEta(seconds) {
    if (!isFinite(seconds) || seconds < 1) return '';
    if (seconds < 60) return `~${Math.round(seconds)}s remaining`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `~${m}m ${s}s remaining`;
}

function renderProgress(p, startMs) {
    const pct = (p.progress || 0) * 100;
    const elapsedSec = (performance.now() - startMs) / 1000;
    let eta = '';
    if (p.progress > 0.01) {
        const totalSec = elapsedSec / p.progress;
        eta = formatEta(totalSec - elapsedSec);
    }
    // Web-LLM's p.text already includes MB/percent/elapsed; append our ETA.
    const base = p.text || `${pct.toFixed(0)}%`;
    return eta ? `${base}  (${eta})` : base;
}

async function ensureLlmLoaded() {
    if (state.llmLoaded || state.loading) return;
    state.loading = true;
    // Auto-retry on transient Cache.add() failures — HuggingFace occasionally
    // returns a redirect or timeout on the first request from a fresh origin.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const prefix = attempt > 1 ? `(retry ${attempt}/${MAX_ATTEMPTS}) ` : '';
        setStatus(`${prefix}LLM parser: loading model (one-time ~1 GB download)…`);
        const startMs = performance.now();
        try {
            await llm.prepare((p) => setProgress(renderProgress(p, startMs)));
            state.llmLoaded = true;
            setStatus('LLM parser: ready');
            setProgress('');
            state.loading = false;
            return;
        } catch (e) {
            if (attempt < MAX_ATTEMPTS) {
                setStatus(`LLM parser: transient error, retrying… (${e.message})`);
                await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }
            setStatus(`LLM parser: load failed — ${e.message}`);
            toggle.checked = false;
            state.llmEnabled = false;
        }
    }
    state.loading = false;
}

// ---------------------------------------------------------------------------
// Input pre-translation
// ---------------------------------------------------------------------------

// Rough heuristic: if the input is short, uppercase, or looks like a
// canonical command (e.g., "TAKE LANTERN", "n", "look"), don't bother the
// LLM. Only translate multi-word inputs that contain likely non-vocabulary.
function looksLikeNaturalLanguage(line) {
    const s = line.trim();
    if (s.length === 0) return false;
    const words = s.split(/\s+/);
    if (words.length <= 2) return false;
    // Heuristic: mixed case + articles/filler words suggest English prose.
    const fillers = /\b(the|a|an|please|i|want|to|try|would|like|could|you|can|some|that|this|my|your)\b/i;
    return fillers.test(s);
}

async function maybeTranslate(raw) {
    if (!state.llmEnabled) return raw;
    if (!looksLikeNaturalLanguage(raw)) return raw;
    if (!state.llmLoaded) {
        // Not loaded yet — pass through.
        return raw;
    }
    try {
        terminal.printColored('(translating…)\n', '#888');
        const result = await llm.translate(raw);
        if (result && result.command) {
            terminal.printColored(
                `  ⤷ ${result.command}` +
                (result.explanation ? `  (${result.explanation})` : '') + '\n',
                '#888',
            );
            return result.command;
        }
    } catch (e) {
        terminal.printColored(`(translate failed: ${e.message})\n`, '#a44');
    }
    return raw;
}

// ---------------------------------------------------------------------------
// Dungeon glue
// ---------------------------------------------------------------------------

async function main() {
    setStatus('Loading game data…');
    const [DungeonGame, data, textRecords] = await Promise.all([
        import('../game/game.js').then(m => m.DungeonGame),
        fetch(DATA_URL).then(r => r.json()),
        fetch(TEXT_URL).then(r => r.json()),
    ]);

    const game = new DungeonGame();
    game.init(data, textRecords);

    game.doSave = () => {
        try {
            localStorage.setItem(SAVE_KEY, JSON.stringify(game.getSaveState()));
            localStorage.setItem(SAVE_WHEN_KEY, String(Date.now()));
        } catch (e) { /* ignore */ }
    };
    game.doRestore = () => {
        try {
            const raw = localStorage.getItem(SAVE_KEY);
            if (!raw) return false;
            game.setSaveState(JSON.parse(raw));
            return true;
        } catch (e) { return false; }
    };

    let restored = false;
    try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (raw) { game.setSaveState(JSON.parse(raw)); restored = true; }
    } catch (e) { /* corrupt save — start fresh */ }

    // The dungeon parser writes lines to `output` (including a bare ">"
    // prompt before calling our `input`). We buffer everything between
    // input requests and draw our own prompt via terminal.readLine.
    const buffered = [];
    const output = (text) => {
        for (let line of (text || '').split('\n')) {
            // Fortran-era leading space
            if (line.startsWith(' ')) line = line.slice(1);
            // Small rebranding
            line = line.replace('Welcome to Dungeon.', 'Welcome to Dungeon (with an LLM parser).');
            buffered.push(line);
        }
    };

    const input = async () => {
        // Drop the bare ">" prompt rdline emitted; we draw our own.
        while (buffered.length && buffered[buffered.length - 1] === '>') buffered.pop();
        if (buffered.length) {
            terminal.print(buffered.join('\n') + '\n');
            buffered.length = 0;
        }
        const raw = await terminal.readLine({ prompt: '> ' });
        const translated = await maybeTranslate(raw);
        return translated;
    };

    if (state.llmEnabled) {
        // Kick off model load in the background — don't block the game.
        ensureLlmLoaded();
    }

    setStatus(state.llmEnabled ? 'LLM parser: loading…' : 'LLM parser: off');

    try {
        await game.run(input, output, { restored });
    } catch (e) {
        if (e.message !== 'cancelled') terminal.println(`dungeon: ${e.message}`);
    }
    if (buffered.length) terminal.print(buffered.join('\n') + '\n');
    terminal.println('[game over]');
}

main().catch(e => {
    terminal.println(`dungeonlm: ${e.message}`);
    console.error(e);
});
