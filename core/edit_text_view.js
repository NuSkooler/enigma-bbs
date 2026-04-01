'use strict';

//  ENiGMA½
const { TextView } = require('./text_view.js');
const { LineBuffer } = require('./line_buffer.js');
const miscUtil = require('./misc_util.js');
const strUtil = require('./string_util.js');
const ansi = require('./ansi_term.js');
const { VIEW_SPECIAL_KEY_MAP_DEFAULT } = require('./view');

//  deps
const _ = require('lodash');

const EDIT_TEXT_VIEW_KEY_MAP = Object.assign({}, VIEW_SPECIAL_KEY_MAP_DEFAULT, {
    delete: ['delete', 'ctrl + d'], //  https://www.tecmint.com/linux-command-line-bash-shortcut-keys/
});

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
    }

    //  ── Internal helpers ─────────────────────────────────────────────────────

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

    //  Return raw logical text, not the possibly-styled this.text.
    getData() {
        return this.lineBuffer ? this.lineBuffer.getText() : this.text;
    }

    //  ── Input handling ───────────────────────────────────────────────────────

    onKeyPress(ch, key) {
        if (key) {
            if (this.isKeyMapped('left', key.name)) {
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
                this.cursorPos.col = 0;
                this._scrollOffset = 0;
                this.redraw();
                this._repositionCursor();
                return super.onKeyPress(ch, key);
            } else if (this.isKeyMapped('end', key.name)) {
                this.cursorPos.col = this.lineBuffer.lines[0].chars.length;
                this._scrollOffset = this._computeScrollOffset();
                this.redraw();
                this._repositionCursor();
                return super.onKeyPress(ch, key);
            } else if (this.isKeyMapped('backspace', key.name)) {
                if (this.cursorPos.col > 0) {
                    this.cursorPos.col--;
                    this.lineBuffer.deleteChar(0, this.cursorPos.col);
                    this._syncFromBuffer();
                    this._scrollOffset = this._computeScrollOffset();
                    this.redraw();
                    this._repositionCursor();
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
                this._syncFromBuffer();
                this._scrollOffset = this._computeScrollOffset();
                this.redraw();
                this._repositionCursor();
                return super.onKeyPress(ch, key);
            } else if (this.isKeyMapped('clearLine', key.name)) {
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

        super.onKeyPress(ch, key);
    }
}

exports.EditTextView = EditTextView;
