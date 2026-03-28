'use strict';

//  ENiGMA½
const { TextView } = require('./text_view.js');
const miscUtil = require('./misc_util.js');
const strUtil = require('./string_util.js');

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
        options.cursorStyle = miscUtil.valueWithDefault(options.cursorStyle, 'steady block');
        options.resizable = false;

        if (!_.isObject(options.specialKeyMap)) {
            options.specialKeyMap = EDIT_TEXT_VIEW_KEY_MAP;
        }

        super(options);

        this.initDefaultWidth();
        this.cursorPos = { row: 0, col: 0 };
    }

    clientBackspace() {
        this.text = this.text.substr(0, this.text.length - 1);

        if (this.text.length >= this.dimens.width) {
            this.redraw();
        } else {
            this.cursorPos.col -= 1;
            if (this.cursorPos.col >= 0) {
                const fillCharSGR = this.getStyleSGR(1) || this.getSGR();
                this.client.term.write(
                    `\b${fillCharSGR}${this.fillChar}\b${this.getFocusSGR()}`
                );
            }
        }
    }

    onKeyPress(ch, key) {
        if (key) {
            if (this.isKeyMapped('backspace', key.name)) {
                if (this.text.length > 0) {
                    this.clientBackspace();
                }

                return super.onKeyPress(ch, key);
            } else if (this.isKeyMapped('delete', key.name)) {
                //  Some (mostly older) terms send 'delete' for Backspace.
                //  if we're at the end of the line, go ahead and treat them the same
                if (this.text.length > 0 && this.cursorPos.col === this.text.length) {
                    this.clientBackspace();
                }
            } else if (this.isKeyMapped('clearLine', key.name)) {
                this.text = '';
                this.cursorPos.col = 0;
                this.setFocus(true); //  resetting focus will redraw & adjust cursor

                return super.onKeyPress(ch, key);
            }
        }

        if (ch && strUtil.isPrintable(ch)) {
            if (this.text.length < this.maxLength) {
                ch = strUtil.stylizeString(ch, this.textStyle);

                this.text += ch;

                if (this.text.length > this.dimens.width) {
                    //  no shortcuts - redraw the view
                    this.redraw();
                } else {
                    this.cursorPos.col += 1;

                    if (_.isString(this.textMaskChar)) {
                        if (this.textMaskChar.length > 0) {
                            this.client.term.write(this.textMaskChar);
                        }
                    } else {
                        this.client.term.write(ch);
                    }
                }
            }
        }

        super.onKeyPress(ch, key);
    }

    setText(text) {
        super.setText(text);

        //  adjust local cursor tracking
        this.cursorPos = { row: 0, col: text.length };
    }
}

exports.EditTextView = EditTextView;
