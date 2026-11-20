'use strict';

//  ENiGMA½
const { View } = require('./view.js');
const miscUtil = require('./misc_util.js');
const ansi = require('./ansi_term.js');
const {
    pad: padStr,
    stylizeString,
    renderSubstr,
    renderFirstChar,
    renderStringLength,
    stripAllLineFeeds,
} = require('./string_util.js');
const { pipeToAnsi } = require('./color_codes.js');
const PipeCodes = require('./pipe_codes.js');
const { getPredefinedMCIFormatObject } = require('./predefined_mci');
const stringFormat = require('./string_format');

//  What drawText() writes is already rendered: only ANSI escapes are codes.
const ANSI_ONLY = { dialect: 'ansi' };

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

        this.fillChar = renderFirstChar(miscUtil.valueWithDefault(options.fillChar, ' '));
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
        let renderLength;
        if (this.itemFormat) {
            ({ text: textToDraw, width: renderLength } = PipeCodes.renderWithWidth(
                stringFormat(
                    this.hasFocus && this.focusItemFormat
                        ? this.focusItemFormat
                        : this.itemFormat,
                    {
                        text: this._formatValue(
                            stylizeString(
                                s,
                                this.hasFocus ? this.focusTextStyle : this.textStyle
                            )
                        ),
                    }
                )
            ));
        } else {
            textToDraw = _.isString(this.textMaskChar)
                ? new Array(renderStringLength(s, ANSI_ONLY) + 1).join(this.textMaskChar)
                : stylizeString(s, this.hasFocus ? this.focusTextStyle : this.textStyle);
            renderLength = renderStringLength(textToDraw, ANSI_ONLY);
        }

        //  the width of textToDraw, until it is cut
        let drawnLength = renderLength;

        if (renderLength >= this.dimens.width) {
            if (this.hasFocus) {
                if (this.horizScroll) {
                    textToDraw = renderSubstr(
                        textToDraw,
                        renderLength - this.dimens.width,
                        renderLength,
                        ANSI_ONLY
                    );
                    drawnLength = ANSI_ONLY;
                }
            } else {
                const overflowLength = this.textOverflow
                    ? renderStringLength(this.textOverflow, ANSI_ONLY)
                    : 0;
                if (
                    this.textOverflow &&
                    this.dimens.width > overflowLength &&
                    renderLength - overflowLength >= overflowLength
                ) {
                    textToDraw =
                        renderSubstr(
                            textToDraw,
                            0,
                            this.dimens.width - overflowLength,
                            ANSI_ONLY
                        ) + this.textOverflow;
                } else {
                    textToDraw = renderSubstr(
                        textToDraw,
                        0,
                        this.dimens.width,
                        ANSI_ONLY
                    );
                }
                drawnLength = ANSI_ONLY;
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
                drawnLength //  a known width, or measure it ANSI only
            ),
            false //  no converting CRLF needed
        );
    }

    //  The {text} value for an itemFormat. The format is rendered (its own
    //  codes are theme codes), but this.text has been rendered already: a
    //  pipe left in it is text, so every pipe is escaped and the text comes
    //  out of that render as it went in.
    _formatValue(s) {
        return PipeCodes.escape(s);
    }

    getEndOfTextColumn() {
        const offset = Math.min(
            renderStringLength(this.text, ANSI_ONLY),
            this.dimens.width
        );
        return this.position.col + offset;
    }

    redraw() {
        //
        //  A lot of views will get an initial redraw() with empty text (''). We can short
        //  circuit this by NOT doing any of the work if this is the initial drawText
        //  and there is no actual text (e.g. save SGR's and processing)
        //
        if (!this.hasDrawnOnce) {
            if (this.text === undefined) {
                return;
            }
        }
        this.hasDrawnOnce = true;

        super.redraw();

        if (_.isString(this.text)) {
            this.drawText(this.text);
        }
    }

    //  Virtual hook: subclasses override to place the cursor at their preferred
    //  position after a setFocus redraw (e.g. at an edit cursor rather than end-of-text).
    _positionCursor(_focused) {
        this.client.term.write(ansi.goto(this.position.row, this.getEndOfTextColumn()));
    }

    setFocus(focused) {
        super.setFocus(focused);

        this.redraw();

        this._positionCursor(focused);
        this.client.term.write(this.getFocusSGR());
    }

    //  Where setFocus(true) leaves the cursor and SGR, without drawing the
    //  text again
    restoreFocusPosition() {
        this._positionCursor(true);
        this.client.term.write(this.getFocusSGR());
    }

    getData() {
        return this.text;
    }

    setText(text, redraw) {
        redraw = _.isBoolean(redraw) ? redraw : true;

        if (text === undefined || null === text) {
            text = '';
        } else if (!_.isString(text)) {
            text = text.toString();
        }

        const formatObj = getPredefinedMCIFormatObject(this.client, text);
        if (formatObj) {
            //  measured with the client it is rendered with below
            text = stringFormat(text, formatObj, { client: this.client });
        }

        this.text = pipeToAnsi(stripAllLineFeeds(text), this.client);
        if (this.maxLength > 0) {
            this.text = renderSubstr(this.text, 0, this.maxLength, ANSI_ONLY);
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
            this.setText(this.fillChar.repeat(renderStringLength(this.text, ANSI_ONLY)));
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
                    this.textMaskChar =
                        this.client.currentTheme.helpers.getPasswordChar();
                }
                break;
        }

        super.setPropertyValue(propName, value);
    }
}

exports.TextView = TextView;
