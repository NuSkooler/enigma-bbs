'use strict';

//  ENiGMA½
const { TextView } = require('./text_view.js');
const { LineBuffer } = require('./line_buffer.js');
const miscUtil = require('./misc_util.js');
const strUtil = require('./string_util.js');
const ansi = require('./ansi_term.js');

const assert = require('assert');
const _ = require('lodash');

//  ##/##/#### <--styleSGR2 if fillChar
//    ^- styleSGR1
//  buildPattern -> [ RE, RE, '/', RE, RE, '/', RE, RE, RE, RE ]
//  patternIndex -----^

//  styleSGR1: Literal's (non-focus)
//  styleSGR2: Literals (focused)
//  styleSGR3: fillChar

//
//  :TODO:
//  * Hint, e.g. YYYY/MM/DD
//  * Editing within the field: arrow keys, insert/overwrite at a slot other
//    than the last. Input is currently append/truncate only.

class MaskEditTextView extends TextView {
    constructor(options) {
        options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
        options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);
        options.cursorStyle = miscUtil.valueWithDefault(
            options.cursorStyle,
            'steady block'
        );
        options.resizable = false;

        super(options);

        this.initDefaultWidth();

        this.cursorPos = { x: 0 };
        this.maskPattern = options.maskPattern || '';

        //  buildPattern sets this.maxLength (number of input slots)
        this.buildPattern();

        //  LineBuffer initialized after buildPattern so maxLength is correct
        this.lineBuffer = new LineBuffer({ width: this.maxLength });

        //  TextView's constructor already called setText(), but that ran before
        //  buildPattern() and before lineBuffer existed, so both guards in our
        //  override skipped and any initial text never reached the buffer.
        //  Replay it now; this establishes patternArrayPos as well.
        this.setText(options.text || '', false); //  false=do not redraw now
    }

    //  ── Internal helpers ─────────────────────────────────────────────────────

    //  Sync this.text (the draw system's source) from lineBuffer.
    _syncFromBuffer() {
        this.text = this.lineBuffer.lines[0].chars;
    }

    //  ── Display ──────────────────────────────────────────────────────────────

    clientBackspace() {
        const fillCharSGR = this.getStyleSGR(3) || this.getSGR();
        this.client.term.write(
            '\b' + fillCharSGR + this.fillChar + '\b' + this.getFocusSGR()
        );
    }

    drawText(s) {
        const textToDraw = strUtil.stylizeString(
            s,
            this.hasFocus ? this.focusTextStyle : this.textStyle
        );

        assert(textToDraw.length <= this.patternArray.length);

        let i = 0;
        let t = 0;
        while (i < this.patternArray.length) {
            if (_.isRegExp(this.patternArray[i])) {
                if (t < textToDraw.length) {
                    this.client.term.write(
                        (this.hasFocus ? this.getFocusSGR() : this.getSGR()) +
                            textToDraw[t]
                    );
                    t++;
                } else {
                    this.client.term.write((this.getStyleSGR(3) || '') + this.fillChar);
                }
            } else {
                const styleSgr = this.hasFocus
                    ? this.getStyleSGR(2) || ''
                    : this.getStyleSGR(1) || '';
                this.client.term.write(styleSgr + this.maskPattern[i]);
            }
            i++;
        }
    }

    //  ── Pattern management ───────────────────────────────────────────────────

    buildPattern() {
        this.patternArray = [];
        this.maxLength = 0;

        for (let i = 0; i < this.maskPattern.length; i++) {
            //  :TODO: support escaped characters, e.g. \#. Also allow \\ for a '\' mark!
            if (this.maskPattern[i] in MaskEditTextView.maskPatternCharacterRegEx) {
                this.patternArray.push(
                    MaskEditTextView.maskPatternCharacterRegEx[this.maskPattern[i]]
                );
                ++this.maxLength;
            } else {
                this.patternArray.push(this.maskPattern[i]);
            }
        }
    }

    getEndOfTextColumn() {
        return this.position.col + this.patternArrayPos;
    }

    //  Pattern position holding |len| filled slots, past any trailing literals.
    _patternPosForLength(len) {
        let pos = 0;
        let remain = len;
        while (pos < this.patternArray.length) {
            if (_.isRegExp(this.patternArray[pos])) {
                if (0 === remain) {
                    break;
                }
                --remain;
            }
            ++pos;
        }
        return pos;
    }

    //  ── Overrides ────────────────────────────────────────────────────────────

    setText(text, redraw) {
        redraw = _.isBoolean(redraw) ? redraw : true; //  match TextView's default

        super.setText(text, redraw); //  pass through redraw; TextView ctor calls with false

        if (this.lineBuffer) {
            const raw = (text == null ? '' : String(text)).slice(0, this.maxLength);
            this.lineBuffer.lines[0] = {
                chars: raw,
                attrs: new Uint32Array(raw.length),
                eol: true,
                initialAttr: 0,
            };
            this.text = raw;
        }

        //  Must follow the text actually stored: clearText() would otherwise
        //  leave an empty buffer with the cursor parked at the end of the field.
        if (this.patternArray) {
            this.patternArrayPos = this._patternPosForLength(
                this.lineBuffer ? this.lineBuffer.lines[0].chars.length : 0
            );
        }

        //  A redraw leaves the terminal cursor past the end of the field, which
        //  is only where the next keypress lands if the field is full. Callers
        //  that follow with setFocus() get this anyway; those that don't would
        //  otherwise type at one column and echo at another.
        if (redraw && this.hasFocus) {
            this._positionCursor(true);
        }
    }

    setMaskPattern(pattern) {
        this.dimens.width = pattern.length;
        this.maskPattern = pattern;
        this.buildPattern();
        //  Reinitialize lineBuffer now that maxLength is updated
        this.lineBuffer = new LineBuffer({ width: this.maxLength });

        //  Drop any text carried over from the old pattern: its characters no
        //  longer line up with the new slots, getData() would not return it,
        //  and drawing it against a shorter pattern trips the assert in
        //  drawText(). setText() resets patternArrayPos along with it.
        this.setText('', false); //  false=caller redraws when it is ready
    }

    getData() {
        const rawData = this.lineBuffer ? this.lineBuffer.getText() : super.getData();

        if (!rawData || 0 === rawData.length) {
            return rawData;
        }

        let data = '';
        let p = 0;
        for (let i = 0; i < this.patternArray.length; ++i) {
            if (_.isRegExp(this.patternArray[i])) {
                //  Only append typed chars; stop if input was partial
                if (p < rawData.length) {
                    data += rawData[p++];
                }
            } else {
                data += this.patternArray[i];
            }
        }

        return data;
    }

    setPropertyValue(propName, value) {
        switch (propName) {
            case 'maskPattern':
                this.setMaskPattern(value);
                break;
        }

        super.setPropertyValue(propName, value);
    }

    //  ── Input handling ───────────────────────────────────────────────────────

    onKeyPress(ch, key) {
        if (key) {
            if (this.isKeyMapped('backspace', key.name)) {
                const textLen = this.lineBuffer.lines[0].chars.length;
                if (textLen > 0) {
                    this.lineBuffer.deleteChar(0, textLen - 1);
                    this._syncFromBuffer();
                    this.patternArrayPos = this._patternPosForLength(textLen - 1);

                    //  clientBackspace() steps left before it writes, so this
                    //  targets one column past the slot being cleared. That is
                    //  where the cursor already sits unless the deletion walked
                    //  back over one or more literals.
                    this.client.term.write(
                        ansi.goto(this.position.row, this.getEndOfTextColumn() + 1)
                    );
                    this.clientBackspace();
                }

                return;
            } else if (this.isKeyMapped('clearLine', key.name)) {
                this.lineBuffer.lines[0] = {
                    chars: '',
                    attrs: new Uint32Array(0),
                    eol: true,
                    initialAttr: 0,
                };
                this._syncFromBuffer();
                this.patternArrayPos = this._patternPosForLength(0);
                this.setFocus(true); //  redraw + adjust cursor

                return;
            }
        }

        if (ch && strUtil.isPrintable(ch)) {
            const textLen = this.lineBuffer.lines[0].chars.length;
            if (textLen < this.maxLength) {
                ch = strUtil.stylizeString(ch, this.textStyle);

                if (!ch.match(this.patternArray[this.patternArrayPos])) {
                    return;
                }

                this.lineBuffer.insertChar(0, textLen, ch, 0);
                this._syncFromBuffer();
                this.patternArrayPos = this._patternPosForLength(
                    this.lineBuffer.lines[0].chars.length
                );

                this.redraw();
                this.client.term.write(
                    ansi.goto(this.position.row, this.getEndOfTextColumn())
                );
            }
        }

        super.onKeyPress(ch, key);
    }
}

MaskEditTextView.maskPatternCharacterRegEx = {
    '#': /[0-9]/, //  Numeric
    A: /[a-zA-Z]/, //  Alpha
    '@': /[0-9a-zA-Z]/, //  Alphanumeric
    '&': /[\w\d\s]/, //  Any "printable" 32-126, 128-255
};

exports.MaskEditTextView = MaskEditTextView;
