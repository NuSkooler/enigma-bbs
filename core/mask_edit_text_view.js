/* jslint node: true */
'use strict';

var TextView = require('./text_view.js').TextView;
var miscUtil = require('./misc_util.js');
var strUtil = require('./string_util.js');
var ansi = require('./ansi_term.js');

//var util          = require('util');
var assert = require('assert');
var _ = require('lodash');

exports.MaskEditTextView = MaskEditTextView;

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

function MaskEditTextView(options) {
    options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
    options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);
    options.cursorStyle = miscUtil.valueWithDefault(options.cursorStyle, 'steady block');
    options.resizable = false;

    TextView.call(this, options);

    this.initDefaultWidth();

    this.cursorPos = { x: 0 };
    this.patternArrayPos = 0;

    var self = this;

    this.maskPattern = options.maskPattern || '';

    this.clientBackspace = function () {
        var fillCharSGR = this.getStyleSGR(3) || this.getSGR();
        this.client.term.write(
            '\b' + fillCharSGR + this.fillChar + '\b' + this.getFocusSGR()
        );
    };

    this.drawText = function (s) {
        var textToDraw = strUtil.stylizeString(
            s,
            this.hasFocus ? this.focusTextStyle : this.textStyle
        );

        assert(textToDraw.length <= self.patternArray.length);

        //  draw out the text we have so far
        var i = 0;
        var t = 0;
        while (i < self.patternArray.length) {
            if (_.isRegExp(self.patternArray[i])) {
                if (t < textToDraw.length) {
                    self.client.term.write(
                        (self.hasFocus ? self.getFocusSGR() : self.getSGR()) +
                            textToDraw[t]
                    );
                    t++;
                } else {
                    self.client.term.write((self.getStyleSGR(3) || '') + self.fillChar);
                }
            } else {
                var styleSgr = this.hasFocus
                    ? self.getStyleSGR(2) || ''
                    : self.getStyleSGR(1) || '';
                self.client.term.write(styleSgr + self.maskPattern[i]);
            }
            i++;
        }
    };

    this.buildPattern = function () {
        self.patternArray = [];
        self.maxLength = 0;

        for (var i = 0; i < self.maskPattern.length; i++) {
            //  :TODO: support escaped characters, e.g. \#. Also allow \\ for a '\' mark!
            if (self.maskPattern[i] in MaskEditTextView.maskPatternCharacterRegEx) {
                self.patternArray.push(
                    MaskEditTextView.maskPatternCharacterRegEx[self.maskPattern[i]]
                );
                ++self.maxLength;
            } else {
                self.patternArray.push(self.maskPattern[i]);
            }
        }
    };

    this.getEndOfTextColumn = function () {
        return this.position.col + this.patternArrayPos;
    };

    this.buildPattern();
}

require('util').inherits(MaskEditTextView, TextView);

MaskEditTextView.maskPatternCharacterRegEx = {
    '#': /[0-9]/, //  Numeric
    A: /[a-zA-Z]/, //  Alpha
    '@': /[0-9a-zA-Z]/, //  Alphanumeric
    '&': /[\w\d\s]/, //  Any "printable" 32-126, 128-255
};

MaskEditTextView.prototype.setText = function (text) {
    MaskEditTextView.super_.prototype.setText.call(this, text);

    if (this.patternArray) {
        //  :TODO: This is a hack - see TextView ctor note about setText()
        this.patternArrayPos = this.patternArray.length;
    }
};

MaskEditTextView.prototype.setMaskPattern = function (pattern) {
    this.dimens.width = pattern.length;

    this.maskPattern = pattern;
    this.buildPattern();
};

MaskEditTextView.prototype.onKeyPress = function (ch, key) {
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

    MaskEditTextView.super_.prototype.onKeyPress.call(this, ch, key);
};

MaskEditTextView.prototype.setPropertyValue = function (propName, value) {
    switch (propName) {
        case 'maskPattern':
            this.setMaskPattern(value);
            break;
    }

    MaskEditTextView.super_.prototype.setPropertyValue.call(this, propName, value);
};

MaskEditTextView.prototype.getData = function () {
    var rawData = MaskEditTextView.super_.prototype.getData.call(this);

    if (!rawData || 0 === rawData.length) {
        return rawData;
    }

    var data = '';

    assert(rawData.length <= this.patternArray.length);

    var p = 0;
    for (var i = 0; i < this.patternArray.length; ++i) {
        if (_.isRegExp(this.patternArray[i])) {
            data += rawData[p++];
        } else {
            data += this.patternArray[i];
        }
    }

    return data;
};
