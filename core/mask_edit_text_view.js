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
//  * Return values with literals in place
//  * Tab in/out results in oddities such as cursor placement & ability to type in non-pattern chars
//  * There exists some sort of condition that allows pattern position to get out of sync

class MaskEditTextView extends TextView {
    constructor(options) {
        options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
        options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);
        options.cursorStyle = miscUtil.valueWithDefault(options.cursorStyle, 'steady block');
        options.resizable = false;

        super(options);

        this.initDefaultWidth();

        this.cursorPos = { x: 0 };
        this.patternArrayPos = 0;
        this.maskPattern = options.maskPattern || '';

        //  buildPattern sets this.maxLength (number of input slots)
        this.buildPattern();

        //  LineBuffer initialized after buildPattern so maxLength is correct
        this.lineBuffer = new LineBuffer({ width: this.maxLength });
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

    //  ── Overrides ────────────────────────────────────────────────────────────

    setText(text, redraw) {
        super.setText(text, redraw); //  pass through redraw; TextView ctor calls with false

        if (this.patternArray) {
            this.patternArrayPos = this.patternArray.length;
        }

        if (this.lineBuffer) {
            const raw = (text == null ? '' : String(text)).slice(0, this.maxLength);
            this.lineBuffer.lines[0] = {
                chars:       raw,
                attrs:       new Uint32Array(raw.length),
                eol:         true,
                initialAttr: 0,
            };
            this.text = raw;
        }
    }

    setMaskPattern(pattern) {
        this.dimens.width = pattern.length;
        this.maskPattern = pattern;
        this.buildPattern();
        //  Reinitialize lineBuffer now that maxLength is updated
        this.lineBuffer = new LineBuffer({ width: this.maxLength });
    }

    getData() {
        const rawData = this.lineBuffer ? this.lineBuffer.getText() : super.getData();

        if (!rawData || 0 === rawData.length) {
            return rawData;
        }

        let data = '';
        let p    = 0;
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
                    this.patternArrayPos--;
                    assert(this.patternArrayPos >= 0);

                    if (_.isRegExp(this.patternArray[this.patternArrayPos])) {
                        //  Cursor is directly on an input slot — delete its char
                        this.lineBuffer.deleteChar(0, textLen - 1);
                        this._syncFromBuffer();
                        this.clientBackspace();
                    } else {
                        //  Cursor is on a literal — walk back to the preceding input slot
                        while (this.patternArrayPos >= 0) {
                            if (_.isRegExp(this.patternArray[this.patternArrayPos])) {
                                this.lineBuffer.deleteChar(
                                    0,
                                    this.lineBuffer.lines[0].chars.length - 1
                                );
                                this._syncFromBuffer();
                                this.client.term.write(
                                    ansi.goto(
                                        this.position.row,
                                        this.getEndOfTextColumn() + 1
                                    )
                                );
                                this.clientBackspace();
                                break;
                            }
                            this.patternArrayPos--;
                        }
                    }
                }

                return;

            } else if (this.isKeyMapped('clearLine', key.name)) {
                this.lineBuffer.lines[0] = {
                    chars: '', attrs: new Uint32Array(0), eol: true, initialAttr: 0,
                };
                this._syncFromBuffer();
                this.patternArrayPos = 0;
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
                this.patternArrayPos++;

                //  Skip over any literal characters in the pattern
                while (
                    this.patternArrayPos < this.patternArray.length &&
                    !_.isRegExp(this.patternArray[this.patternArrayPos])
                ) {
                    this.patternArrayPos++;
                }

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
