'use strict';

//  ENiGMA½
const { TextView } = require('./text_view.js');
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

        this.buildPattern();
    }

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

    setText(text, redraw) {
        super.setText(text, redraw); //  pass through redraw; TextView ctor calls with false to suppress early redraw

        if (this.patternArray) {
            this.patternArrayPos = this.patternArray.length;
        }
    }

    setMaskPattern(pattern) {
        this.dimens.width = pattern.length;
        this.maskPattern = pattern;
        this.buildPattern();
    }

    onKeyPress(ch, key) {
        if (key) {
            if (this.isKeyMapped('backspace', key.name)) {
                if (this.text.length > 0) {
                    this.patternArrayPos--;
                    assert(this.patternArrayPos >= 0);

                    if (_.isRegExp(this.patternArray[this.patternArrayPos])) {
                        this.text = this.text.substr(0, this.text.length - 1);
                        this.clientBackspace();
                    } else {
                        while (this.patternArrayPos >= 0) {
                            if (_.isRegExp(this.patternArray[this.patternArrayPos])) {
                                this.text = this.text.substr(0, this.text.length - 1);
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
                this.text = '';
                this.patternArrayPos = 0;
                this.setFocus(true); //  redraw + adjust cursor

                return;
            }
        }

        if (ch && strUtil.isPrintable(ch)) {
            if (this.text.length < this.maxLength) {
                ch = strUtil.stylizeString(ch, this.textStyle);

                if (!ch.match(this.patternArray[this.patternArrayPos])) {
                    return;
                }

                this.text += ch;
                this.patternArrayPos++;

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

    setPropertyValue(propName, value) {
        switch (propName) {
            case 'maskPattern':
                this.setMaskPattern(value);
                break;
        }

        super.setPropertyValue(propName, value);
    }

    getData() {
        const rawData = super.getData();

        if (!rawData || 0 === rawData.length) {
            return rawData;
        }

        let data = '';

        assert(rawData.length <= this.patternArray.length);

        let p = 0;
        for (let i = 0; i < this.patternArray.length; ++i) {
            if (_.isRegExp(this.patternArray[i])) {
                data += rawData[p++];
            } else {
                data += this.patternArray[i];
            }
        }

        return data;
    }
}

MaskEditTextView.maskPatternCharacterRegEx = {
    '#': /[0-9]/, //  Numeric
    A: /[a-zA-Z]/, //  Alpha
    '@': /[0-9a-zA-Z]/, //  Alphanumeric
    '&': /[\w\d\s]/, //  Any "printable" 32-126, 128-255
};

exports.MaskEditTextView = MaskEditTextView;
