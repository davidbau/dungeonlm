// A minimal line-oriented terminal for dungeonlm.
//
// Dungeon is a pure line-I/O game: each turn emits some lines, then asks
// for a command. This terminal renders scrollback as a <pre> and accepts
// input via a single editable line at the bottom, with readline-style
// history, cursor movement, and Ctrl-C cancellation.
//
// Public API:
//   const term = new Terminal(containerEl);
//   term.print("...")            // append text (may contain \n)
//   term.println("...")          // append a line
//   const line = await term.readLine({ prompt: "> " })
//   term.clear()

export class Terminal {
    constructor(container, { promptColor = '#ffc', textColor = '#5e5', bgColor = '#0a0e0a' } = {}) {
        this.container = container;
        this.promptColor = promptColor;
        this.textColor = textColor;
        this.bgColor = bgColor;

        container.style.cssText = `
            background: ${bgColor};
            color: ${textColor};
            font-family: "DejaVu Sans Mono", "Bitstream Vera Sans Mono", "Liberation Mono", monospace;
            font-size: 14px;
            line-height: 1.4;
            padding: 16px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-word;
            min-height: 400px;
            max-height: calc(100vh - 160px);
            cursor: text;
        `;
        container.tabIndex = 0;

        this._scroll = document.createElement('div');
        container.appendChild(this._scroll);

        this._inputLine = document.createElement('div');
        this._inputLine.style.display = 'none';
        container.appendChild(this._inputLine);

        this._history = [];
        this._historyIdx = 0;
        this._pendingKeys = [];
        this._keyResolver = null;

        container.addEventListener('click', () => container.focus());
        container.addEventListener('keydown', (e) => this._onKey(e));
    }

    clear() {
        this._scroll.textContent = '';
    }

    print(text) {
        const node = document.createTextNode(text);
        this._scroll.appendChild(node);
        this._scrollToBottom();
    }

    println(text = '') {
        this.print(text + '\n');
    }

    printColored(text, color) {
        const span = document.createElement('span');
        span.style.color = color;
        span.textContent = text;
        this._scroll.appendChild(span);
        this._scrollToBottom();
    }

    // Print an array of lines with --More-- pagination. The page size is
    // computed from the current viewport, with a lower bound so tiny
    // windows still show something useful. Press any key to continue,
    // 'q' or Esc to skip the remainder.
    async printPaged(lines, { pageSize } = {}) {
        const size = pageSize || this._pageSize();
        let printed = 0;
        for (let i = 0; i < lines.length; i++) {
            this.println(lines[i]);
            printed++;
            if (printed >= size && i + 1 < lines.length) {
                const stop = await this._moreprompt();
                if (stop) break;
                printed = 0;
            }
        }
    }

    _pageSize() {
        // Rough estimate: viewport rows minus 2 for the input line and
        // the --More-- prompt itself.
        const viewportH = this.container.clientHeight || window.innerHeight || 600;
        const fs = parseFloat(getComputedStyle(this.container).fontSize) || 14;
        const lineH = fs * 1.4;
        return Math.max(6, Math.floor(viewportH / lineH) - 2);
    }

    async _moreprompt() {
        this.container.focus();
        const line = document.createElement('div');
        const span = document.createElement('span');
        span.style.background = this.textColor;
        span.style.color = this.bgColor;
        span.textContent = '--More--';
        line.appendChild(span);
        this._scroll.appendChild(line);
        this._scrollToBottom();
        const e = await this._nextKey();
        // Clear the prompt visually
        line.remove();
        return e.key === 'q' || e.key === 'Q' || e.key === 'Escape';
    }

    async readLine({ prompt = '> ' } = {}) {
        this.container.focus();
        let buf = '';
        let cursor = 0;
        this._historyIdx = this._history.length;

        const render = () => {
            this._inputLine.style.display = 'block';
            this._inputLine.innerHTML = '';
            const promptSpan = document.createElement('span');
            promptSpan.style.color = this.promptColor;
            promptSpan.textContent = prompt;
            this._inputLine.appendChild(promptSpan);

            const before = document.createTextNode(buf.slice(0, cursor));
            const cursorSpan = document.createElement('span');
            cursorSpan.style.background = this.textColor;
            cursorSpan.style.color = this.bgColor;
            cursorSpan.textContent = cursor < buf.length ? buf[cursor] : ' ';
            const after = document.createTextNode(buf.slice(cursor + 1));
            this._inputLine.appendChild(before);
            this._inputLine.appendChild(cursorSpan);
            this._inputLine.appendChild(after);
            this._scrollToBottom();
        };
        render();

        while (true) {
            const e = await this._nextKey();
            if (e.key === 'Enter') {
                this._inputLine.style.display = 'none';
                const promptSpan = document.createElement('span');
                promptSpan.style.color = this.promptColor;
                promptSpan.textContent = prompt;
                this._scroll.appendChild(promptSpan);
                this._scroll.appendChild(document.createTextNode(buf + '\n'));
                if (buf.trim().length > 0) this._history.push(buf);
                this._scrollToBottom();
                return buf;
            }
            if (e.key === 'Backspace') {
                if (cursor > 0) { buf = buf.slice(0, cursor - 1) + buf.slice(cursor); cursor--; }
            } else if (e.key === 'Delete') {
                if (cursor < buf.length) buf = buf.slice(0, cursor) + buf.slice(cursor + 1);
            } else if (e.key === 'ArrowLeft') {
                if (cursor > 0) cursor--;
            } else if (e.key === 'ArrowRight') {
                if (cursor < buf.length) cursor++;
            } else if (e.key === 'Home' || (e.ctrlKey && e.key === 'a')) {
                cursor = 0;
            } else if (e.key === 'End' || (e.ctrlKey && e.key === 'e')) {
                cursor = buf.length;
            } else if (e.key === 'ArrowUp') {
                if (this._historyIdx > 0) {
                    this._historyIdx--;
                    buf = this._history[this._historyIdx];
                    cursor = buf.length;
                }
            } else if (e.key === 'ArrowDown') {
                if (this._historyIdx < this._history.length - 1) {
                    this._historyIdx++;
                    buf = this._history[this._historyIdx];
                    cursor = buf.length;
                } else {
                    this._historyIdx = this._history.length;
                    buf = '';
                    cursor = 0;
                }
            } else if (e.ctrlKey && e.key === 'c') {
                this._inputLine.style.display = 'none';
                this.println('^C');
                throw new Error('cancelled');
            } else if (e.ctrlKey && e.key === 'u') {
                buf = buf.slice(cursor); cursor = 0;
            } else if (e.ctrlKey && e.key === 'k') {
                buf = buf.slice(0, cursor);
            } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
                buf = buf.slice(0, cursor) + e.key + buf.slice(cursor);
                cursor++;
            }
            render();
        }
    }

    _onKey(e) {
        const handled = e.key.length === 1 || [
            'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight',
            'ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab',
        ].includes(e.key);
        if (handled) e.preventDefault();
        if (this._keyResolver) {
            const r = this._keyResolver;
            this._keyResolver = null;
            r(e);
        } else {
            this._pendingKeys.push(e);
        }
    }

    _nextKey() {
        if (this._pendingKeys.length > 0) return Promise.resolve(this._pendingKeys.shift());
        return new Promise(r => { this._keyResolver = r; });
    }

    _scrollToBottom() {
        this.container.scrollTop = this.container.scrollHeight;
    }
}
