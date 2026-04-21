'use strict';

const { View } = require('./view.js');
const { LineBuffer } = require('./line_buffer.js');
const strUtil = require('./string_util.js');
const ansi = require('./ansi_term.js');
const ansiPrep = require('./ansi_prep.js');
const { pipeColorToAnsi } = require('./color_codes.js');

const assert = require('assert');
const _ = require('lodash');

//  :TODO: Determine CTRL-* keys for various things
//  See http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
//  http://wiki.synchro.net/howto:editor:slyedit#edit_mode
//  http://sublime-text-unofficial-documentation.readthedocs.org/en/latest/reference/keyboard_shortcuts_win.html

/* Mystic
     [^B]  Reformat Paragraph            [^O]  Show this help file
       [^I]  Insert tab space              [^Q]  Enter quote mode
       [^K]  Cut current line of text      [^V]  Toggle insert/overwrite
       [^U]  Paste previously cut text     [^Y]  Delete current line


                            BASIC MOVEMENT COMMANDS

                  UP/^E       LEFT/^S      PGUP/^R      HOME/^F
                DOWN/^X      RIGHT/^D      PGDN/^C       END/^G
*/

//
//  Some other interesting implementations, resources, etc.
//
//  Editors - BBS
//  *   https://github.com/M-griffin/Enthral/blob/master/src/msg_fse.cpp
//
//
//  Editors - Other
//  *   http://joe-editor.sourceforge.net/
//  *   http://www.jbox.dk/downloads/edit.c
//  *   https://github.com/dominictarr/hipster
//
//  Implementations - Word Wrap
//  *   https://github.com/protomouse/synchronet/blob/93b01c55b3102ebc3c4f4793c3a45b8c13d0dc2a/src/sbbs3/wordwrap.c
//
//  Misc notes
//  * https://github.com/dominictarr/hipster/issues/15 (Deleting lines/etc.)
//
//  Blessed
//      insertLine: CSR(top, bottom) + CUP(y, 0) + IL(1) + CSR(0, height)
//      deleteLine: CSR(top, bottom) + CUP(y, 0) + DL(1) + CSR(0, height)
//  Quick Ansi -- update only what was changed:
//  https://github.com/dominictarr/quickansi

//
//  To-Do
//
//  * Index pos % for emit scroll events
//  * Some of this should be async'd where there is lots of processing (e.g. word wrap)
//  * Add word delete (CTRL+????)
//

const SPECIAL_KEY_MAP_DEFAULT = {
    'line feed': ['return'],
    exit: ['esc'],
    backspace: ['backspace', 'ctrl + d'], //  https://www.tecmint.com/linux-command-line-bash-shortcut-keys/
    delete: ['delete'],
    tab: ['tab'],
    up: ['up arrow'],
    down: ['down arrow'],
    end: ['end', 'ctrl + e'],
    home: ['home', 'ctrl + a'], //  Ctrl-A = Emacs/Nano home; Ctrl-E = Emacs/Nano end
    left: ['left arrow'],
    right: ['right arrow'],
    'delete line': ['ctrl + y'],
    'page up': ['page up'],
    'page down': ['page down'],
    insert: ['insert', 'ctrl + v'],
    //
    //  Ctrl-Home/End are intentionally NOT the default bindings for start/end-of-doc
    //  because many BBS terminals (iCY Term, SyncTERM, etc.) re-map those combos to
    //  raw control bytes (e.g. Ctrl-End → \x19 = Ctrl-Y = 'delete line').
    //  Sysops may override via specialKeyMap in menu.hjson if their setup supports them.
    //
    'start of document': [],
    'end of document': [],
    //
    //  Ctrl+Arrow is xterm-specific and unreliable on BBS terminals.
    //  Ctrl-B (Emacs/Nano word-left) is universally supported.
    //  Ctrl-W is OS-level on GUI terminal emulators (closes the window).
    //  Sysops may override via specialKeyMap if their clients support these sequences.
    //
    'word left': ['ctrl + b'],
    'word right': [],
    'delete word left': [],
    'delete word right': ['ctrl + t'],
    'cut line': ['ctrl + k'],
    paste: ['ctrl + u'],
};

const HANDLED_SPECIAL_KEYS = [
    'up',
    'down',
    'left',
    'right',
    'home',
    'end',
    'page up',
    'page down',
    'line feed',
    'insert',
    'tab',
    'backspace',
    'delete',
    'delete line',
    'start of document',
    'end of document',
    'word left',
    'word right',
    'delete word left',
    'delete word right',
    'cut line',
    'paste',
];

const PREVIEW_MODE_KEYS = ['up', 'down', 'page up', 'page down'];

//  Returns true when chars[i..i+2] is a complete |## pipe color code.
function isPipeCode(chars, i) {
    return (
        chars[i] === '|' &&
        i + 2 < chars.length &&
        chars[i + 1] >= '0' &&
        chars[i + 1] <= '9' &&
        chars[i + 2] >= '0' &&
        chars[i + 2] <= '9'
    );
}

class MultiLineEditTextView extends View {
    constructor(options) {
        if (!_.isBoolean(options.acceptsFocus)) {
            options.acceptsFocus = true;
        }

        options.acceptsInput = true;

        if (!_.isObject(options.specialKeyMap)) {
            options.specialKeyMap = SPECIAL_KEY_MAP_DEFAULT;
        }

        super(options);

        this.initDefaultWidth();

        //
        //  ANSI seems to want tabs to default to 8 characters. See the following:
        //  * http://www.ansi-bbs.org/ansi-bbs2/control_chars/
        //  * http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
        //
        //  This seems overkill though, so let's default to 4 :)
        //  :TODO: what should this really be? Maybe 8 is OK
        //
        this.tabWidth = _.isNumber(options.tabWidth) ? options.tabWidth : 4;

        this.buffer = new LineBuffer({ width: this.dimens.width });
        this.topVisibleIndex = 0;
        this.mode = options.mode || 'edit'; //  edit | preview | read-only
        this.maxLength = 0; // no max by default
        this.cutBuffer = ''; //  Ctrl-K accumulation buffer
        this._findState = null; //  null when inactive; { query, matches, currentIndex } when active

        if ('preview' === this.mode) {
            this.autoScroll = options.autoScroll || true;
            this.tabSwitchesView = true;
        } else {
            this.autoScroll = options.autoScroll || false;
            this.tabSwitchesView = options.tabSwitchesView || false;
        }
        //
        //  cursorPos represents zero-based row, col positions
        //  within the editor itself
        //
        this.cursorPos = { col: 0, row: 0 };

        //  Pipe-code expanded display state (debounce collapse system)
        this._pipeCodeExpanded = false;
        this._pipeCodeDebounceTimer = null;
        this._pipeCodeNearIndex = -1; //  buffer index of the one code being shown
    }

    isEditMode() {
        return 'edit' === this.mode;
    }

    isPreviewMode() {
        return 'preview' === this.mode;
    }

    getTextSgrPrefix() {
        return this.hasFocus ? this.getFocusSGR() : this.getSGR();
    }

    //  Returns true if chars contains at least one complete |## pipe color code.
    _hasPipeCodes(chars) {
        return /\|[0-9]{2}/.test(chars);
    }

    //  Strip |## pipe color codes to yield the plain display text used for find matching.
    _stripPipeCodes(chars) {
        return chars.replace(/\|[0-9]{2}/g, '');
    }

    //  Returns true if chars contains a complete |## code OR a trailing partial
    //  sequence (bare | or |d).  Used to decide whether to enter expanded mode.
    _hasPipeCodesOrPartial(chars) {
        return /\|[0-9]{2}/.test(chars) || /\|[0-9]?$/.test(chars);
    }

    //  Renders |## numeric pipe color codes in chars to ANSI SGR sequences for
    //  live display in edit mode.  Non-numeric |XX sequences pass through literally.
    _renderLineForDisplay(chars) {
        const PIPE_RE = /\|([0-9]{2})/g;
        let m;
        let rendered = '';
        let lastIndex = 0;
        while ((m = PIPE_RE.exec(chars)) !== null) {
            rendered += chars.slice(lastIndex, m.index);
            rendered += pipeColorToAnsi(parseInt(m[1], 10));
            lastIndex = PIPE_RE.lastIndex;
        }
        return rendered + chars.slice(lastIndex);
    }

    //  Maps a buffer column (index into line.chars) to the corresponding terminal
    //  display column.  Complete |## codes normally have zero display width; in
    //  expanded mode the single near code has 1:1 width while others remain 0-width.
    //  Wide Unicode characters (CJK, Hangul, fullwidth forms, etc.) contribute 2
    //  display columns per codepoint.
    _bufferToDisplayCol(lineIndex, bufferCol) {
        const chars = this.buffer.lines[lineIndex]?.chars ?? '';

        //  Tab chars in the buffer render as a single space (getVisibleText replaces
        //  \t→' '), so they count as 1 display column even though wcwidth('\t') = -1.
        const charWidth = ch => (ch === '\t' ? 1 : strUtil.charDisplayWidth(ch));

        if (!chars.includes('|')) {
            //  Fast path: no pipe codes — walk codepoints accumulating display width
            let dispCol = 0;
            let i = 0;
            while (i < bufferCol && i < chars.length) {
                const cp = chars.codePointAt(i);
                const ch = String.fromCodePoint(cp);
                dispCol += charWidth(ch);
                i += ch.length;
            }
            return dispCol;
        }

        //  nearIndex >= 0 only during expanded mode; -1 means collapsed (skip all).
        const nearIndex =
            this._pipeCodeExpanded && this._pipeCodeNearIndex >= 0
                ? this._pipeCodeNearIndex
                : -1;

        let dispCol = 0;
        let i = 0;
        while (i < chars.length && i < bufferCol) {
            if (isPipeCode(chars, i)) {
                if (i === nearIndex) {
                    //  Near code in expanded mode: '|', digit, digit — all narrow (width 1 each)
                    const advance = Math.min(3, bufferCol - i);
                    i += advance;
                    dispCol += advance;
                } else {
                    //  Collapsed (or non-near) code: 3 buffer positions, 0 display cols
                    i += 3;
                }
            } else {
                const cp = chars.codePointAt(i);
                const ch = String.fromCodePoint(cp);
                dispCol += charWidth(ch);
                i += ch.length;
            }
        }
        return dispCol;
    }

    //  Expanded-mode render: only the code at this._pipeCodeNearIndex is shown as
    //  literal chars in its own color.  All other complete codes remain as ANSI SGR
    //  only (0 display width), so the line width stays bounded.
    _renderLineExpanded(chars) {
        const nearIndex = this._pipeCodeNearIndex;
        const PIPE_RE = /\|([0-9]{2})/g;
        let m;
        let rendered = '';
        let lastIndex = 0;

        while ((m = PIPE_RE.exec(chars)) !== null) {
            rendered += chars.slice(lastIndex, m.index);
            if (m.index === nearIndex) {
                //  Near code — visible |## chars in their own color
                rendered += pipeColorToAnsi(parseInt(m[1], 10)) + m[0];
            } else {
                //  Other codes — emit ANSI SGR but no visible chars
                rendered += pipeColorToAnsi(parseInt(m[1], 10));
            }
            lastIndex = PIPE_RE.lastIndex;
        }

        const tail = chars.slice(lastIndex);
        if (tail) {
            //  Trailing partial at the near position — show in base view color
            if (tail[0] === '|' && lastIndex === nearIndex) {
                rendered += this.getTextSgrPrefix() + tail;
            } else {
                rendered += tail;
            }
        }

        return rendered;
    }

    //  Shared atomic row write.  Rendering + cursor position are driven by the
    //  current _pipeCodeExpanded / _pipeCodeNearIndex state, so callers must
    //  set those before invoking this.
    _pipeCodeRowWrite() {
        const lineIdx = this.getTextLinesIndex();
        const rowPos = this.getAbsolutePosition(this.cursorPos.row, 0);
        const dispCol = this._bufferToDisplayCol(lineIdx, this.cursorPos.col);
        const dstPos = this.getAbsolutePosition(this.cursorPos.row, dispCol);
        this.client.term.write(
            `${ansi.hideCursor()}${this.getTextSgrPrefix()}${ansi.goto(
                rowPos.row,
                rowPos.col
            )}${this.getRenderText(lineIdx)}${ansi.goto(
                dstPos.row,
                dstPos.col
            )}${ansi.showCursor()}`,
            false
        );
    }

    //  Called when TYPING a character that lands the cursor adjacent to a code.
    //  Expands the near code and shows it — no timer, because the user should
    //  see the code until they type the next non-code character.
    _expandNear() {
        this._pipeCodeExpanded = true;
        const lineIdx = this.getTextLinesIndex();
        const chars = this.buffer.lines[lineIdx]?.chars ?? '';
        this._pipeCodeNearIndex = this._codeStartNearCursor(chars, this.cursorPos.col);
        if (this._pipeCodeDebounceTimer !== null) {
            clearTimeout(this._pipeCodeDebounceTimer);
            this._pipeCodeDebounceTimer = null;
        }
        this._pipeCodeRowWrite();
    }

    //  Called when the cursor moves AWAY from the near code after typing.
    //  Keeps the old nearIndex so the just-completed code remains visible
    //  alongside the new character (the "brief flash"), then schedules collapse.
    _flashAndScheduleCollapse() {
        //  _pipeCodeExpanded and _pipeCodeNearIndex are intentionally left as-is.
        if (this._pipeCodeDebounceTimer !== null) {
            clearTimeout(this._pipeCodeDebounceTimer);
        }
        this._pipeCodeRowWrite();
        this._pipeCodeDebounceTimer = setTimeout(() => {
            this._pipeCodeDebounceTimer = null;
            this._collapsePipeCodes();
        }, 300);
    }

    //  Collapse if currently in expanded mode.  Called at the top of every
    //  navigation key handler to prevent stale expanded state from corrupting
    //  cursor/render calculations after the cursor moves away from the code.
    _maybePipeCodeCollapse() {
        if (this._pipeCodeExpanded) {
            this._collapsePipeCodes();
        }
    }

    //  Returns the buffer index where the pipe code sequence adjacent to the
    //  cursor starts, or -1 if the cursor is not near any code.  Checks from
    //  most-complete to least-complete so a full |## match wins over a partial.
    _codeStartNearCursor(chars, col) {
        if (col >= 3 && isPipeCode(chars, col - 3)) return col - 3;
        if (
            col >= 2 &&
            chars[col - 2] === '|' &&
            chars[col - 1] >= '0' &&
            chars[col - 1] <= '9'
        )
            return col - 2;
        if (col >= 1 && chars[col - 1] === '|') return col - 1;
        return -1;
    }

    //  Convenience wrapper — true if cursor is adjacent to ANY code (including partials).
    //  Used in the BACKSPACE path where partials should be visible.
    _cursorNearPipeCode(chars, col) {
        return this._codeStartNearCursor(chars, col) !== -1;
    }

    //  True only when cursor is immediately after a COMPLETE |## code.
    //  Used in the INSERT path — partials stay invisible while being typed.
    _cursorNearCompleteCode(chars, col) {
        return col >= 3 && isPipeCode(chars, col - 3);
    }

    //  Cancel any pending debounce timer and leave expanded mode.
    _ensureCollapsed() {
        if (this._pipeCodeDebounceTimer !== null) {
            clearTimeout(this._pipeCodeDebounceTimer);
            this._pipeCodeDebounceTimer = null;
        }
        this._pipeCodeExpanded = false;
        this._pipeCodeNearIndex = -1;
    }

    //  Full-row write in collapsed mode (_ensureCollapsed must be called first).
    _collapsedAtomicWrite() {
        this._pipeCodeRowWrite();
    }

    //  Called by the debounce timer: switch back to collapsed display and move
    //  the terminal cursor to the display position (codes have 0 display width).
    _collapsePipeCodes() {
        this._ensureCollapsed();
        this._collapsedAtomicWrite();
    }

    //  ── Find / Search ─────────────────────────────────────────────────────────

    //  Produces the visible display string for a line: strips ANSI CSI escape
    //  sequences (e.g. \x1b[...m from prepped ANSI art), pipe codes (|##), and
    //  tabs.  This is the text the user *sees*, used for both match searching and
    //  highlight column calculations.
    _toDisplayText(chars) {
        return this._stripPipeCodes(chars)
            .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') //  strip ANSI CSI sequences
            .replace(/\t/g, ' ');
    }

    _buildFindMatches(query) {
        const q = query.toLowerCase();
        const matches = [];
        for (let i = 0; i < this.buffer.lines.length; i++) {
            const display = this._toDisplayText(this.buffer.lines[i].chars);
            const lc = display.toLowerCase();
            let col = 0;
            let idx;
            while ((idx = lc.indexOf(q, col)) !== -1) {
                matches.push({
                    lineIndex: i,
                    displayStart: idx,
                    displayEnd: idx + q.length,
                });
                col = idx + 1;
            }
        }
        return matches;
    }

    //  Inverse of _bufferToDisplayCol: maps a display column back to the buffer
    //  column (index into line.chars).  Pipe codes are 3 buffer chars, 0 display
    //  width in collapsed mode.  Wide characters (display width 2) that would
    //  straddle the target column snap the result to just before that character.
    _displayToBufferCol(lineIndex, displayCol) {
        const chars = this.buffer.lines[lineIndex]?.chars ?? '';

        if (!chars.includes('|')) {
            //  Fast path: no pipe codes — walk codepoints until display width consumed
            let bufCol = 0;
            let dispCol = 0;
            while (bufCol < chars.length && dispCol < displayCol) {
                const cp = chars.codePointAt(bufCol);
                const ch = String.fromCodePoint(cp);
                const w = strUtil.charDisplayWidth(ch);
                if (dispCol + w > displayCol) {
                    break; //  wide char straddles boundary — snap before it
                }
                dispCol += w;
                bufCol += ch.length;
            }
            return bufCol;
        }

        let bufCol = 0;
        let dispCol = 0;
        while (bufCol < chars.length && dispCol < displayCol) {
            if (isPipeCode(chars, bufCol)) {
                bufCol += 3; //  0 display width — skip without counting
            } else {
                const cp = chars.codePointAt(bufCol);
                const ch = String.fromCodePoint(cp);
                const w = strUtil.charDisplayWidth(ch);
                if (dispCol + w > displayCol) {
                    break; //  wide char straddles boundary — snap before it
                }
                dispCol += w;
                bufCol += ch.length;
            }
        }
        return bufCol;
    }

    _scrollToMatch(match) {
        const halfHeight = Math.floor(this.dimens.height / 2);
        const maxTop = Math.max(0, this.buffer.lines.length - this.dimens.height);
        this.topVisibleIndex = Math.min(
            Math.max(0, match.lineIndex - halfHeight),
            maxTop
        );
        this.cursorPos.row = match.lineIndex - this.topVisibleIndex;
        this.cursorPos.col = this._displayToBufferCol(
            match.lineIndex,
            match.displayStart
        );
    }

    _overlayMatchHighlight(lineIndex, absRow) {
        if (!this._findState || !this._findState.matches.length) {
            return;
        }
        const sgrRestore = this.getTextSgrPrefix();
        const currentMatch = this._findState.matches[this._findState.currentIndex];
        const stripped = this._toDisplayText(this.buffer.lines[lineIndex]?.chars ?? '');

        for (const match of this._findState.matches) {
            if (match.lineIndex !== lineIndex) {
                continue;
            }
            const matchText = stripped.slice(match.displayStart, match.displayEnd);
            if (!matchText) {
                continue;
            }
            const isCurrent = match === currentMatch;
            const highlightSGR = isCurrent
                ? this._findCurrentMatchStyle || '\x1b[0;7m' //  default: inverse
                : this._findMatchStyle || '\x1b[0;7;2m'; //  default: inverse+dim
            const absCol = this.position.col + match.displayStart;
            this.client.term.rawWrite(
                `${ansi.goto(absRow, absCol)}${highlightSGR}${matchText}${sgrRestore}`
            );
        }
    }

    //  :TODO: Most of the calls to this could be avoided via incrementRow(), decrementRow() that keeps track or such
    getTextLinesIndex(row) {
        if (!_.isNumber(row)) {
            row = this.cursorPos.row;
        }
        return this.topVisibleIndex + row;
    }

    getRemainingLinesBelowRow(row) {
        if (!_.isNumber(row)) {
            row = this.cursorPos.row;
        }
        return this.buffer.lines.length - (this.topVisibleIndex + row) - 1;
    }

    getNextEndOfLineIndex(startIndex) {
        for (let i = startIndex; i < this.buffer.lines.length; i++) {
            if (this.buffer.lines[i].eol) {
                return i;
            }
        }
        return this.buffer.lines.length;
    }

    toggleTextCursor(action) {
        this.client.term.rawWrite(
            `${this.getTextSgrPrefix()}${
                'hide' === action ? ansi.hideCursor() : ansi.showCursor()
            }`
        );
    }

    redrawRows(startRow, endRow) {
        this.toggleTextCursor('hide');

        const startIndex = this.getTextLinesIndex(startRow);
        const endIndex = Math.min(
            this.getTextLinesIndex(endRow),
            this.buffer.lines.length
        );
        const absPos = this.getAbsolutePosition(startRow, 0);
        const prefix = this.getTextSgrPrefix();

        for (let i = startIndex; i < endIndex; ++i) {
            const lineAbsRow = absPos.row++;
            this.client.term.write(
                `${ansi.goto(lineAbsRow, absPos.col)}${prefix}${this.getRenderText(i)}`,
                false //  convertLineFeeds
            );
            if (this._findState) {
                this._overlayMatchHighlight(i, lineAbsRow);
            }
        }

        this.toggleTextCursor('show');

        return absPos.row - this.position.row; //  row we ended on
    }

    eraseRows(startRow, endRow) {
        this.toggleTextCursor('hide');

        const absPos = this.getAbsolutePosition(startRow, 0);
        const absPosEnd = this.getAbsolutePosition(endRow, 0);
        const eraseFiller = ' '.repeat(this.dimens.width);

        while (absPos.row < absPosEnd.row) {
            this.client.term.write(
                `${ansi.goto(absPos.row++, absPos.col)}${eraseFiller}`,
                false //  convertLineFeeds
            );
        }

        this.toggleTextCursor('show');
    }

    redrawVisibleArea() {
        assert(this.topVisibleIndex <= this.buffer.lines.length);
        const lastRow = this.redrawRows(0, this.dimens.height);

        this.eraseRows(lastRow, this.dimens.height);
    }

    getVisibleText(index) {
        if (!_.isNumber(index)) {
            index = this.getTextLinesIndex();
        }
        return this.buffer.lines.length > index
            ? this.buffer.lines[index].chars.replace(/\t/g, ' ')
            : '';
    }

    getText(index) {
        if (!_.isNumber(index)) {
            index = this.getTextLinesIndex();
        }
        return this.buffer.lines.length > index ? this.buffer.lines[index].chars : '';
    }

    getTextLength(index) {
        if (!_.isNumber(index)) {
            index = this.getTextLinesIndex();
        }
        return this.buffer.lines.length > index
            ? this.buffer.lines[index].chars.length
            : 0;
    }

    getCharacter(index, col) {
        if (!_.isNumber(col)) {
            col = this.cursorPos.col;
        }
        return this.getText(index).charAt(col);
    }

    isTab(index, col) {
        return '\t' === this.getCharacter(index, col);
    }

    getTextEndOfLineColumn(index) {
        return Math.max(0, this.getTextLength(index));
    }

    getRenderText(index) {
        const rawText = this.getVisibleText(index); // tabs → spaces

        if (this.isEditMode()) {
            const sgrRestore = this.getTextSgrPrefix();

            if (
                this._pipeCodeExpanded &&
                this._pipeCodeNearIndex >= 0 &&
                this._hasPipeCodesOrPartial(rawText)
            ) {
                //  Only the near code is visible (adds 3 display chars); all other
                //  complete codes are 0-width.  strUtil.renderStringLength strips ALL
                //  complete codes, so add 3 back if the near one is complete.
                const nearIsComplete = isPipeCode(rawText, this._pipeCodeNearIndex);
                const displayLen =
                    strUtil.renderStringLength(rawText) + (nearIsComplete ? 3 : 0);
                const rendered = this._renderLineExpanded(rawText);
                const remain = this.dimens.width - displayLen;
                return remain > 0
                    ? rendered + sgrRestore + ' '.repeat(remain)
                    : rendered + sgrRestore;
            }

            if (this._hasPipeCodes(rawText)) {
                //  Collapsed mode: codes invisible, cursor slides to display pos.
                //  strUtil.renderStringLength strips pipe codes when measuring.
                const displayLen = strUtil.renderStringLength(rawText);
                const rendered = this._renderLineForDisplay(rawText);
                const remain = this.dimens.width - displayLen;
                return remain > 0
                    ? rendered + sgrRestore + ' '.repeat(remain)
                    : rendered + sgrRestore;
            }
        }

        //  Default path — plain text or ANSI-baked preview mode.
        const remain = this.dimens.width - strUtil.renderStringLength(rawText);
        return remain > 0 ? rawText + ' '.repeat(remain) : rawText;
    }

    //  Compatibility shim — returns raw buffer lines (shape: { chars, attrs, eol })
    getTextLines(startIndex, endIndex) {
        if (startIndex === endIndex) {
            return [this.buffer.lines[startIndex]];
        }
        return this.buffer.lines.slice(startIndex, endIndex + 1);
    }

    getCharacterLength() {
        return this.buffer.lines.reduce((sum, l) => sum + l.chars.length, 0);
    }

    replaceCharacterInText(c, index, col) {
        //  At end of line there is no character to overwrite — just append
        if (col < this.buffer.lines[index].chars.length) {
            this.buffer.deleteChar(index, col);
        }
        this.buffer.insertChar(index, col, c);
    }

    //  Returns the absolute character offset of (lineIndex, col) within its
    //  paragraph, treating soft-wrapped lines as continuous (space reinserted
    //  at each soft-wrap join point).
    _paragraphOffset(lineIndex, col) {
        const { start } = this.buffer._paragraphRange(lineIndex);
        let offset = col;
        for (let i = start; i < lineIndex; i++) {
            offset += this.buffer.lines[i].chars.length + 1; //  +1 for soft-wrap space
        }
        return offset;
    }

    //  Maps an absolute paragraph offset back to { lineIndex, col } after a
    //  rewrapParagraph call.  paragraphStart is the start index returned by
    //  rewrapParagraph (same as _paragraphRange.start, which is stable).
    _offsetToLineCol(paragraphStart, offset) {
        let i = paragraphStart;
        while (i < this.buffer.lines.length) {
            const len = this.buffer.lines[i].chars.length;
            if (offset <= len || this.buffer.lines[i].eol) {
                return { lineIndex: i, col: Math.min(offset, len) };
            }
            offset -= len + 1; //  +1 for soft-wrap space
            i++;
        }
        const last = Math.max(paragraphStart, i - 1);
        return { lineIndex: last, col: this.buffer.lines[last]?.chars.length ?? 0 };
    }

    insertCharactersInText(c, index, col) {
        const prevTextLength = this.getTextLength(index);
        let editingEol = this.cursorPos.col === prevTextLength;

        //  Insert each character
        for (let i = 0; i < c.length; i++) {
            this.buffer.insertChar(index, col + i, c[i]);
        }
        this.cursorPos.col += c.length;

        if (strUtil.renderStringLength(this.getVisibleText(index)) > this.buffer.width) {
            //  Track cursor position in paragraph coordinates before rewrap
            const paragraphOffset = this._paragraphOffset(index, this.cursorPos.col);
            const { start } = this.buffer.rewrapParagraph(index);

            //  Map cursor back to new line/col after rewrap
            const { lineIndex: newLineIndex, col: newCol } = this._offsetToLineCol(
                start,
                paragraphOffset
            );

            //  Redraw from current row to end of visible area
            this.redrawRows(this.cursorPos.row, this.dimens.height);

            if (newLineIndex !== index) {
                //  Cursor moved to the next visual line after wrap.
                //  cursorBeginOfNextLine() advances cursorPos.row and homes col to 0;
                //  then we set the real col and use moveClientCursorToCursorPos() so
                //  pipe-code display-col mapping is applied correctly.
                this.cursorBeginOfNextLine();
                this.cursorPos.col = newCol;
                this.moveClientCursorToCursorPos();
            } else {
                this.cursorPos.col = newCol;
                this.moveClientCursorToCursorPos();
            }
        } else if (
            this.isEditMode() &&
            this._hasPipeCodesOrPartial(this.buffer.lines[index].chars)
        ) {
            const lineChars = this.buffer.lines[index].chars;
            if (this._cursorNearCompleteCode(lineChars, this.cursorPos.col)) {
                //  Just completed a |## code — expand (no timer; code stays visible
                //  until the user types the next non-code character).
                this._expandNear();
            } else if (this._pipeCodeExpanded) {
                //  Cursor just moved past the code — do a brief flash of the
                //  expanded view (old nearIndex still set), then schedule collapse.
                this._flashAndScheduleCollapse();
            } else {
                //  Not expanded, cursor not near any code — stay collapsed.
                //  The rendered string has ANSI embeds so use a full atomic write.
                this._ensureCollapsed();
                this._collapsedAtomicWrite();
            }
        } else {
            //
            //  No wrap, no pipe codes — redraw from col → end of current visible
            //  line only.  Use an explicit goto to the write start position so that
            //  any cursor drift does not corrupt the footer or other areas outside
            //  the view.
            //
            const writeCol = this.cursorPos.col - c.length;
            const writeDispCol = this._bufferToDisplayCol(index, writeCol);
            const cursorDispCol = this._bufferToDisplayCol(index, this.cursorPos.col);
            const startPos = this.getAbsolutePosition(this.cursorPos.row, writeDispCol);
            const absPos = this.getAbsolutePosition(this.cursorPos.row, cursorDispCol);
            const renderText = this.getRenderText(index).slice(writeCol);

            this.client.term.write(
                `${ansi.hideCursor()}${this.getTextSgrPrefix()}${ansi.goto(
                    startPos.row,
                    startPos.col
                )}${renderText}${ansi.goto(absPos.row, absPos.col)}${ansi.showCursor()}`,
                false //  convertLineFeeds
            );
        }
    }

    getRemainingTabWidth(col) {
        if (!_.isNumber(col)) {
            col = this.cursorPos.col;
        }
        return this.tabWidth - (col % this.tabWidth);
    }

    calculateTabStops() {
        this.tabStops = [0];
        let col = 0;
        while (col < this.dimens.width) {
            col += this.getRemainingTabWidth(col);
            this.tabStops.push(col);
        }
    }

    getNextTabStop(col) {
        let i = this.tabStops.length;
        while (this.tabStops[--i] > col);
        return this.tabStops[++i];
    }

    getPrevTabStop(col) {
        let i = this.tabStops.length;
        while (this.tabStops[--i] >= col);
        return this.tabStops[i];
    }

    expandTab(col, expandChar) {
        expandChar = expandChar || ' ';
        return new Array(this.getRemainingTabWidth(col)).join(expandChar);
    }

    removeCharactersFromText(index, col, operation, count) {
        if ('delete' === operation) {
            if (col >= this.buffer.lines[index].chars.length) {
                return; //  nothing to delete at or past end of line
            }
            this.buffer.deleteChar(index, col);
            this.buffer.rewrapParagraph(index);
            this.redrawRows(this.cursorPos.row, this.dimens.height);
            this.moveClientCursorToCursorPos();
        } else if ('backspace' === operation) {
            //  Remove `count` chars starting at col - (count - 1).
            //  cursorPos.col was already decremented by 1 in keyPressBackspace,
            //  so `col` here is the position of the first char to delete.
            const startCol = col - (count - 1);
            for (let i = 0; i < count; i++) {
                this.buffer.deleteChar(index, startCol);
            }
            this.cursorPos.col -= count - 1;

            //  Capture paragraph offset before rewrap so we can remap the cursor
            //  correctly if rewrap merges lines (reduces line count).  Without this,
            //  topVisibleIndex + cursorPos.row can point past the end of the buffer
            //  on the very next keypress, causing a crash in deleteChar.
            const paragraphOffset = this._paragraphOffset(index, this.cursorPos.col);
            const linesBefore = this.buffer.lines.length;
            const { start } = this.buffer.rewrapParagraph(index);
            const linesAfter = this.buffer.lines.length;

            const { lineIndex: newLineIndex, col: newCol } = this._offsetToLineCol(
                start,
                paragraphOffset
            );
            this.cursorPos.col = newCol;

            const newVisibleRow = newLineIndex - this.topVisibleIndex;
            if (newVisibleRow < 0) {
                //  Merged line scrolled above the visible window — scroll to it.
                this.topVisibleIndex = newLineIndex;
                this.cursorPos.row = 0;
                this.redraw();
                this.moveClientCursorToCursorPos();
            } else {
                this.cursorPos.row = newVisibleRow;
                const chars = this.buffer.lines[newLineIndex]?.chars ?? '';
                if (
                    this.isEditMode() &&
                    this._hasPipeCodesOrPartial(chars) &&
                    linesAfter === linesBefore
                ) {
                    if (this._cursorNearPipeCode(chars, this.cursorPos.col)) {
                        //  Cursor adjacent to a code (complete or partial) — expand and
                        //  keep it visible until the user's next action (no timer).
                        this._expandNear();
                    } else {
                        //  Pipe codes elsewhere; cursor not near — stay collapsed.
                        this._ensureCollapsed();
                        this._collapsedAtomicWrite();
                    }
                } else {
                    this.redrawRows(this.cursorPos.row, this.dimens.height);
                    this.moveClientCursorToCursorPos();
                }
            }
        } else if ('delete line' === operation) {
            //
            //  Delete a visible line. Note that this is *not* the "physical" line, or
            //  1:n entries up to eol! This is to keep consistency with home/end, and
            //  some other text editors such as nano. Sublime for example wants to
            //  treat all of these things using the physical approach, but this seems
            //  a bit odd in this context.
            //
            const isLastLine = index === this.buffer.lines.length - 1;
            const hadEol = this.buffer.lines[index].eol;

            this.buffer.lines.splice(index, 1);
            if (
                hadEol &&
                this.buffer.lines.length > index &&
                !this.buffer.lines[index].eol
            ) {
                this.buffer.lines[index].eol = true;
            }

            //
            //  Ensure a non-empty edit buffer
            //
            let isLastLineMut = isLastLine;
            if (this.buffer.lines.length < 1) {
                this.buffer.lines = [
                    { chars: '', attrs: new Uint32Array(0), eol: true, initialAttr: 0 },
                ];
                isLastLineMut = false; //  resetting
            }

            this.cursorPos.col = 0;

            const lastRow = this.redrawRows(this.cursorPos.row, this.dimens.height);
            this.eraseRows(lastRow, this.dimens.height);

            //
            //  If we just deleted the last line in the buffer, move up
            //
            if (isLastLineMut) {
                this.cursorEndOfPreviousLine();
            } else {
                this.moveClientCursorToCursorPos();
            }
        }
    }

    getAbsolutePosition(row, col) {
        return {
            row: this.position.row + row,
            col: this.position.col + col,
        };
    }

    moveClientCursorToCursorPos() {
        const lineIndex = this.getTextLinesIndex();
        const displayCol = this.isEditMode()
            ? this._bufferToDisplayCol(lineIndex, this.cursorPos.col)
            : this.cursorPos.col;
        const absPos = this.getAbsolutePosition(this.cursorPos.row, displayCol);
        this.client.term.rawWrite(ansi.goto(absPos.row, absPos.col));
    }

    keyPressCharacter(c) {
        this.clearFind();
        if (this.maxLength > 0 && this.getCharacterLength() + 1 >= this.maxLength) {
            return;
        }

        const index = this.getTextLinesIndex();

        //
        //  :TODO: stuff that needs to happen
        //  * Break up into smaller methods
        //  * Even in overtype mode, word wrapping must apply if past bounds
        //  * A lot of this can be used for backspacing also
        //  * See how Sublime treats tabs in *non* overtype mode... just overwrite them?
        //

        if (this.overtypeMode) {
            this.replaceCharacterInText(c, index, this.cursorPos.col);
            this.cursorPos.col++;

            if (
                strUtil.renderStringLength(this.getVisibleText(index)) > this.buffer.width
            ) {
                //  Typed past EOL in OVR mode — the append made the line too long.
                //  Rewrap and advance the cursor to the next line, exactly as
                //  insertCharactersInText does for the wrap case.
                const paragraphOffset = this._paragraphOffset(index, this.cursorPos.col);
                const { start } = this.buffer.rewrapParagraph(index);
                const { lineIndex: newLineIndex, col: newCol } = this._offsetToLineCol(
                    start,
                    paragraphOffset
                );
                this.redrawRows(this.cursorPos.row, this.dimens.height);
                if (newLineIndex !== index) {
                    this.cursorBeginOfNextLine();
                    this.cursorPos.col = newCol;
                    this.moveClientCursorToCursorPos();
                } else {
                    this.cursorPos.col = newCol;
                    this.moveClientCursorToCursorPos();
                }
            } else if (
                this.isEditMode() &&
                this._hasPipeCodesOrPartial(this.buffer.lines[index].chars)
            ) {
                //  Apply the same pipe-code display dispatch as insertCharactersInText so
                //  that |## sequences render correctly in OVR mode too.
                const lineChars = this.buffer.lines[index].chars;
                if (this._cursorNearCompleteCode(lineChars, this.cursorPos.col)) {
                    this._expandNear();
                } else if (this._pipeCodeExpanded) {
                    this._flashAndScheduleCollapse();
                } else {
                    this._ensureCollapsed();
                    this._collapsedAtomicWrite();
                }
            } else {
                //  Explicitly reset SGR before writing so the character inherits the
                //  view's text color rather than whatever the terminal's current state is
                //  (e.g., a highlighted quote line color).
                this.client.term.rawWrite(this.getTextSgrPrefix() + c);
            }
        } else {
            this.insertCharactersInText(c, index, this.cursorPos.col);
        }

        this.emitEditPosition();
    }

    keyPressUp() {
        this._maybePipeCodeCollapse();
        if (this.cursorPos.row > 0) {
            this.cursorPos.row--;
            //  Always use absolute positioning so pipe-code display-col mapping is
            //  applied correctly on the new row (relative ansi.up() can't account
            //  for codes that differ between rows).
            this.adjustCursorIfPastEndOfLine(true);
        } else {
            this.scrollDocumentDown();
            this.adjustCursorIfPastEndOfLine(true);
        }

        this.emitEditPosition();
    }

    keyPressDown() {
        this._maybePipeCodeCollapse();
        const lastVisibleRow =
            Math.min(
                this.dimens.height,
                this.buffer.lines.length - this.topVisibleIndex
            ) - 1;

        if (this.cursorPos.row < lastVisibleRow) {
            this.cursorPos.row++;
            this.adjustCursorIfPastEndOfLine(true);
        } else {
            this.scrollDocumentUp();
            this.adjustCursorIfPastEndOfLine(true);
        }

        this.emitEditPosition();
    }

    keyPressLeft() {
        this._maybePipeCodeCollapse();
        if (this.cursorPos.col > 0) {
            const lineIndex = this.getTextLinesIndex();
            const chars = this.buffer.lines[lineIndex]?.chars ?? '';
            const col = this.cursorPos.col;

            //  In collapsed edit mode, skip back over a complete pipe code (it has
            //  zero display width, so no visible cursor movement).
            if (
                this.isEditMode() &&
                !this._pipeCodeExpanded &&
                col >= 3 &&
                isPipeCode(chars, col - 3)
            ) {
                this.cursorPos.col -= 3;
            } else {
                const prevCharIsTab = this.isTab();
                this.cursorPos.col--;
                if (prevCharIsTab) {
                    this.adjustCursorToNextTab('left');
                }
            }
            //  Always absolute-position so pipe-code col mapping is correct.
            this.moveClientCursorToCursorPos();
        } else {
            this.cursorEndOfPreviousLine();
        }

        this.emitEditPosition();
    }

    keyPressRight() {
        this._maybePipeCodeCollapse();
        const eolColumn = this.getTextEndOfLineColumn();
        if (this.cursorPos.col < eolColumn) {
            const lineIndex = this.getTextLinesIndex();
            const chars = this.buffer.lines[lineIndex]?.chars ?? '';
            const col = this.cursorPos.col;

            //  In collapsed edit mode, skip forward over a complete pipe code (it has
            //  zero display width, so no visible cursor movement).
            if (this.isEditMode() && !this._pipeCodeExpanded && isPipeCode(chars, col)) {
                this.cursorPos.col += 3;
            } else {
                const prevCharIsTab = this.isTab();
                this.cursorPos.col++;
                if (prevCharIsTab) {
                    this.adjustCursorToNextTab('right');
                }
            }
            //  Always absolute-position so pipe-code col mapping is correct.
            this.moveClientCursorToCursorPos();
        } else {
            this.cursorBeginOfNextLine();
        }

        this.emitEditPosition();
    }

    keyPressHome() {
        this._maybePipeCodeCollapse();
        const firstNonWhitespace = this.getVisibleText().search(/\S/);
        if (-1 !== firstNonWhitespace) {
            this.cursorPos.col = firstNonWhitespace;
        } else {
            this.cursorPos.col = 0;
        }
        this.moveClientCursorToCursorPos();

        this.emitEditPosition();
    }

    keyPressEnd() {
        this._maybePipeCodeCollapse();
        this.cursorPos.col = this.getTextEndOfLineColumn();
        this.moveClientCursorToCursorPos();
        this.emitEditPosition();
    }

    keyPressPageUp() {
        this._maybePipeCodeCollapse();
        if (this.topVisibleIndex > 0) {
            this.topVisibleIndex = Math.max(0, this.topVisibleIndex - this.dimens.height);
            this.redraw();
            this.adjustCursorIfPastEndOfLine(true);
        } else {
            this.cursorPos.row = 0;
            this.moveClientCursorToCursorPos(); //  :TODO: adjust if eol, etc.
        }

        this.emitEditPosition();
    }

    keyPressPageDown() {
        this._maybePipeCodeCollapse();
        const linesBelow = this.getRemainingLinesBelowRow();
        if (linesBelow > 0) {
            this.topVisibleIndex += Math.min(linesBelow, this.dimens.height);
            this.redraw();
            this.adjustCursorIfPastEndOfLine(true);
        }

        this.emitEditPosition();
    }

    keyPressLineFeed() {
        this.clearFind();
        this._maybePipeCodeCollapse();
        //
        //  Split at cursor position — LineBuffer creates a hard break here
        //  and handles the right-hand fragment.  Both resulting lines fit
        //  within width so no rewrap is needed.
        //
        const index = this.getTextLinesIndex();
        this.buffer.splitLine(index, this.cursorPos.col);

        this.redrawRows(this.cursorPos.row, this.dimens.height);
        this.cursorBeginOfNextLine();

        this.emitEditPosition();
    }

    keyPressInsert() {
        this.toggleTextEditMode();
    }

    keyPressTab() {
        const index = this.getTextLinesIndex();
        const dispCol = this._bufferToDisplayCol(index, this.cursorPos.col);
        this.insertCharactersInText(
            this.expandTab(dispCol, '\t') + '\t',
            index,
            this.cursorPos.col
        );

        this.emitEditPosition();
    }

    keyPressBackspace() {
        this.clearFind();
        if (this.cursorPos.col >= 1) {
            //
            //  Don't want to delete character at cursor, but rather the character
            //  to the left of the cursor!
            //
            this.cursorPos.col -= 1;

            const index = this.getTextLinesIndex();
            let count;

            if (this.isTab()) {
                let col = this.cursorPos.col;
                const dispCol = this._bufferToDisplayCol(index, col);
                const prevTabStop = this.getPrevTabStop(dispCol);
                let remaining = dispCol - prevTabStop;
                while (col > 0 && remaining > 0) {
                    if (!this.isTab(index, col)) {
                        break;
                    }
                    --col;
                    --remaining;
                }

                count = this.cursorPos.col - col;
            } else {
                count = 1;
            }

            this.removeCharactersFromText(index, this.cursorPos.col, 'backspace', count);
        } else {
            //
            //  Cursor is at col 0 — join this line with the end of the previous line.
            //
            const lineIndex = this.getTextLinesIndex();
            if (lineIndex === 0) {
                return; //  Already at the very first line; nothing to join onto
            }

            //  Remember where the cursor should land: end of the previous line in
            //  paragraph-coordinate space (stable across the upcoming rewrap).
            const prevLineLen = this.buffer.lines[lineIndex - 1].chars.length;
            const paragraphOffset = this._paragraphOffset(lineIndex - 1, prevLineLen);

            //  Merge this line into the previous line, then rewrap the paragraph.
            this.buffer.joinLines(lineIndex - 1);
            const { start } = this.buffer.rewrapParagraph(lineIndex - 1);

            //  Map paragraph offset → new (lineIndex, col) after rewrap.
            const { lineIndex: newLineIndex, col: newCol } = this._offsetToLineCol(
                start,
                paragraphOffset
            );

            const newVisibleRow = newLineIndex - this.topVisibleIndex;

            if (newVisibleRow < 0) {
                //  Target line scrolled above the visible window — scroll to it.
                this.topVisibleIndex = newLineIndex;
                this.cursorPos.row = 0;
                this.cursorPos.col = newCol;
                this.redraw();
                this.moveClientCursorToCursorPos();
            } else {
                this.cursorPos.row = newVisibleRow;
                this.cursorPos.col = newCol;
                const lastRow = this.redrawRows(this.cursorPos.row, this.dimens.height);
                this.eraseRows(lastRow, this.dimens.height);
                this.moveClientCursorToCursorPos();
            }
        }

        this.emitEditPosition();
    }

    keyPressDelete() {
        this.clearFind();
        const lineIndex = this.getTextLinesIndex();
        const lineLen = this.buffer.lines[lineIndex].chars.length;

        if (0 === this.cursorPos.col && lineLen === 0 && this.buffer.lines.length > 0) {
            //
            //  Empty line — delete it
            //
            this.removeCharactersFromText(lineIndex, 0, 'delete line');
        } else if (this.cursorPos.col >= lineLen) {
            //
            //  Cursor is at end of line — forward-delete the line break by joining
            //  with the next line (standard editor behaviour for Delete at EOL).
            //  Only join across a hard break; soft-wrap boundaries are transparent.
            //
            if (
                lineIndex < this.buffer.lines.length - 1 &&
                this.buffer.lines[lineIndex].eol
            ) {
                this.buffer.joinLines(lineIndex);
                this.buffer.rewrapParagraph(lineIndex);
                const lastRow = this.redrawRows(this.cursorPos.row, this.dimens.height);
                this.eraseRows(lastRow, this.dimens.height);
                this.moveClientCursorToCursorPos();
            }
            //  else: at end of last line — nothing to delete
        } else {
            this.removeCharactersFromText(lineIndex, this.cursorPos.col, 'delete', 1);
        }

        this.emitEditPosition();
    }

    keyPressDeleteLine() {
        this.clearFind();
        if (this.buffer.lines.length > 0) {
            this.removeCharactersFromText(this.getTextLinesIndex(), 0, 'delete line');
        }

        this.emitEditPosition();
    }

    adjustCursorIfPastEndOfLine(forceUpdate) {
        const eolColumn = this.getTextEndOfLineColumn();
        if (this.cursorPos.col > eolColumn) {
            this.cursorPos.col = eolColumn;
            forceUpdate = true;
        }

        if (forceUpdate) {
            this.moveClientCursorToCursorPos();
        }
    }

    adjustCursorToNextTab(direction) {
        if (this.isTab()) {
            const lineIndex = this.getTextLinesIndex();
            const dispCol = this._bufferToDisplayCol(lineIndex, this.cursorPos.col);
            let move;
            switch (direction) {
                //
                //  Next tabstop to the right
                //
                case 'right':
                    move = this.getNextTabStop(dispCol) - dispCol;
                    this.cursorPos.col += move;
                    this.client.term.rawWrite(ansi.right(move));
                    break;

                //
                //  Next tabstop to the left
                //
                case 'left':
                    move = dispCol - this.getPrevTabStop(dispCol);
                    this.cursorPos.col -= move;
                    this.client.term.rawWrite(ansi.left(move));
                    break;

                case 'up':
                case 'down':
                    //
                    //  Jump to the tabstop nearest the cursor
                    //
                    {
                        const newStop = this.tabStops.reduce((prev, curr) => {
                            return Math.abs(curr - dispCol) < Math.abs(prev - dispCol)
                                ? curr
                                : prev;
                        });

                        if (newStop > dispCol) {
                            move = newStop - dispCol;
                            this.cursorPos.col += move;
                            this.client.term.rawWrite(ansi.right(move));
                        } else if (newStop < dispCol) {
                            move = dispCol - newStop;
                            this.cursorPos.col -= move;
                            this.client.term.rawWrite(ansi.left(move));
                        }
                    }
                    break;
            }

            return true;
        }
        return false; //  did not fall on a tab
    }

    cursorStartOfDocument() {
        this.topVisibleIndex = 0;
        this.cursorPos = { row: 0, col: 0 };

        this.redraw();
        this.moveClientCursorToCursorPos();
    }

    cursorEndOfDocument() {
        this.topVisibleIndex = Math.max(this.buffer.lines.length - this.dimens.height, 0);
        this.cursorPos.row = this.buffer.lines.length - this.topVisibleIndex - 1;
        this.cursorPos.col = this.getTextEndOfLineColumn();

        this.redraw();
        this.moveClientCursorToCursorPos();
    }

    cursorBeginOfNextLine() {
        //  e.g. when scrolling right past eol
        const linesBelow = this.getRemainingLinesBelowRow();

        if (linesBelow > 0) {
            const lastVisibleRow =
                Math.min(this.dimens.height, this.buffer.lines.length) - 1;
            if (this.cursorPos.row < lastVisibleRow) {
                this.cursorPos.row++;
            } else {
                this.scrollDocumentUp();
            }
            this.keyPressHome(); //  same as pressing 'home'
        }
    }

    cursorEndOfPreviousLine() {
        //  e.g. when scrolling left past start of line
        let moveToEnd;
        if (this.cursorPos.row > 0) {
            this.cursorPos.row--;
            moveToEnd = true;
        } else if (this.topVisibleIndex > 0) {
            this.scrollDocumentDown();
            moveToEnd = true;
        }

        if (moveToEnd) {
            this.keyPressEnd(); //  same as pressing 'end'
        }
    }

    scrollDocumentUp() {
        //
        //  Note: We scroll *up* when the cursor goes *down* beyond
        //  the visible area!
        //
        const linesBelow = this.getRemainingLinesBelowRow();
        if (linesBelow > 0) {
            this.topVisibleIndex++;
            this.redraw();
        }
    }

    scrollDocumentDown() {
        //
        //  Note: We scroll *down* when the cursor goes *up* beyond
        //  the visible area!
        //
        if (this.topVisibleIndex > 0) {
            this.topVisibleIndex--;
            this.redraw();
        }
    }

    keyPressStartOfDocument() {
        this._maybePipeCodeCollapse();
        this.cursorStartOfDocument();
        this.emitEditPosition();
    }

    keyPressEndOfDocument() {
        this._maybePipeCodeCollapse();
        this.cursorEndOfDocument();
        this.emitEditPosition();
    }

    keyPressWordLeft() {
        this._maybePipeCodeCollapse();
        let lineIndex = this.getTextLinesIndex();
        let col = this.cursorPos.col;

        if (col === 0) {
            if (lineIndex === 0) {
                return; //  already at document start
            }
            //  Step to end of previous line
            if (this.cursorPos.row > 0) {
                this.cursorPos.row--;
            } else {
                this.scrollDocumentDown();
            }
            lineIndex--;
            col = this.buffer.lines[lineIndex].chars.length;
        }

        const chars = this.buffer.lines[lineIndex].chars;
        //  Skip spaces going left
        while (col > 0 && chars[col - 1] === ' ') col--;
        //  Skip non-spaces going left (find word start)
        while (col > 0 && chars[col - 1] !== ' ') col--;

        this.cursorPos.col = col;
        this.moveClientCursorToCursorPos();
        this.emitEditPosition();
    }

    keyPressWordRight() {
        this._maybePipeCodeCollapse();
        const lineIndex = this.getTextLinesIndex();
        const chars = this.buffer.lines[lineIndex].chars;
        let col = this.cursorPos.col;

        //  Skip non-spaces (end of current word)
        while (col < chars.length && chars[col] !== ' ') col++;
        //  Skip spaces (start of next word)
        while (col < chars.length && chars[col] === ' ') col++;

        if (col >= chars.length) {
            this.cursorBeginOfNextLine();
            return;
        }

        this.cursorPos.col = col;
        this.moveClientCursorToCursorPos();
        this.emitEditPosition();
    }

    keyPressDeleteWordLeft() {
        if (!this.isEditMode()) return;
        this.clearFind();

        const lineIndex = this.getTextLinesIndex();
        const col = this.cursorPos.col;

        if (col === 0) return;

        const chars = this.buffer.lines[lineIndex].chars;
        let newCol = col;
        //  Skip spaces going left
        while (newCol > 0 && chars[newCol - 1] === ' ') newCol--;
        //  Skip non-spaces going left
        while (newCol > 0 && chars[newCol - 1] !== ' ') newCol--;

        const count = col - newCol;
        if (count === 0) return;

        for (let i = 0; i < count; i++) {
            this.buffer.deleteChar(lineIndex, newCol);
        }
        this.cursorPos.col = newCol;
        this.buffer.rewrapParagraph(lineIndex);
        this.redrawRows(this.cursorPos.row, this.dimens.height);
        this.moveClientCursorToCursorPos();
        this.emitEditPosition();
    }

    keyPressDeleteWordRight() {
        if (!this.isEditMode()) return;
        this.clearFind();

        const lineIndex = this.getTextLinesIndex();
        const chars = this.buffer.lines[lineIndex].chars;
        const col = this.cursorPos.col;

        if (col >= chars.length) return;

        let endCol = col;
        //  Skip non-spaces (end of current word)
        while (endCol < chars.length && chars[endCol] !== ' ') endCol++;
        //  Skip spaces (start of next word)
        while (endCol < chars.length && chars[endCol] === ' ') endCol++;

        const count = endCol - col;
        if (count === 0) return;

        for (let i = 0; i < count; i++) {
            this.buffer.deleteChar(lineIndex, col);
        }
        this.buffer.rewrapParagraph(lineIndex);
        this.redrawRows(this.cursorPos.row, this.dimens.height);
        this.moveClientCursorToCursorPos();
        this.emitEditPosition();
    }

    keyPressCutLine() {
        if (!this.isEditMode()) return;
        this.clearFind();

        const lineIndex = this.getTextLinesIndex();
        const lineText = this.buffer.lines[lineIndex].chars;

        //  Sequential Ctrl-K presses accumulate lines into the cut buffer.
        if (this._lastWasCut) {
            this.cutBuffer += '\n' + lineText;
        } else {
            this.cutBuffer = lineText;
            this._lastWasCut = true;
        }

        this.removeCharactersFromText(lineIndex, 0, 'delete line');
        this.emitEditPosition();
    }

    keyPressPaste() {
        if (!this.isEditMode() || !this.cutBuffer) return;
        this.clearFind();

        const lines = this.cutBuffer.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (i > 0) {
                //  Insert a hard line break between pasted lines
                const idx = this.getTextLinesIndex();
                this.buffer.splitLine(idx, this.cursorPos.col);
                this.cursorPos.col = 0;
                if (this.cursorPos.row < this.dimens.height - 1) {
                    this.cursorPos.row++;
                } else {
                    this.topVisibleIndex++;
                }
            }
            if (lines[i].length > 0) {
                const idx = this.getTextLinesIndex();
                this.insertCharactersInText(lines[i], idx, this.cursorPos.col);
            }
        }

        this.emitEditPosition();
    }

    emitEditPosition() {
        this.emit('edit position', this.getEditPosition());
    }

    toggleTextEditMode() {
        this.overtypeMode = !this.overtypeMode;
        this.emit('text edit mode', this.getTextEditMode());
    }

    setWidth(width) {
        super.setWidth(width);

        this.calculateTabStops();
        if (this.buffer) {
            this.buffer.setWidth(width);
        }
    }

    redraw() {
        super.redraw();

        this.redrawVisibleArea();
    }

    setFocus(focused) {
        super.setFocus(focused);

        if (this.isEditMode() && this.getSGR() !== this.getFocusSGR()) {
            this.redrawVisibleArea();
        } else {
            this.client.term.rawWrite(this.getTextSgrPrefix());
        }
        this.moveClientCursorToCursorPos();
    }

    setText(text, options = { scrollMode: 'default' }) {
        //  Normalize line endings and load into a fresh buffer
        this._findState = null; //  new content — clear any active search
        this.buffer = new LineBuffer({ width: this.dimens.width });
        const normalized = (text || '').replace(/\r\n|\r/g, '\n');
        this.buffer.setText(normalized);

        switch (options.scrollMode || 'default') {
            case 'top':
            case 'start':
                this.cursorStartOfDocument();
                break;
            case 'end':
            case 'bottom':
                this.cursorEndOfDocument();
                break;
            default:
                if (this.isEditMode() || this.autoScroll) {
                    this.cursorEndOfDocument();
                } else {
                    this.cursorStartOfDocument();
                }
                break;
        }
    }

    setAnsi(ansiText, options = { prepped: false }, cb) {
        this._findState = null; //  new content — clear any active search
        this.buffer = new LineBuffer({ width: this.dimens.width });
        return this.setAnsiWithOptions(ansiText, options, cb);
    }

    addText(text, options = { scrollMode: 'default' }) {
        const normalized = (text || '').replace(/\r\n|\r/g, '\n');

        const isEmpty =
            this.buffer.lines.length === 1 && this.buffer.lines[0].chars === '';

        if (isEmpty) {
            this.buffer.setText(normalized);
        } else {
            //  Append as new paragraphs
            const tmp = new LineBuffer({ width: this.buffer.width });
            tmp.setText(normalized);
            this.buffer.lines.push(...tmp.lines);
        }

        switch (options.scrollMode || 'default') {
            case 'top':
            case 'start':
                this.cursorStartOfDocument();
                break;
            case 'end':
            case 'bottom':
                this.cursorEndOfDocument();
                break;
            default:
                if (this.isEditMode() || this.autoScroll) {
                    this.cursorEndOfDocument();
                } else {
                    this.cursorStartOfDocument();
                }
                break;
        }
    }

    setAnsiWithOptions(ansiText, options, cb) {
        const setLines = text => {
            const splitLines = strUtil.splitTextAtTerms(text);
            this.buffer.lines = splitLines.map(line => ({
                chars: line,
                attrs: new Uint32Array(line.length),
                eol: true,
                initialAttr: 0,
            }));
            if (this.buffer.lines.length === 0) {
                this.buffer.lines = [
                    { chars: '', attrs: new Uint32Array(0), eol: true, initialAttr: 0 },
                ];
            }

            this.cursorStartOfDocument();

            if (cb) {
                return cb(null);
            }
        };

        if (options.prepped) {
            return setLines(ansiText);
        }

        ansiPrep(
            ansiText,
            {
                termWidth: options.termWidth || this.client.term.termWidth,
                termHeight: options.termHeight || this.client.term.termHeight,
                cols: this.dimens.width,
                rows: 'auto',
                startCol: this.position.col,
                forceLineTerm: options.forceLineTerm,
            },
            (err, preppedAnsi) => {
                return setLines(err ? ansiText : preppedAnsi);
            }
        );
    }

    getData(options = { forceLineTerms: false }) {
        if (options.forceLineTerms) {
            //  Every visual line (including soft-wrapped) gets \r\n
            return this.buffer.lines.map(l => l.chars + '\r\n').join('');
        }
        //  Hard breaks → \r\n; soft-wrapped joins get a space (LineBuffer getText() semantics)
        return this.buffer.getText().replace(/\n/g, '\r\n');
    }

    setFindQuery(query) {
        if (!query) {
            return this.clearFind();
        }
        const matches = this._buildFindMatches(query);
        this._findState = { query, matches, currentIndex: 0 };
        if (matches.length > 0) {
            this._scrollToMatch(matches[0]);
        }
        this.redrawVisibleArea();
        this.moveClientCursorToCursorPos();
    }

    //  Scroll to the first match of |query| and position the cursor there,
    //  without setting _findState or painting any highlight overlay.
    //  Used in edit mode where persistent highlights interfere with editing.
    gotoFirstMatch(query) {
        if (!query) {
            return;
        }
        const matches = this._buildFindMatches(query);
        if (matches.length > 0) {
            this._scrollToMatch(matches[0]);
        }
        this.redrawVisibleArea();
        this.moveClientCursorToCursorPos();
    }

    findNext() {
        if (!this._findState || !this._findState.matches.length) {
            return;
        }
        this._findState.currentIndex =
            (this._findState.currentIndex + 1) % this._findState.matches.length;
        this._scrollToMatch(this._findState.matches[this._findState.currentIndex]);
        this.redrawVisibleArea();
        this.moveClientCursorToCursorPos();
    }

    findPrev() {
        if (!this._findState || !this._findState.matches.length) {
            return;
        }
        this._findState.currentIndex =
            (this._findState.currentIndex - 1 + this._findState.matches.length) %
            this._findState.matches.length;
        this._scrollToMatch(this._findState.matches[this._findState.currentIndex]);
        this.redrawVisibleArea();
        this.moveClientCursorToCursorPos();
    }

    clearFind(redraw = true) {
        if (!this._findState) {
            return;
        }
        this._findState = null;
        if (redraw) {
            this.redrawVisibleArea();
            this.moveClientCursorToCursorPos();
        }
    }

    getFindMatchCount() {
        return this._findState?.matches.length ?? 0;
    }

    setPropertyValue(propName, value) {
        switch (propName) {
            case 'mode':
                this.mode = value;
                if ('preview' === value && !this.specialKeyMap.next) {
                    this.specialKeyMap.next = ['tab'];
                }
                break;

            case 'autoScroll':
                this.autoScroll = value;
                break;

            case 'tabSwitchesView':
                this.tabSwitchesView = value;
                this.specialKeyMap.next = this.specialKeyMap.next || [];
                this.specialKeyMap.next.push('tab');
                break;

            case 'maxLength':
                if (_.isNumber(value)) {
                    this.maxLength = value;
                }
                break;

            case 'findMatchStyle':
                this._findMatchStyle = value;
                break;

            case 'findCurrentMatchStyle':
                this._findCurrentMatchStyle = value;
                break;
        }

        super.setPropertyValue(propName, value);
    }

    onKeyPress(ch, key) {
        let handled;
        let isCutLine = false;

        if (key) {
            HANDLED_SPECIAL_KEYS.forEach(specialKey => {
                if (this.isKeyMapped(specialKey, key.name)) {
                    if (
                        this.isPreviewMode() &&
                        -1 === PREVIEW_MODE_KEYS.indexOf(specialKey)
                    ) {
                        return;
                    }

                    if ('tab' !== key.name || !this.tabSwitchesView) {
                        if ('cut line' === specialKey) {
                            isCutLine = true;
                        }
                        this[_.camelCase('keyPress ' + specialKey)]();
                        handled = true;
                    }
                }
            });
        }

        if (!isCutLine) {
            this._lastWasCut = false; //  reset Ctrl-K accumulation on any other key
        }

        if (this.isEditMode() && ch && strUtil.isPrintable(ch)) {
            this.keyPressCharacter(ch);
        }

        if (!handled) {
            super.onKeyPress(ch, key);
        }
    }

    scrollUp() {
        this.scrollDocumentUp();
    }

    scrollDown() {
        this.scrollDocumentDown();
    }

    deleteLine(line) {
        this.buffer.lines.splice(line, 1);
    }

    getLineCount() {
        return this.buffer.lines.length;
    }

    getTextEditMode() {
        return this.overtypeMode ? 'overtype' : 'insert';
    }

    getEditPosition() {
        const currentIndex = this.getTextLinesIndex() + 1;

        return {
            row: this.getTextLinesIndex(this.cursorPos.row),
            col: this.cursorPos.col,
            percent: Math.floor((currentIndex / this.buffer.lines.length) * 100),
            below: this.getRemainingLinesBelowRow(),
        };
    }
}

exports.MultiLineEditTextView = MultiLineEditTextView;
