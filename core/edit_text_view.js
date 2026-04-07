'use strict';

//  ENiGMA½
const { TextView } = require('./text_view.js');
const { LineBuffer } = require('./line_buffer.js');
const miscUtil = require('./misc_util.js');
const strUtil = require('./string_util.js');
const ansi = require('./ansi_term.js');
const { VIEW_SPECIAL_KEY_MAP_DEFAULT } = require('./view');
const { pipeColorToAnsi } = require('./color_codes.js');

//  deps
const _ = require('lodash');

const EDIT_TEXT_VIEW_KEY_MAP = Object.assign({}, VIEW_SPECIAL_KEY_MAP_DEFAULT, {
    delete: ['delete', 'ctrl + d'], //  https://www.tecmint.com/linux-command-line-bash-shortcut-keys/
});

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
    }

    // ── Pipe-code helpers (ported from MLTEV) ────────────────────────────────

    _hasPipeCodes(chars) {
        return /\|[0-9]{2}/.test(chars) || /\|[0-9]?$/.test(chars);
    }

    //  Returns the buffer index where the pipe-code sequence adjacent to the
    //  cursor starts, or -1 if the cursor is not near any code.
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

    _cursorNearCompleteCode(chars, col) {
        return col >= 3 && isPipeCode(chars, col - 3);
    }

    _cursorNearPipeCode(chars, col) {
        return this._codeStartNearCursor(chars, col) !== -1;
    }

    //  Convert all complete |## codes in s to ANSI SGR; non-numeric |XX literals pass through.
    _renderLineCollapsed(s) {
        return s.replace(/\|([0-9]{2})/g, (_, code) =>
            pipeColorToAnsi(parseInt(code, 10))
        );
    }

    //  Expanded-mode render: the code at nearIdx shows as literal |## chars in its
    //  own color; all other complete codes are ANSI SGR only (0 display width).
    _renderLineExpanded(s, nearIdx) {
        const PIPE_RE = /\|([0-9]{2})/g;
        let m;
        let rendered = '';
        let lastIndex = 0;

        while ((m = PIPE_RE.exec(s)) !== null) {
            rendered += s.slice(lastIndex, m.index);
            if (m.index === nearIdx) {
                //  Near code — show literal |## in its own color
                rendered += pipeColorToAnsi(parseInt(m[1], 10)) + m[0];
            } else {
                //  Other codes — ANSI SGR, 0 display width
                rendered += pipeColorToAnsi(parseInt(m[1], 10));
            }
            lastIndex = PIPE_RE.lastIndex;
        }

        const tail = s.slice(lastIndex);
        if (tail) {
            //  Trailing partial at the near position — show in base view color
            if (tail[0] === '|' && lastIndex === nearIdx) {
                rendered += this.getFocusSGR() + tail;
            } else {
                rendered += tail;
            }
        }

        return rendered;
    }

    //  Walk chars counting visible (non-pipe-code) characters until visOff is reached;
    //  return the corresponding buffer index.  Used to remap _pipeNearIndex (a buffer
    //  index into the full raw string) to an index within the visible slice.
    _visToBufferIdx(chars, visOff) {
        let i = 0;
        let vis = 0;
        while (i < chars.length && vis < visOff) {
            if (isPipeCode(chars, i)) {
                i += 3;
            } else {
                i++;
                vis++;
            }
        }
        return i;
    }

    //  Visible-char-aware slice: skip visOff visible chars, then collect up to
    //  visCount visible chars (pipe codes preserved, not counted).
    _visSliceRaw(chars, visOff, visCount) {
        let i = 0;
        let vis = 0;
        while (i < chars.length && vis < visOff) {
            if (isPipeCode(chars, i)) {
                i += 3;
            } else {
                i++;
                vis++;
            }
        }
        let result = '';
        let seen = 0;
        while (i < chars.length && seen < visCount) {
            if (isPipeCode(chars, i)) {
                result += chars.slice(i, i + 3);
                i += 3;
            } else {
                result += chars[i];
                i++;
                seen++;
            }
        }
        return result;
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

        //  Slice the visible portion of the raw text.  When a prefix is present
        //  the scroll offset is in visible-char units (set by the monkey-patched
        //  _computeScrollOffset in sysop_chat); otherwise it's a raw buffer offset.
        let visibleRaw;
        if (prefixW > 0) {
            visibleRaw = this._visSliceRaw(raw, scrollOff, ew);
        } else {
            visibleRaw = raw.slice(scrollOff, scrollOff + ew);
        }

        let renderedText;
        if (this._pipeExpanded && this._pipeNearIndex >= 0 && this._hasPipeCodes(raw)) {
            //  Remap near index to its position within the visible slice
            const bufStart = prefixW > 0
                ? this._visToBufferIdx(raw, scrollOff)
                : scrollOff;
            const nearIdxInSlice = this._pipeNearIndex - bufStart;

            renderedText =
                nearIdxInSlice >= 0 && nearIdxInSlice < visibleRaw.length
                    ? this._renderLineExpanded(visibleRaw, nearIdxInSlice)
                    : this._renderLineCollapsed(visibleRaw);
        } else {
            renderedText = this._renderLineCollapsed(visibleRaw);
        }

        const fullLine = resolvedPrefix + renderedText;
        const visLen = prefixW + strUtil.renderStringLength(renderedText);
        const fillCount = Math.max(0, this.dimens.width - visLen);
        const fill = fillCount > 0
            ? this.getFocusSGR() + ' '.repeat(fillCount)
            : '';

        this.client.term.write(
            `${ansi.hideCursor()}${ansi.goto(this.position.row, this.position.col)}${fullLine}${fill}`,
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

    _collapsePipeCodes() {
        this._ensureCollapsed();
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
        this._scrollOffset = this._computeScrollOffset();

        if (this.itemFormat && this._hasPipeCodes(this.lineBuffer.lines[0].chars)) {
            if (this._cursorNearPipeCode(this.lineBuffer.lines[0].chars, this.cursorPos.col)) {
                this._expandNear();
            } else {
                this._ensureCollapsed();
                this._atomicLineWrite();
            }
        } else {
            this._ensureCollapsed();
            this.redraw();
            this._repositionCursor();
        }
    }

    //  Sync this.text (used by TextView's draw system) from lineBuffer.
    //  this.text is always the FULL raw text; drawText() applies scroll.
    _syncFromBuffer() {
        this.text = this.lineBuffer.lines[0].chars;
    }

    //  Compute the scroll offset that keeps cursorPos.col visible in the
    //  dimens.width window, adjusting incrementally from the current offset.
    _computeScrollOffset() {
        const textLen = this.lineBuffer.lines[0].chars.length;
        if (textLen <= this.dimens.width) return 0;

        const cur = this._scrollOffset;
        const maxOff = textLen - this.dimens.width;

        if (this.cursorPos.col < cur) {
            //  Cursor moved past left edge — scroll to cursor
            return this.cursorPos.col;
        }
        if (this.cursorPos.col >= cur + this.dimens.width) {
            //  Cursor moved past right edge — scroll to keep cursor at right edge
            return Math.min(this.cursorPos.col - this.dimens.width + 1, maxOff);
        }
        //  Cursor still visible — clamp offset to valid range
        return Math.min(cur, maxOff);
    }

    //  Move the terminal cursor to match cursorPos.col within the scroll window and
    //  re-establish the focus SGR.  redraw() ends with the fill-char SGR (potentially
    //  dim); restoring getFocusSGR() here prevents the next typed character from
    //  inheriting the wrong colour.
    _repositionCursor() {
        const screenCol = this.position.col + (this.cursorPos.col - this._scrollOffset);
        this.client.term.write(
            ansi.goto(this.position.row, screenCol) + this.getFocusSGR()
        );
    }

    //  ── Overrides ────────────────────────────────────────────────────────────

    //  Override drawText to apply our managed scroll offset instead of
    //  TextView's default "always show last N chars" horizScroll behaviour.
    drawText(s) {
        if (this.hasFocus && this.lineBuffer && s.length > this.dimens.width) {
            this._scrollOffset = this._computeScrollOffset();
            s = s.slice(this._scrollOffset, this._scrollOffset + this.dimens.width);
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
                    const notScrolled = newLen <= this.dimens.width;

                    if (atEnd && notScrolled) {
                        //  Fast path: appended at end with no scroll — write char directly
                        if (_.isString(this.textMaskChar) && this.textMaskChar.length > 0) {
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
