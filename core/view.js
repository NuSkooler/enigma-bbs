'use strict';

//  ENiGMA½
const events = require('events');
const ansi = require('./ansi_term.js');
const colorCodes = require('./color_codes.js');
const enigAssert = require('./enigma_assert.js');
const { renderSubstr } = require('./string_util.js');

//  deps
const _ = require('lodash');

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

class View extends events.EventEmitter {
    constructor(options) {
        super();

        enigAssert(_.isObject(options));
        enigAssert(_.isObject(options.client));

        this.client = options.client;
        this.cursor = options.cursor || 'show';
        this.cursorStyle = options.cursorStyle || 'default';

        this.acceptsFocus = options.acceptsFocus || false;
        this.acceptsInput = options.acceptsInput || false;
        this.autoAdjustHeight =
            _.get(options, 'dimens.height') != null
                ? false
                : _.get(options, 'autoAdjustHeight', true);
        this.position = { row: 0, col: 0 };
        this.textStyle = options.textStyle || 'normal';
        this.focusTextStyle = options.focusTextStyle || this.textStyle;
        this.offsetsApplied = false;

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

        //  Canonical SGR names are styleSGR1 (normal) and styleSGR2 (focus).
        //  ansiSGR / ansiFocusSGR are deprecated aliases kept for backwards compatibility.
        const defaultSGR = ansi.getSGRFromGraphicRendition({ fg: 39, bg: 49 }, true);
        this.styleSGR1 = options.styleSGR1 || options.ansiSGR || defaultSGR;
        this.styleSGR2 = options.styleSGR2 || options.ansiFocusSGR || this.styleSGR1;

        if (this.acceptsInput) {
            this.specialKeyMap = options.specialKeyMap || VIEW_SPECIAL_KEY_MAP_DEFAULT;

            if (_.isObject(options.specialKeyMapOverride)) {
                this.setSpecialKeyMapOverride(options.specialKeyMapOverride);
            }
        }
    }

    setId(id) {
        this.id = id;
    }

    getId() {
        return this.id;
    }

    getWidth() {
        return this.dimens.width;
    }

    getHeight() {
        return this.dimens.height;
    }

    isKeyMapped(keySet, keyName) {
        return (
            _.has(this.specialKeyMap, keySet) &&
            this.specialKeyMap[keySet].indexOf(keyName) > -1
        );
    }

    getANSIColor(color) {
        const sgr = [color.flags, color.fg];
        if (color.bg !== color.flags) {
            sgr.push(color.bg);
        }
        return ansi.sgr(sgr);
    }

    hideCursor() {
        this.client.term.rawWrite(ansi.hideCursor());
    }

    restoreCursor() {
        this.client.term.rawWrite(
            'show' === this.cursor ? ansi.showCursor() : ansi.hideCursor()
        );
    }

    initDefaultWidth(width = 15) {
        this.dimens.width =
            this.dimens.width ||
            Math.min(width, this.client.term.termWidth - this.position.col);
    }

    setPosition(pos) {
        //
        //  Allow the following forms: [row, col], { row : r, col : c }, or (row, col)
        //
        if (Array.isArray(pos)) {
            this.position.row = pos[0];
            this.position.col = pos[1];
        } else if (_.isNumber(pos.row) && _.isNumber(pos.col)) {
            this.position.row = pos.row;
            this.position.col = pos.col;
        } else if (2 === arguments.length) {
            this.position.row = parseInt(arguments[0], 10);
            this.position.col = parseInt(arguments[1], 10);
        }

        //  sanitize
        this.position.row = Math.max(this.position.row, 1);
        this.position.col = Math.max(this.position.col, 1);
        this.position.row = Math.min(this.position.row, this.client.term.termHeight);
        this.position.col = Math.min(this.position.col, this.client.term.termWidth);
    }

    setDimension(dimens) {
        enigAssert(
            _.isObject(dimens) && _.isNumber(dimens.height) && _.isNumber(dimens.width)
        );
        this.dimens = Object.assign({}, dimens);
        this.autoAdjustHeight = false;
    }

    setHeight(height) {
        height = parseInt(height) || 1;
        height = Math.min(height, this.client.term.termHeight);

        this.dimens.height = height;
        this.autoAdjustHeight = false;
    }

    setWidth(width) {
        width = parseInt(width) || 1;
        width = Math.min(width, this.client.term.termWidth - this.position.col);

        this.dimens.width = width;
    }

    getSGR() {
        return this.styleSGR1;
    }

    getStyleSGR(n) {
        n = parseInt(n) || 0;
        return this['styleSGR' + n];
    }

    getFocusSGR() {
        return this.styleSGR2;
    }

    setSpecialKeyMapOverride(specialKeyMapOverride) {
        this.specialKeyMap = Object.assign(this.specialKeyMap, specialKeyMapOverride);
    }

    setPropertyValue(propName, value) {
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
                }
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
    }

    redraw() {
        this.client.term.write(ansi.goto(this.position.row, this.position.col));
    }

    setFocusProperty(focused) {
        enigAssert(this.acceptsFocus || !focused, 'View does not accept focus');
        this.hasFocus = focused;
    }

    setFocus(focused) {
        this.setFocusProperty(focused);
        this.restoreCursor();
    }

    onKeyPress(ch, key) {
        enigAssert(this.hasFocus, 'View does not have focus');
        enigAssert(this.acceptsInput, 'View does not accept input');

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
    }

    getData() {
        return null;
    }

    //
    //  destroy() — called by ViewController when a view is being removed.
    //  Subclasses should override to clear timers, remove listeners, etc.
    //
    destroy() {}

    //
    //  reapplySGR() — called after an overlapping operation (e.g. TickerView tick)
    //  so the active view can re-assert its current SGR state on the terminal.
    //  Subclasses should override if they maintain terminal color state.
    //
    reapplySGR() {}
}

exports.View = View;
exports.VIEW_SPECIAL_KEY_MAP_DEFAULT = VIEW_SPECIAL_KEY_MAP_DEFAULT;
