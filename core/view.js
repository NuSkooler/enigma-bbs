'use strict';

//  ENiGMA½
const events = require('events');
const ansi = require('./ansi_term.js');
const colorCodes = require('./color_codes.js');
const enigAssert = require('./enigma_assert.js');
const {
    renderFirstChar,
    renderStringLength,
    renderSplitPos,
} = require('./string_util.js');

const ANSI_ONLY = { dialect: 'ansi' };

//  deps
const _ = require('lodash');

//
//  The view each client is typing into: the last one given focus, until it
//  loses focus or its form is torn down (ViewController.detachClientEvents()).
//  Kept per client rather than per ViewController because one screen can be
//  several forms: a menu's art and its prompt load into two controllers, and
//  a view drawing on a timer (TickerView) in one has to find the field in the
//  other. Weak so that a client that goes away takes its entry with it.
//
const inputFocusViews = new WeakMap();

//  client -> tokens from suspendInputFocus() not yet resumed; a token's
//  view is cleared if that view is released while it is set aside
const suspendedInputFocus = new WeakMap();

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

    //
    //  |text| cut off at the terminal's right edge when drawn from |col|.
    //  Past the edge the terminal wraps it onto the next row, over whatever
    //  is drawn there; on a narrow terminal that garbles a whole list. |text|
    //  is already rendered: only ANSI escapes are codes.
    //
    clipToTerminalWidth(text, col = this.position.col) {
        const available = this.client.term.termWidth - col + 1;
        if (!(available > 0) || renderStringLength(text, ANSI_ONLY) <= available) {
            return text;
        }
        return text.slice(0, renderSplitPos(text, available, false)) + this.getSGR();
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

            case 'acceptsInput':
                if (_.isBoolean(value)) {
                    this.acceptsInput = value;
                }
                break;

            case 'height':
                this.setHeight(value);
                break;
            case 'width':
                this.setWidth(value);
                break;
            case 'focus':
                //  The MCI config's `focus: true` only marks the view: the
                //  form focuses it for real when it has loaded (switchFocus()
                //  in loadFromMenuConfig() / loadFromPromptConfig()), and
                //  that is what makes it the input focus view. Marked here
                //  it would be tracked before its form is shown, or even if
                //  the form never focuses it.
                enigAssert(this.acceptsFocus || !value, 'View does not accept focus');
                this.hasFocus = value;
                if (!value) {
                    View.releaseInputFocus(this);
                }
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
                        this.fillChar = renderFirstChar(value);
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

        if (focused) {
            inputFocusViews.set(this.client, this);
        } else {
            View.releaseInputFocus(this);
        }
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

    //  ── Input focus & background redraws ─────────────────────────────────────

    //
    //  The view |client| is typing into, or null: the view last given focus,
    //  on any of the screen's forms, while it still holds it.
    //
    static getInputFocusView(client) {
        const view = inputFocusViews.get(client);
        return view && view.hasFocus ? view : null;
    }

    //  |view| no longer takes input; a no-op unless it is the one that did
    //  (or is the one a suspendInputFocus() set aside)
    static releaseInputFocus(view) {
        if (!view || !view.client) {
            return;
        }
        if (inputFocusViews.get(view.client) === view) {
            inputFocusViews.delete(view.client);
        }
        (suspendedInputFocus.get(view.client) || []).forEach(token => {
            if (token.view === view) {
                token.view = null;
            }
        });
    }

    //
    //  Set the client's input focus view aside while something that takes
    //  no typing owns the screen, such as a pause prompt waiting for its
    //  key: the forms under it stay attached and their field keeps
    //  hasFocus, but it is not on screen and a background draw (the pause
    //  prompt's own ticker) must not put the cursor there. Returns a token
    //  for resumeInputFocus().
    //
    static suspendInputFocus(client) {
        const token = { view: View.getInputFocusView(client) };
        inputFocusViews.delete(client);

        const tokens = suspendedInputFocus.get(client) || [];
        tokens.push(token);
        suspendedInputFocus.set(client, tokens);
        return token;
    }

    //
    //  Give back what suspendInputFocus() set aside: only if no view has
    //  taken focus since, and the view set aside still has it and was not
    //  released meanwhile (its form torn down).
    //
    static resumeInputFocus(client, token) {
        if (!token) {
            return;
        }
        const tokens = suspendedInputFocus.get(client) || [];
        const i = tokens.indexOf(token);
        if (i > -1) {
            tokens.splice(i, 1);
        }

        const view = token.view;
        token.view = null;
        if (view && view.hasFocus && !View.getInputFocusView(client)) {
            inputFocusViews.set(client, view);
        }
    }

    //
    //  restoreFocusPosition() -- put the terminal cursor back where this view,
    //  holding focus, echoes the next key, in the SGR it echoes it with. The
    //  base view knows nothing about where its cursor goes, so it does
    //  nothing; views that do know (TextView, EditTextView,
    //  MultiLineEditTextView) override this.
    //
    restoreFocusPosition() {}

    //
    //  restoreFocusCursor() -- called on the view holding input focus after
    //  something else has drawn over the screen and hidden the cursor (see
    //  drawInBackground()): restoreFocusPosition(), then make the cursor
    //  visible or not as this view wants.
    //
    restoreFocusCursor() {
        this.restoreFocusPosition();
        this.restoreCursor();
    }

    //
    //  drawInBackground() -- run drawFn(), which draws this view, for a
    //  redraw nobody typed for: a timer firing (a TickerView tick). Drawing
    //  moves the terminal cursor and leaves this view's SGR set, while the
    //  user may be typing into a field elsewhere on the screen, and a field
    //  echoes the next key at the cursor in whatever SGR is current
    //  (EditTextView's append fast path). So the view holding input focus is
    //  asked to put both back afterwards (restoreFocusCursor()), the cursor
    //  is hidden while this view draws, and all of it goes out in one socket
    //  write, so the cursor does not visibly jump. With no view holding focus
    //  the cursor is left where drawFn() leaves it, as it always was; that
    //  includes a pause prompt waiting for its key, which sets the input
    //  focus aside (suspendInputFocus()) even when a form under it still
    //  has a focused field.
    //
    //  The terminal's own save/restore (CSI s / CSI u, ESC 7 / ESC 8) is not
    //  used: CSI s does not save attributes, and support for either varies
    //  between the terminals BBS callers use.
    //
    drawInBackground(drawFn) {
        const term = this.client.term;
        const focusView = View.getInputFocusView(this.client);
        const batch = _.isFunction(term.beginWrite) && _.isFunction(term.commitWrite);

        if (batch) {
            term.beginWrite();
        }

        try {
            if (focusView) {
                term.rawWrite(ansi.hideCursor());
            }

            try {
                drawFn();
            } finally {
                //  Also when drawFn() threw (the error still goes to the
                //  caller): the cursor is never left hidden. Asked again, as
                //  drawFn() may have moved focus (a module's draw).
                const focusAfter = View.getInputFocusView(this.client);
                if (focusAfter) {
                    focusAfter.restoreFocusCursor();
                } else if (focusView) {
                    focusView.restoreCursor(); //  undo the hide, at least
                }
            }
        } finally {
            if (batch) {
                term.commitWrite();
            }
        }
    }
}

exports.View = View;
exports.VIEW_SPECIAL_KEY_MAP_DEFAULT = VIEW_SPECIAL_KEY_MAP_DEFAULT;
