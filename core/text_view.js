'use strict';

//  ENiGMA½
const { View } = require('./view.js');
const miscUtil = require('./misc_util.js');
const ansi = require('./ansi_term.js');
const { pad: padStr, stylizeString, renderSubstr, renderStringLength, stripAllLineFeeds } = require('./string_util.js');
const { pipeToAnsi } = require('./color_codes.js');
const { getPredefinedMCIFormatObject } = require('./predefined_mci');
const stringFormat = require('./string_format');

//  deps
const _ = require('lodash');

class TextView extends View {
    constructor(options) {
        if (options.dimens) {
            options.dimens.height = 1; //  force height of 1 for TextView's & sub classes
        }

        super(options);

        if (options.maxLength) {
            this.maxLength = options.maxLength;
        } else {
            this.maxLength = this.client.term.termWidth - this.position.col;
        }

        this.fillChar = renderSubstr(miscUtil.valueWithDefault(options.fillChar, ' '), 0, 1);
        this.justify = options.justify || 'left';
        this.resizable = miscUtil.valueWithDefault(options.resizable, true);
        this.horizScroll = miscUtil.valueWithDefault(options.horizScroll, true);

        if (_.isString(options.textOverflow)) {
            this.textOverflow = options.textOverflow;
        }

        if (_.isString(options.textMaskChar) && 1 === options.textMaskChar.length) {
            this.textMaskChar = options.textMaskChar;
        }

        this.setText(options.text || '', false); //  false=do not redraw now
    }

    drawText(s) {
        //
        //                     |<- this.maxLength
        //   ABCDEFGHIJK
        //  |ABCDEFG|  ^_ this.text.length
        //          ^-- this.dimens.width
        //
        let textToDraw;
        if (this.itemFormat) {
            textToDraw = pipeToAnsi(
                stringFormat(
                    this.hasFocus && this.focusItemFormat
                        ? this.focusItemFormat
                        : this.itemFormat,
                    {
                        text: stylizeString(
                            s,
                            this.hasFocus ? this.focusTextStyle : this.textStyle
                        ),
                    }
                )
            );
        } else {
            textToDraw = _.isString(this.textMaskChar)
                ? new Array(renderStringLength(s) + 1).join(this.textMaskChar)
                : stylizeString(s, this.hasFocus ? this.focusTextStyle : this.textStyle);
        }

        const renderLength = renderStringLength(textToDraw);

        if (renderLength >= this.dimens.width) {
            if (this.hasFocus) {
                if (this.horizScroll) {
                    textToDraw = renderSubstr(
                        textToDraw,
                        renderLength - this.dimens.width,
                        renderLength
                    );
                }
            } else {
                if (
                    this.textOverflow &&
                    this.dimens.width > this.textOverflow.length &&
                    renderLength - this.textOverflow.length >= this.textOverflow.length
                ) {
                    textToDraw =
                        renderSubstr(
                            textToDraw,
                            0,
                            this.dimens.width - this.textOverflow.length
                        ) + this.textOverflow;
                } else {
                    textToDraw = renderSubstr(textToDraw, 0, this.dimens.width);
                }
            }
        }

        const renderedFillChar = pipeToAnsi(this.fillChar);

        this.client.term.write(
            padStr(
                textToDraw,
                this.dimens.width,
                renderedFillChar,
                this.justify,
                this.hasFocus ? this.getFocusSGR() : this.getSGR(),
                this.getStyleSGR(1) || this.getSGR(),
                true //  use render len
            ),
            false //  no converting CRLF needed
        );
    }

    getEndOfTextColumn() {
        const offset = Math.min(this.text.length, this.dimens.width);
        return this.position.col + offset;
    }

    redraw() {
        //
        //  A lot of views will get an initial redraw() with empty text (''). We can short
        //  circuit this by NOT doing any of the work if this is the initial drawText
        //  and there is no actual text (e.g. save SGR's and processing)
        //
        if (!this.hasDrawnOnce) {
            if (_.isUndefined(this.text)) {
                return;
            }
        }
        this.hasDrawnOnce = true;

        super.redraw();

        if (_.isString(this.text)) {
            this.drawText(this.text);
        }
    }

    setFocus(focused) {
        super.setFocus(focused);

        this.redraw();

        this.client.term.write(ansi.goto(this.position.row, this.getEndOfTextColumn()));
        this.client.term.write(this.getFocusSGR());
    }

    getData() {
        return this.text;
    }

    setText(text, redraw) {
        redraw = _.isBoolean(redraw) ? redraw : true;

        if (_.isUndefined(text) || null === text) {
            text = '';
        } else if (!_.isString(text)) {
            text = text.toString();
        }

        const formatObj = getPredefinedMCIFormatObject(this.client, text);
        if (formatObj) {
            text = stringFormat(text, formatObj);
        }

        this.text = pipeToAnsi(stripAllLineFeeds(text), this.client);
        if (this.maxLength > 0) {
            this.text = renderSubstr(this.text, 0, this.maxLength);
        }

        this.text = stylizeString(
            this.text,
            this.hasFocus ? this.focusTextStyle : this.textStyle
        );

        if (redraw) {
            this.redraw();
        }
    }

    clearText() {
        if (this.text) {
            this.setText(this.fillChar.repeat(this.text.length));
        }

        this.setText('');
    }

    setPropertyValue(propName, value) {
        switch (propName) {
            case 'textMaskChar':
                this.textMaskChar = value.substr(0, 1);
                break;
            case 'textOverflow':
                this.textOverflow = value;
                break;
            case 'maxLength':
                this.maxLength = parseInt(value, 10);
                break;
            case 'password':
                if (true === value) {
                    this.textMaskChar = this.client.currentTheme.helpers.getPasswordChar();
                }
                break;
        }

        super.setPropertyValue(propName, value);
    }
}

exports.TextView = TextView;
