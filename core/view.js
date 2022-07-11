/* jslint node: true */
'use strict';

//  ENiGMA½
const events = require('events');
const util = require('util');
const ansi = require('./ansi_term.js');
const colorCodes = require('./color_codes.js');
const enigAssert = require('./enigma_assert.js');
const { renderSubstr } = require('./string_util.js');

//  deps
const _ = require('lodash');

exports.View = View;

const VIEW_SPECIAL_KEY_MAP_DEFAULT = {
    accept: ['return'],
    exit: ['esc'],
    backspace: ['backspace', 'del', 'ctrl + d'], //  https://www.tecmint.com/linux-command-line-bash-shortcut-keys/
    del: ['del'],
    next: ['tab'],
    up: ['up arrow'],
    down: ['down arrow'],
    end: ['end'],
    home: ['home'],
    left: ['left arrow'],
    right: ['right arrow'],
    clearLine: ['ctrl + y'],
};

exports.VIEW_SPECIAL_KEY_MAP_DEFAULT = VIEW_SPECIAL_KEY_MAP_DEFAULT;

function View(options) {
    events.EventEmitter.call(this);

    enigAssert(_.isObject(options));
    enigAssert(_.isObject(options.client));

    this.client = options.client;
    this.cursor = options.cursor || 'show';
    this.cursorStyle = options.cursorStyle || 'default';

    this.acceptsFocus = options.acceptsFocus || false;
    this.acceptsInput = options.acceptsInput || false;
    this.autoAdjustHeight = _.get(options, 'dimens.height')
        ? false
        : _.get(options, 'autoAdjustHeight', true);
    this.position = { x: 0, y: 0 };
    this.textStyle = options.textStyle || 'normal';
    this.focusTextStyle = options.focusTextStyle || this.textStyle;

    if (options.id) {
        this.setId(options.id);
    }

    if (options.position) {
        this.setPosition(options.position);
    }

    if (options.dimens) {
        this.setDimension(options.dimens);
    } else {
        this.dimens = {
            width: options.width || 0,
            height: 0,
        };
    }

    //  :TODO: Just use styleSGRx for these, e.g. styleSGR0, styleSGR1 = norm/focus
    this.ansiSGR =
        options.ansiSGR || ansi.getSGRFromGraphicRendition({ fg: 39, bg: 49 }, true);
    this.ansiFocusSGR = options.ansiFocusSGR || this.ansiSGR;

    this.styleSGR1 = options.styleSGR1 || this.ansiSGR;
    this.styleSGR2 = options.styleSGR2 || this.ansiFocusSGR;

    if (this.acceptsInput) {
        this.specialKeyMap = options.specialKeyMap || VIEW_SPECIAL_KEY_MAP_DEFAULT;

        if (_.isObject(options.specialKeyMapOverride)) {
            this.setSpecialKeyMapOverride(options.specialKeyMapOverride);
        }
    }

    this.isKeyMapped = function (keySet, keyName) {
        return (
            _.has(this.specialKeyMap, keySet) &&
            this.specialKeyMap[keySet].indexOf(keyName) > -1
        );
    };

    this.getANSIColor = function (color) {
        var sgr = [color.flags, color.fg];
        if (color.bg !== color.flags) {
            sgr.push(color.bg);
        }
        return ansi.sgr(sgr);
    };

    this.hideCusor = function () {
        this.client.term.rawWrite(ansi.hideCursor());
    };

    this.restoreCursor = function () {
        //this.client.term.write(ansi.setCursorStyle(this.cursorStyle));
        this.client.term.rawWrite(
            'show' === this.cursor ? ansi.showCursor() : ansi.hideCursor()
        );
    };

    this.initDefaultWidth = function (width = 15) {
        this.dimens.width =
            this.dimens.width ||
            Math.min(width, this.client.term.termWidth - this.position.col);
    };
}

util.inherits(View, events.EventEmitter);

View.prototype.setId = function (id) {
    this.id = id;
};

View.prototype.getId = function () {
    return this.id;
};

View.prototype.setPosition = function (pos) {
    //
    //  Allow the following forms: [row, col], { row : r, col : c }, or (row, col)
    //
    if (util.isArray(pos)) {
        this.position.row = pos[0];
        this.position.col = pos[1];
    } else if (_.isNumber(pos.row) && _.isNumber(pos.col)) {
        this.position.row = pos.row;
        this.position.col = pos.col;
    } else if (2 === arguments.length) {
        this.position.row = parseInt(arguments[0], 10);
        this.position.col = parseInt(arguments[1], 10);
    }

    //  sanatize
    this.position.row = Math.max(this.position.row, 1);
    this.position.col = Math.max(this.position.col, 1);
    this.position.row = Math.min(this.position.row, this.client.term.termHeight);
    this.position.col = Math.min(this.position.col, this.client.term.termWidth);
};

View.prototype.setDimension = function (dimens) {
    enigAssert(
        _.isObject(dimens) && _.isNumber(dimens.height) && _.isNumber(dimens.width)
    );
    this.dimens = dimens;
    this.autoAdjustHeight = false;
};

View.prototype.setHeight = function (height) {
    height = parseInt(height) || 1;
    height = Math.min(height, this.client.term.termHeight);

    this.dimens.height = height;
    this.autoAdjustHeight = false;
};

View.prototype.setWidth = function (width) {
    width = parseInt(width) || 1;
    width = Math.min(width, this.client.term.termWidth - this.position.col);

    this.dimens.width = width;
};

View.prototype.getSGR = function () {
    return this.ansiSGR;
};

View.prototype.getStyleSGR = function (n) {
    n = parseInt(n) || 0;
    return this['styleSGR' + n];
};

View.prototype.getFocusSGR = function () {
    return this.ansiFocusSGR;
};

View.prototype.setSpecialKeyMapOverride = function (specialKeyMapOverride) {
    this.specialKeyMap = Object.assign(this.specialKeyMap, specialKeyMapOverride);
};

View.prototype.setPropertyValue = function (propName, value) {
    switch (propName) {
        case 'acceptsFocus':
            if (_.isBoolean(value)) {
                this.acceptsFocus = value;
            }
            break;

        case 'height':
            this.setHeight(value);
            break;
        case 'width':
            this.setWidth(value);
            break;
        case 'focus':
            this.setFocusProperty(value);
            break;

        case 'text':
            if ('setText' in this) {
                this.setText(value);
            }
            break;

        case 'textStyle':
            this.textStyle = value;
            break;
        case 'focusTextStyle':
            this.focusTextStyle = value;
            break;

        case 'justify':
            this.justify = value;
            break;

        case 'fillChar':
            if ('fillChar' in this) {
                if (_.isNumber(value)) {
                    this.fillChar = String.fromCharCode(value);
                } else if (_.isString(value)) {
                    this.fillChar = renderSubstr(value, 0, 1);
                }
            }
            break;

        case 'submit':
            if (_.isBoolean(value)) {
                this.submit = value;
            } /* else {
                this.submit = _.isArray(value) && value.length > 0;
            }
            */
            break;

        case 'resizable':
            if (_.isBoolean(value)) {
                this.resizable = value;
            }
            break;

        case 'argName':
            this.submitArgName = value;
            break;

        case 'omit':
            if (_.isBoolean(value)) {
                this.omitFromSubmission = value;
                break;
            }
            break;

        case 'validate':
            if (_.isFunction(value)) {
                this.validate = value;
            }
            break;
    }

    if (/styleSGR[0-9]{1,2}/.test(propName)) {
        if (_.isObject(value)) {
            this[propName] = ansi.getSGRFromGraphicRendition(value, true);
        } else if (_.isString(value)) {
            this[propName] = colorCodes.pipeToAnsi(value);
        }
    }
};

View.prototype.redraw = function () {
    this.client.term.write(ansi.goto(this.position.row, this.position.col));
};

View.prototype.setFocusProperty = function (focused) {
    // Either this should accept focus, or the focus should be false
    enigAssert(this.acceptsFocus || !focused, 'View does not accept focus');
    this.hasFocus = focused;
};

View.prototype.setFocus = function (focused) {
    // Call separate method to differentiate between a value set as a
    // property vs focus programmatically called.
    this.setFocusProperty(focused);
    this.restoreCursor();
};

View.prototype.onKeyPress = function (ch, key) {
    enigAssert(this.hasFocus, 'View does not have focus');
    enigAssert(this.acceptsInput, 'View does not accept input');

    if (!this.hasFocus || !this.acceptsInput) {
        return;
    }

    if (key) {
        enigAssert(this.specialKeyMap, 'No special key map defined');

        if (this.isKeyMapped('accept', key.name)) {
            this.emit('action', 'accept', key);
        } else if (this.isKeyMapped('next', key.name)) {
            this.emit('action', 'next', key);
        }
    }

    if (ch) {
        enigAssert(1 === ch.length);
    }

    this.emit('key press', ch, key);
};

View.prototype.getData = function () {};
