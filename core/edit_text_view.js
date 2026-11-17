'use strict';

//  ENiGMA½
const { TextView } = require('./text_view.js');
const { LineBuffer } = require('./line_buffer.js');
const miscUtil = require('./misc_util.js');
const strUtil = require('./string_util.js');
const ansi = require('./ansi_term.js');
const { VIEW_SPECIAL_KEY_MAP_DEFAULT } = require('./view');
const PipeCodes = require('./pipe_codes.js');
const ColorPreview = require('./color_preview.js');

//  deps
const _ = require('lodash');

const EDIT_TEXT_VIEW_KEY_MAP = Object.assign({}, VIEW_SPECIAL_KEY_MAP_DEFAULT, {
    delete: ['delete', 'ctrl + d'], //  https://www.tecmint.com/linux-command-line-bash-shortcut-keys/
});

//  With an itemFormat the field draws |## codes as colour (the live preview)
//  and is measured that way; without one TextView draws the text as typed,
//  so a |07 takes three columns.
const EDITOR_TEXT = { dialect: 'color' };
const AS_TYPED = { dialect: 'ansi' };

const { colorCodeAt } = PipeCodes;

class EditTextView extends TextView {
    constructor(options) {
        options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
        options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);
        options.cursorStyle = miscUtil.valueWithDefault(
            options.cursorStyle,
            'steady block'
        );
        options.resizable = false;

        if (!_.isObject(options.specialKeyMap)) {
            options.specialKeyMap = EDIT_TEXT_VIEW_KEY_MAP;
        }

        super(options);

        this.initDefaultWidth();
        this.cursorPos = { row: 0, col: 0 };
        this._scrollOffset = 0;
        //  LineBuffer is the authoritative store for logical text and cursor ops.
        //  Width is maxLength — the logical cap; display scroll is separate.
        this.lineBuffer = new LineBuffer({ width: this.maxLength });

        //  Pipe-code expand/collapse state (mirrors MLTEV system)
        this._pipeExpanded = false;
        this._pipeNearIndex = -1;
        this._pipeTimer = null;

        //  Set by _enableLiveColorOnInput (sysop_chat, etc.) when a prefix is active.
        //  Used by _atomicLineWrite to reconstruct the full line without the normal
        //  redraw path (which would collapse the near code via pipeToAnsi).
        this._resolvedPrefix = '';
        this._prefixW = 0;
        //  True when _scrollOffset is in display columns, not a buffer index
        //  (sysop chat's input line sets it).
        this._scrollInCells = false;
    }

    // ── Pipe-code helpers (shared with MLTEV: color_preview.js) ─────────────

    //  A complete |## code, or one being typed at the end
    _hasPipeCodes(chars) {
        return ColorPreview.hasColorCodeOrPartial(chars);
    }

    //  Returns the buffer index where the pipe-code sequence adjacent to the
    //  cursor starts, or -1 if the cursor is not near any code.
    _codeStartNearCursor(chars, col) {
        return ColorPreview.codeStartNearCursor(chars, col);
    }

    _cursorNearCompleteCode(chars, col) {
        return ColorPreview.cursorNearCompleteCode(chars, col);
    }

    _cursorNearPipeCode(chars, col) {
        return this._codeStartNearCursor(chars, col) !== -1;
    }

    //  Convert all complete |## codes in s to ANSI SGR; non-numeric |XX literals pass through.
    _renderLineCollapsed(s) {
        return PipeCodes.render(s, EDITOR_TEXT);
    }

    //  Expanded-mode render: the code at nearIdx shows as literal |## chars in its
    //  own color; all other complete codes are ANSI SGR only (0 display width).
    //  A trailing partial at the near position shows in the base view color.
    _renderLineExpanded(s, nearIdx) {
        return ColorPreview.renderExpanded(s, nearIdx, this.getFocusSGR());
    }

    //  The buffer index |cols| display columns into chars (|## codes take
    //  none; a wide character straddling the column is not included).  Used to
    //  remap _pipeNearIndex (a buffer index into the full raw string) to an
    //  index within the visible slice.
    _visToBufferIdx(chars, cols) {
        return PipeCodes.splitPos(chars, cols, EDITOR_TEXT);
    }

    //  The part of chars that is |count| display columns wide, starting |off|
    //  columns in, with the |## codes inside it kept.
    _visSliceRaw(chars, off, count) {
        const a = PipeCodes.splitPos(chars, off, EDITOR_TEXT);
        const rest = chars.slice(a);
        return rest.slice(0, PipeCodes.splitPos(rest, count, EDITOR_TEXT));
    }

    //  Atomic single-line write: renders the visible portion of the current text
    //  (collapsed or expanded) and writes it to the terminal without going through
    //  the normal redraw → pipeToAnsi path.  This allows the near code to appear
    //  as literal |## characters during expanded mode.
    //
    //  Used when itemFormat is set (live-color mode).  For the prefix-less case,
    //  a normal redraw() is sufficient.
    _atomicLineWrite() {
        const raw = this.lineBuffer ? this.lineBuffer.lines[0].chars : '';
        const scrollOff = this._scrollOffset;
        const prefixW = this._prefixW || 0;
        const resolvedPrefix = this._resolvedPrefix || '';
        const ew = this.dimens.width - prefixW;

        //  Slice the visible portion of the raw text, ew display columns wide.
        //  The scroll offset is in display columns when _scrollInCells is set
        //  (by the monkey-patched _computeScrollOffset in sysop_chat);
        //  otherwise it's a raw buffer offset, as drawText() takes it.
        let visibleRaw;
        let bufStart;
        if (this._scrollInCells) {
            bufStart = this._visToBufferIdx(raw, scrollOff);
            visibleRaw = this._visSliceRaw(raw, scrollOff, ew);
        } else {
            bufStart = scrollOff;
            const tail = this._previewChars(raw).slice(scrollOff);
            visibleRaw = raw.slice(
                scrollOff,
                scrollOff + PipeCodes.splitPos(tail, ew, this._measure())
            );
        }

        let renderedText;
        if (this._pipeExpanded && this._pipeNearIndex >= 0 && this._hasPipeCodes(raw)) {
            //  Remap near index to its position within the visible slice
            const nearIdxInSlice = this._pipeNearIndex - bufStart;

            renderedText =
                nearIdxInSlice >= 0 && nearIdxInSlice < visibleRaw.length
                    ? this._renderLineExpanded(visibleRaw, nearIdxInSlice)
                    : this._renderLineCollapsed(visibleRaw);
        } else {
            renderedText = this._renderLineCollapsed(visibleRaw);
        }

        const fullLine = resolvedPrefix + renderedText;
        //  renderedText is already rendered: a code shown as typed is text
        const visLen = prefixW + strUtil.renderStringLength(renderedText, AS_TYPED);
        const fillCount = Math.max(0, this.dimens.width - visLen);
        const fill = fillCount > 0 ? this.getFocusSGR() + ' '.repeat(fillCount) : '';

        this.client.term.write(
            `${ansi.hideCursor()}${ansi.goto(
                this.position.row,
                this.position.col
            )}${fullLine}${fill}`,
            false
        );
        this._repositionCursor();
        this.client.term.write(ansi.showCursor(), false);
    }

    // ── Expand / collapse state machine ──────────────────────────────────────

    _ensureCollapsed() {
        if (this._pipeTimer !== null) {
            clearTimeout(this._pipeTimer);
            this._pipeTimer = null;
        }
        this._pipeExpanded = false;
        this._pipeNearIndex = -1;
    }

    _maybePipeCollapse() {
        if (this._pipeExpanded) {
            this._collapsePipeCodes();
        }
    }

    //  The scroll offset is worked out again whenever the expand/collapse
    //  state changes: a code shown as typed takes three columns.
    _collapsePipeCodes() {
        this._ensureCollapsed();
        this._scrollOffset = this._computeScrollOffset();
        this._atomicLineWrite();
    }

    //  Just-completed a |## code — expand it (no timer; stays visible until
    //  the user types the next non-code character).
    _expandNear() {
        this._pipeExpanded = true;
        const chars = this.lineBuffer.lines[0].chars;
        this._pipeNearIndex = this._codeStartNearCursor(chars, this.cursorPos.col);
        if (this._pipeTimer !== null) {
            clearTimeout(this._pipeTimer);
            this._pipeTimer = null;
        }
        this._scrollOffset = this._computeScrollOffset();
        this._atomicLineWrite();
    }

    //  Cursor moved past the near code — show briefly, then schedule collapse.
    _flashAndScheduleCollapse() {
        //  Leave _pipeExpanded and _pipeNearIndex as-is (brief flash).
        if (this._pipeTimer !== null) {
            clearTimeout(this._pipeTimer);
        }
        this._atomicLineWrite();
        this._pipeTimer = setTimeout(() => {
            this._pipeTimer = null;
            this._collapsePipeCodes();
        }, 300);
    }

    //  ── Internal helpers ─────────────────────────────────────────────────────

    //  After a character is deleted, sync the buffer, recompute scroll, and
    //  redraw using the appropriate pipe-code path.  When itemFormat is active
    //  (live-color mode), uses _atomicLineWrite so the near code can be shown in
    //  expanded form; otherwise falls back to a normal redraw.
    _redrawAfterEdit() {
        this._syncFromBuffer();

        if (this.itemFormat && this._hasPipeCodes(this.lineBuffer.lines[0].chars)) {
            if (
                this._cursorNearPipeCode(
                    this.lineBuffer.lines[0].chars,
                    this.cursorPos.col
                )
            ) {
                this._expandNear(); //  works the scroll offset out
            } else {
                this._ensureCollapsed();
                this._scrollOffset = this._computeScrollOffset();
                this._atomicLineWrite();
            }
        } else {
            this._ensureCollapsed();
            this._scrollOffset = this._computeScrollOffset();
            this.redraw();
            this._repositionCursor();
        }
    }

    //  Sync this.text (used by TextView's draw system) from lineBuffer.
    //  this.text is always the FULL raw text; drawText() applies scroll.
    _syncFromBuffer() {
        this.text = this.lineBuffer.lines[0].chars;
    }

    //  How the text is measured: as the live preview draws it (itemFormat),
    //  or as typed.
    _measure() {
        return this.itemFormat ? EDITOR_TEXT : AS_TYPED;
    }

    //  The text as the live preview lays it out. In expanded mode the code
    //  shown as typed takes three columns: its '|' is swapped for a character
    //  that starts no code, so it measures as text and every index still
    //  points at the same character.
    _previewChars(chars) {
        const near = this._pipeNearIndex;
        if (
            this.itemFormat &&
            this._pipeExpanded &&
            near >= 0 &&
            colorCodeAt(chars, near) >= 0
        ) {
            return chars.slice(0, near) + '#' + chars.slice(near + 1);
        }
        return chars;
    }

    //  Maps a buffer column (string index into the text) to the terminal display
    //  column, skipping collapsed pipe codes (0 display width) and accumulating
    //  display widths for wide Unicode characters (CJK, Hangul, fullwidth forms).
    //  In expanded mode the code shown as typed counts its three columns.
    _bufferToDisplayCol(bufferCol) {
        const chars = this._previewChars(this.lineBuffer.lines[0]?.chars ?? '');
        let dispCol = 0;
        let i = 0;
        while (i < bufferCol && i < chars.length) {
            if (this.itemFormat && colorCodeAt(chars, i) >= 0) {
                i += 3; //  pipe codes: 0 display width in collapsed mode
            } else {
                const cp = chars.codePointAt(i);
                const ch = String.fromCodePoint(cp);
                dispCol += strUtil.charDisplayWidth(ch);
                i += ch.length;
            }
        }
        return dispCol;
    }

    //  Compute the scroll offset (buffer index of first visible character) that
    //  keeps the cursor visible within the dimens.width display column window.
    //  All boundary comparisons are in display columns; the return value is a
    //  buffer index so buffer operations (insertChar, deleteChar) remain correct.
    _computeScrollOffset() {
        const raw = this.lineBuffer.lines[0].chars;
        const chars = this._previewChars(raw);
        const off = this._scrollOffsetIn(chars);
        //  The window never starts inside the code shown as typed
        const near = this._pipeNearIndex;
        return chars !== raw && off > near && off < near + 3 ? near + 3 : off;
    }

    _scrollOffsetIn(chars) {
        const textDisplayLen = strUtil.renderStringLength(chars, this._measure());
        if (textDisplayLen <= this.dimens.width) return 0;

        const cur = this._scrollOffset;
        const cursorDisplayCol = this._bufferToDisplayCol(this.cursorPos.col);
        const scrollDisplayCol = this._bufferToDisplayCol(cur);

        if (cursorDisplayCol < scrollDisplayCol) {
            //  Cursor moved past left edge — scroll to cursor
            return this.cursorPos.col;
        }
        if (cursorDisplayCol >= scrollDisplayCol + this.dimens.width) {
            //  Cursor moved past right edge — find buffer index at left-edge display col
            return strUtil.renderSplitPos(
                chars,
                cursorDisplayCol - this.dimens.width + 1,
                this._measure()
            );
        }
        //  Cursor still visible — clamp offset to valid buffer index. The
        //  window starts no earlier than maxOffDisplay, so the end of the text
        //  (and a cursor there) stays in view; with a wide character on that
        //  column, after it. Where both branches land on a wide character they
        //  then agree, so a redraw draws what the last write drew.
        const maxOffDisplay = textDisplayLen - this.dimens.width;
        return Math.min(cur, this._bufferIndexFrom(chars, maxOffDisplay));
    }

    //  The buffer index where display column |col| starts. When a wide
    //  character straddles |col| it is the index after that character (not
    //  before it, as splitPos() gives), so a window starting there keeps every
    //  column from |col| on in view.
    _bufferIndexFrom(chars, col) {
        const i = strUtil.renderSplitPos(chars, col, this._measure());
        if (i >= chars.length) {
            return i;
        }
        const ch = String.fromCodePoint(chars.codePointAt(i));
        if (
            strUtil.charDisplayWidth(ch) < 2 ||
            strUtil.renderStringLength(chars.slice(0, i), this._measure()) >= col
        ) {
            return i;
        }
        return i + ch.length;
    }

    //  Move the terminal cursor to match cursorPos.col within the scroll window
    //  and re-establish the focus SGR.  Both cursor and scroll positions are
    //  converted to display columns before computing the screen column.
    _repositionCursor() {
        const cursorDisplayCol = this._bufferToDisplayCol(this.cursorPos.col);
        const scrollDisplayCol = this._bufferToDisplayCol(this._scrollOffset);
        const screenCol = this.position.col + (cursorDisplayCol - scrollDisplayCol);
        this.client.term.write(
            ansi.goto(this.position.row, screenCol) + this.getFocusSGR()
        );
    }

    //  ── Overrides ────────────────────────────────────────────────────────────

    //  Override drawText to apply our managed scroll offset instead of
    //  TextView's default "always show last N chars" horizScroll behaviour.
    drawText(s) {
        //  A redraw renders through the itemFormat, which draws every code as
        //  its colour: a code shown as typed collapses first, so the scroll
        //  offset, the cells drawn and the cursor agree with what the live
        //  write draws collapsed. (A just-typed code stays shown until the
        //  next key; a redraw, such as sysop chat's, ends that early.)
        if (this._pipeExpanded) {
            this._ensureCollapsed();
        }
        if (
            this.hasFocus &&
            this.lineBuffer &&
            strUtil.renderStringLength(s, this._measure()) > this.dimens.width
        ) {
            this._scrollOffset = this._computeScrollOffset();
            const tail = s.slice(this._scrollOffset);
            s = tail.slice(
                0,
                strUtil.renderSplitPos(tail, this.dimens.width, this._measure())
            );
        }
        super.drawText(s);
    }

    //  Override _positionCursor to place cursor at cursorPos.col instead of end-of-text.
    //  Called by TextView.setFocus after redraw — single cursor move, no conflict.
    _positionCursor(focused) {
        if (focused && this.lineBuffer) {
            this._repositionCursor();
        } else {
            super._positionCursor(focused);
        }
    }

    //  Override setFocus to pre-compute scroll before the redraw inside super.setFocus.
    setFocus(focused) {
        if (focused && this.lineBuffer) {
            this._scrollOffset = this._computeScrollOffset();
        }
        super.setFocus(focused); //  → redraw → _positionCursor (virtual, resolved above)
    }

    //  Override setText to seed lineBuffer from the raw (pre-pipeline) text.
    //  Called by TextView constructor with ('', false) — lineBuffer guard required.
    setText(text, redraw) {
        super.setText(text, redraw);

        if (this.lineBuffer) {
            let raw = text == null ? '' : String(text);
            if (this.maxLength > 0 && raw.length > this.maxLength) {
                raw = raw.slice(0, this.maxLength);
            }
            this.lineBuffer.lines[0] = {
                chars: raw,
                attrs: new Uint32Array(raw.length),
                eol: true,
                initialAttr: 0,
            };
            this.text = raw;
            this.cursorPos.col = raw.length;
            this._scrollOffset = this._computeScrollOffset();
        }
    }

    //  Store prefixFormat (and any other recognised custom properties) so that
    //  theme.hjson MCI-level config like ET2: { prefixFormat: ... } is accessible
    //  after view construction.
    setPropertyValue(propName, value) {
        if (propName === 'prefixFormat') {
            this.prefixFormat = value;
        } else {
            super.setPropertyValue(propName, value);
        }
    }

    //  Return raw logical text, not the possibly-styled this.text.
    getData() {
        return this.lineBuffer ? this.lineBuffer.getText() : this.text;
    }

    destroy() {
        if (this._pipeTimer !== null) {
            clearTimeout(this._pipeTimer);
            this._pipeTimer = null;
        }
        super.destroy();
    }

    //  ── Input handling ───────────────────────────────────────────────────────

    onKeyPress(ch, key) {
        if (key) {
            if (this.isKeyMapped('left', key.name)) {
                this._maybePipeCollapse();
                if (this.cursorPos.col > 0) {
                    this.cursorPos.col--;
                    const prevOff = this._scrollOffset;
                    this._scrollOffset = this._computeScrollOffset();
                    if (this._scrollOffset !== prevOff) {
                        this.redraw();
                    }
                    this._repositionCursor();
                }
                return super.onKeyPress(ch, key);
            } else if (this.isKeyMapped('right', key.name)) {
                this._maybePipeCollapse();
                const len = this.lineBuffer.lines[0].chars.length;
                if (this.cursorPos.col < len) {
                    this.cursorPos.col++;
                    const prevOff = this._scrollOffset;
                    this._scrollOffset = this._computeScrollOffset();
                    if (this._scrollOffset !== prevOff) {
                        this.redraw();
                    }
                    this._repositionCursor();
                }
                return super.onKeyPress(ch, key);
            } else if (this.isKeyMapped('home', key.name)) {
                this._maybePipeCollapse();
                this.cursorPos.col = 0;
                this._scrollOffset = 0;
                this.redraw();
                this._repositionCursor();
                return super.onKeyPress(ch, key);
            } else if (this.isKeyMapped('end', key.name)) {
                this._maybePipeCollapse();
                this.cursorPos.col = this.lineBuffer.lines[0].chars.length;
                this._scrollOffset = this._computeScrollOffset();
                this.redraw();
                this._repositionCursor();
                return super.onKeyPress(ch, key);
            } else if (this.isKeyMapped('backspace', key.name)) {
                if (this.cursorPos.col > 0) {
                    this.cursorPos.col--;
                    this.lineBuffer.deleteChar(0, this.cursorPos.col);
                    this._redrawAfterEdit();
                }
                return super.onKeyPress(ch, key);
            } else if (this.isKeyMapped('delete', key.name)) {
                const len = this.lineBuffer.lines[0].chars.length;
                if (this.cursorPos.col < len) {
                    //  Forward delete: remove char at cursor
                    this.lineBuffer.deleteChar(0, this.cursorPos.col);
                } else if (len > 0) {
                    //  Some older terminals send 'delete' for Backspace at EOL
                    this.cursorPos.col--;
                    this.lineBuffer.deleteChar(0, this.cursorPos.col);
                } else {
                    return super.onKeyPress(ch, key);
                }
                this._redrawAfterEdit();
                return super.onKeyPress(ch, key);
            } else if (this.isKeyMapped('clearLine', key.name)) {
                this._ensureCollapsed();
                this.lineBuffer.lines[0] = {
                    chars: '',
                    attrs: new Uint32Array(0),
                    eol: true,
                    initialAttr: 0,
                };
                this.text = '';
                this.cursorPos.col = 0;
                this._scrollOffset = 0;
                this.setFocus(true); //  redraw + cursor placement
                return super.onKeyPress(ch, key);
            }
        }

        if (ch && strUtil.isPrintable(ch)) {
            const len = this.lineBuffer.lines[0].chars.length;
            if (len < this.maxLength) {
                const styled = strUtil.stylizeString(ch, this.textStyle);
                this.lineBuffer.insertChar(0, this.cursorPos.col, styled, 0);
                this.cursorPos.col++;
                this._syncFromBuffer();

                if (this.itemFormat) {
                    //  Live-color mode: use expand/collapse and always do a full write
                    //  so pipeToAnsi (or our own renderer) processes the whole line.
                    //  The fast path bypasses itemFormat and would show the wrong colour.
                    this._scrollOffset = this._computeScrollOffset();
                    const lineChars = this.lineBuffer.lines[0].chars;

                    if (this._hasPipeCodes(lineChars) || this._pipeExpanded) {
                        if (this._cursorNearCompleteCode(lineChars, this.cursorPos.col)) {
                            this._expandNear();
                        } else if (this._pipeExpanded) {
                            this._flashAndScheduleCollapse();
                        } else {
                            this._ensureCollapsed();
                            this._atomicLineWrite();
                        }
                    } else {
                        //  No pipe codes — normal full redraw so the prefix stays correct
                        this._atomicLineWrite();
                    }
                } else {
                    const newLen = len + 1;
                    const atEnd = this.cursorPos.col === newLen;
                    const notScrolled =
                        this._bufferToDisplayCol(newLen) <= this.dimens.width;

                    if (atEnd && notScrolled) {
                        //  Fast path: appended at end with no scroll — write char directly
                        if (
                            _.isString(this.textMaskChar) &&
                            this.textMaskChar.length > 0
                        ) {
                            this.client.term.write(this.textMaskChar);
                        } else {
                            this.client.term.write(styled);
                        }
                    } else {
                        this._scrollOffset = this._computeScrollOffset();
                        this.redraw();
                        this._repositionCursor();
                    }
                }
            }
        }

        super.onKeyPress(ch, key);
    }
}

exports.EditTextView = EditTextView;
