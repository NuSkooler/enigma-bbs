'use strict';

//  ENiGMA½
const events = require('events');
const ansi = require('./ansi_term.js');
const colorCodes = require('./color_codes.js');
const enigAssert = require('./enigma_assert.js');
const { getViewForm, isFormOfMenu, isFormPaused } = require('./form_state.js');
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

//  client -> { tokens: [ token ], missed: Set<View> } while something covers
//  the screen: see suspendBackgroundDraw()
const suspendedBackgroundDraw = new WeakMap();

//  client -> the last number handed out by nextBackgroundSeq(). Each view
//  takes one when it is created and each suspend token when it is taken,
//  so a suspend can tell the views it covers (created before it) from those
//  drawn inside the cover (a ticker in an interrupt's pause prompt).
const backgroundSeqs = new WeakMap();

//  view -> the seq it took when created. Kept here, not on the view, so no
//  property name is taken from a mod's View subclass (nor below).
const viewBackgroundSeqs = new WeakMap();

//  views that have been destroyed: no background redraw is owed to them
const destroyedViews = new WeakSet();

//  view -> Set of functions run once when it is destroyed: see onDestroyed()
const destroyHooks = new WeakMap();

//  client -> the seq of the latest suspend taken: see View.coverMark()
const lastCoverMarks = new WeakMap();

//  view -> Set of interval handles from setBackgroundInterval()
const backgroundIntervals = new WeakMap();

//  views with the `pauseWhenInactive` mci property: their background timer
//  (setBackgroundInterval()) does not run while their form is inactive or
//  covered
const pauseWhenInactiveViews = new WeakSet();

//  pauseWhenInactive views that skipped a tick: redrawn once when their
//  form is activated (redrawPausedView())
const pausedMissedViews = new WeakSet();

function nextBackgroundSeq(client) {
    const seq = (backgroundSeqs.get(client) || 0) + 1;
    backgroundSeqs.set(client, seq);
    return seq;
}

//  terms whose drips cover background drawing: see coverDrips()
const dripCoveredTerms = new WeakSet();

//
//  A drip (baud emulated art: ClientTerminal dripWrite() and the like) is
//  a cover for background drawing: while it is in flight, views that
//  existed when it began do not draw on their own (a %TK tick drawn
//  between two pieces of the art would move the cursor the art carries on
//  from, and on PETSCII or ATASCII would be translated against the wrong
//  state), and a view that missed a draw is drawn once when the drip is
//  over. It is the same suspend as suspendBackgroundDraw(), one token per
//  drip, so drips nest with each other and with covers. Set up on a
//  client's terminal when its first view is created.
//
function coverDrips(client) {
    const term = client.term;
    if (!term || !_.isFunction(term.setDripCover) || dripCoveredTerms.has(term)) {
        return;
    }
    dripCoveredTerms.add(term);
    term.setDripCover({
        begin: () => View.suspendBackgroundDraw(client),
        end: token => View.resumeBackgroundDraw(client, token),
    });
}

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
        //  see suspendBackgroundDraw(): which covers this view is under
        viewBackgroundSeqs.set(this, nextBackgroundSeq(this.client));
        coverDrips(this.client);
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

            case 'pauseWhenInactive':
                if (true === value) {
                    pauseWhenInactiveViews.add(this);
                } else if (false === value) {
                    pauseWhenInactiveViews.delete(this);
                    pausedMissedViews.delete(this);
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
    //  Subclasses should override to clear timers, remove listeners, etc.,
    //  and call super.destroy().
    //
    destroy() {
        this.clearBackgroundIntervals();
        View.markDestroyed(this);
    }

    //
    //  setBackgroundInterval(fn, ms) -- a timer for a view that draws on its
    //  own (a ticker, a clock). Every |ms|, fn() is called; it updates the
    //  view's state and returns a function that draws the change, or
    //  nothing when there is nothing to draw. That function is run through
    //  drawInBackground(), so the cursor goes back to the field being typed
    //  into and nothing is drawn while the screen is covered. destroy()
    //  clears the timer; so does clearBackgroundInterval(handle). Returns
    //  the handle (the setInterval() timer), or null for a view that has
    //  been destroyed: no timer is started for it.
    //
    //  A view with `pauseWhenInactive` set skips its ticks entirely (fn is
    //  not called, so a ticker does not move on unseen) while its form is
    //  inactive or covered (ViewController deactivate() / cover()); it is
    //  redrawn once its form is activated, and by any redraw owed to it
    //  meanwhile (the end of a cover).
    //
    setBackgroundInterval(fn, ms) {
        if (destroyedViews.has(this)) {
            return null;
        }

        let intervals = backgroundIntervals.get(this);
        if (!intervals) {
            intervals = new Set();
            backgroundIntervals.set(this, intervals);
        }

        const handle = setInterval(() => {
            if (skipPausedTick(this)) {
                return;
            }
            const drawFn = fn();
            if (_.isFunction(drawFn)) {
                this.drawInBackground(drawFn);
            }
        }, ms);
        intervals.add(handle);
        return handle;
    }

    clearBackgroundInterval(handle) {
        const intervals = backgroundIntervals.get(this);
        if (intervals) {
            intervals.delete(handle);
        }
        clearInterval(handle);
    }

    clearBackgroundIntervals() {
        const intervals = backgroundIntervals.get(this);
        if (intervals) {
            intervals.forEach(handle => clearInterval(handle));
            intervals.clear();
        }
    }

    //
    //  |view| is gone: no background redraw is owed to it. Called by
    //  destroy(), and by ViewController after it destroys a view, so a
    //  subclass whose destroy() does not call super is still marked.
    //
    static markDestroyed(view) {
        destroyedViews.add(view);
        const suspended = suspendedBackgroundDraw.get(view.client);
        if (suspended) {
            suspended.missed.delete(view);
        }

        const hooks = destroyHooks.get(view);
        if (hooks) {
            destroyHooks.delete(view);
            hooks.forEach(fn => {
                try {
                    fn(view);
                } catch (e) {
                    const log = view.client && view.client.log;
                    if (log && _.isFunction(log.warn)) {
                        log.warn(
                            { error: e.message, viewId: view.id },
                            'View destroy hook failed'
                        );
                    }
                }
            });
        }
    }

    //
    //  Run fn(view) once when |view| is destroyed (markDestroyed(): its
    //  destroy(), or its form's teardown, whichever comes first). For
    //  something kept outside the view that must not outlive it, such as
    //  the frame clock's registration (core/frame_clock.js). Returns a
    //  function that removes the hook, or null if |view| is destroyed
    //  already (fn is not called).
    //
    static onDestroyed(view, fn) {
        if (destroyedViews.has(view)) {
            return null;
        }
        let hooks = destroyHooks.get(view);
        if (!hooks) {
            hooks = new Set();
            destroyHooks.set(view, hooks);
        }
        hooks.add(fn);
        return () => {
            hooks.delete(fn);
        };
    }

    //  True once |view| has been destroyed (destroy(), or torn down by its form)
    static isDestroyed(view) {
        return destroyedViews.has(view);
    }

    //
    //  forceNextRedraw() -- the next redraw() must draw in full, even where
    //  the view would skip output it believes is already on screen (a
    //  TickerView frame equal to the last one). Called before the redraw
    //  owed after a background draw suspend, when the screen under the view
    //  has been drawn over. The base view caches nothing.
    //
    forceNextRedraw() {}

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
    //  Stop background drawing (drawInBackground()) for |client| while
    //  something covers the screen: an interrupt, a help page. A covered
    //  view that would have drawn meanwhile is noted, and once no suspend
    //  covers it any more (resumeBackgroundDraw()) it gets one full redraw,
    //  if it is still alive. Suspends nest; returns a token.
    //
    //  Which views a suspend covers depends on its |scope|:
    //
    //  - none (the default; drips, and covers with no owner): the views
    //    that already exist. A view created after the most recent such
    //    suspend still held (a ticker in the cover's own pause prompt)
    //    draws as usual.
    //  - { menu }: the same, and also every view on a form of |menu| (one
    //    of its viewControllers at the time of the draw), whenever it was
    //    created: a form the covered menu builds while the cover is up (art
    //    that finished loading under an interrupt) does not draw over it.
    //    Views on no menu's form (a theme's temporary prompt, a mod's bare
    //    view) follow the default rule, so a pause prompt inside the cover
    //    still animates. Core's interrupt cover uses this.
    //  - { forms: [ vc, ... ] }: only the views of those forms
    //    (ViewController.cover()); nothing else on the screen is affected.
    //
    static suspendBackgroundDraw(client, scope) {
        const token = { seq: nextBackgroundSeq(client) };
        if (scope && Array.isArray(scope.forms)) {
            token.forms = new Set(scope.forms.filter(Boolean));
        } else if (scope && scope.menu) {
            token.menu = scope.menu;
        }
        lastCoverMarks.set(client, token.seq);
        let suspended = suspendedBackgroundDraw.get(client);
        if (!suspended) {
            suspended = { tokens: [], missed: new Set() };
            suspendedBackgroundDraw.set(client, suspended);
        }
        suspended.tokens.push(token);
        return token;
    }

    //
    //  A value that changes each time something starts covering |client|'s
    //  screen. A view that skips output it believes is already on screen
    //  (a TickerView frame equal to the last) compares it with the value at
    //  its last draw: after a cover, what it drew may have been drawn over,
    //  so its next draw is a full one even if nothing changed.
    //
    static coverMark(client) {
        return lastCoverMarks.get(client) || 0;
    }

    static isBackgroundDrawSuspended(client) {
        return suspendedBackgroundDraw.has(client);
    }

    //
    //  True while a suspend covers this view (see suspendBackgroundDraw()):
    //  a { forms } suspend naming its form, a { menu } suspend for the menu
    //  its form belongs to, or -- by creation order -- the most recent of
    //  the other suspends still held was taken after the view was created.
    //  Nested covers: a view created under cover A but before cover B is
    //  covered while B is held, and draws again once only A is.
    //
    isBackgroundDrawSuspended() {
        const suspended = suspendedBackgroundDraw.get(this.client);
        if (!suspended) {
            return false;
        }

        const form = getViewForm(this);
        let top = null; //  most recent suspend that goes by creation order
        for (let i = suspended.tokens.length - 1; i >= 0; --i) {
            const token = suspended.tokens[i];
            if (token.forms) {
                if (form && token.forms.has(form)) {
                    return true;
                }
                continue; //  covers nothing else
            }
            if (token.menu && isFormOfMenu(form, token.menu)) {
                return true;
            }
            if (!top) {
                top = token;
            }
        }
        return top ? (viewBackgroundSeqs.get(this) || 0) < top.seq : false;
    }

    //
    //  Give back a suspendBackgroundDraw() token; a token not held (or
    //  given back already) is ignored. Each view that missed a draw and is
    //  no longer covered is redrawn, through drawInBackground() so the
    //  cursor goes back to the field being typed into -- unless
    //  |options.redrawMissed| is false: the caller replaces the screen next
    //  (a reload after an interrupt) and a redraw would only flash.
    //
    static resumeBackgroundDraw(client, token, options) {
        const suspended = suspendedBackgroundDraw.get(client);
        if (!suspended || !token) {
            return;
        }
        const i = suspended.tokens.indexOf(token);
        if (i < 0) {
            return;
        }
        suspended.tokens.splice(i, 1);
        token.ended = true; //  see FormState.getFormCoverToken()
        if (0 === suspended.tokens.length) {
            suspendedBackgroundDraw.delete(client);
        }

        const uncovered = [];
        for (const view of suspended.missed) {
            if (destroyedViews.has(view)) {
                suspended.missed.delete(view);
            } else if (!view.isBackgroundDrawSuspended()) {
                suspended.missed.delete(view);
                uncovered.push(view);
            }
        }

        if (client.clientEnded || false === _.get(options, 'redrawMissed')) {
            return; //  nobody to draw for, or the screen is being replaced
        }

        for (const view of uncovered) {
            try {
                view.forceNextRedraw();
                view.drawInBackground(() => view.redraw());
            } catch (e) {
                //  one view's failure must not cost the others their redraw
                if (client.log) {
                    client.log.warn(
                        { error: e.message, viewId: view.id },
                        'Background redraw after suspend failed'
                    );
                }
            }
        }
    }

    //
    //  Drop every suspend held for |client|, redrawing nothing: the menu
    //  that was covered has gone (see MenuStack). Returns how many were
    //  held.
    //
    static dropBackgroundDrawSuspends(client) {
        const suspended = suspendedBackgroundDraw.get(client);
        if (!suspended) {
            return 0;
        }
        suspendedBackgroundDraw.delete(client);
        //  a form's cover() token among them: the form is no longer covered
        //  (FormState.getFormCoverToken())
        suspended.tokens.forEach(token => {
            token.ended = true;
        });
        return suspended.tokens.length;
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
    //  While background drawing is suspended (suspendBackgroundDraw())
    //  drawFn() runs with its output discarded, and the view gets a full
    //  redraw() later. Keep state changes out of drawFn() all the same: a
    //  terminal that cannot discard output skips drawFn() instead.
    //
    drawInBackground(drawFn) {
        drawBackground(this.client, [{ view: this, draw: drawFn }], true);
    }

    //
    //  drawInBackground() for several views at once, in one batch: what
    //  core/frame_clock.js uses to draw every animation due on a tick.
    //  |items| is [ { view, draw } ], drawn in that order. Each view gets
    //  exactly what drawInBackground() gives it -- a view under a cover
    //  (suspendBackgroundDraw()) draws nothing now and is redrawn in full
    //  when uncovered -- but the cursor is hidden once before the first
    //  draw and the input focus view puts it back once after the last, and
    //  it all goes out in one socket write.
    //
    //  A draw that throws costs only its own view: the others still draw
    //  and the cursor is still put back. A view an earlier draw of the batch
    //  destroyed is skipped. Returns { drawn, covered, failed }: the views
    //  drawn, those covered, and [ { view, error } ].
    //
    static drawInBackgroundBatch(client, items) {
        return drawBackground(client, items, false);
    }
}

//
//  drawInBackground() and drawInBackgroundBatch(). |single| is
//  drawInBackground(): its one draw that throws has its error thrown once
//  the cursor has been put back and the batch written, whatever was thrown
//  (undefined too), as it always has. A batch notes each failure and the
//  rest still draw, and skips a view an earlier draw of the same batch
//  destroyed. Draw functions are called bare (no |this|), as drawFn() always
//  was.
//
function drawBackground(client, items, single) {
    const result = { drawn: [], covered: [], failed: [] };

    //  The screen is covered for these (suspendBackgroundDraw()): draw
    //  nothing now, and get a full redraw when uncovered.
    const live = [];
    for (const item of items) {
        const view = item.view;
        if (!view.isBackgroundDrawSuspended()) {
            live.push(item);
            continue;
        }
        if (!destroyedViews.has(view)) {
            suspendedBackgroundDraw.get(view.client).missed.add(view);
        }
        //  draw() still runs, its output thrown away, for a caller that
        //  changes state in it; a terminal that cannot discard output (a
        //  test's mock) skips it
        const term = view.client.term;
        if (term && _.isFunction(term.discardOutput)) {
            try {
                term.discardOutput(item.draw);
            } catch (e) {
                if (single) {
                    throw e;
                }
                result.failed.push({ view, error: e });
                continue;
            }
        }
        result.covered.push(view);
    }

    if (0 === live.length) {
        return result;
    }

    //  drawn now: a pauseWhenInactive view owes no redraw any more
    live.forEach(item => pausedMissedViews.delete(item.view));

    const term = client.term;
    const focusView = View.getInputFocusView(client);
    const batch = _.isFunction(term.beginWrite) && _.isFunction(term.commitWrite);
    //  a flag, not the error: a draw may throw undefined, 0 or null
    let threw = false;
    let thrown;

    if (batch) {
        term.beginWrite();
    }

    try {
        if (focusView) {
            term.rawWrite(ansi.hideCursor());
        }

        try {
            for (const item of live) {
                //  destroyed by an earlier draw of this batch: owed nothing.
                //  (drawInBackground() draws its one view regardless.)
                if (!single && destroyedViews.has(item.view)) {
                    continue;
                }
                //  called bare, by this name: a draw that is not a function
                //  fails as drawInBackground()'s drawFn() always has
                const drawFn = item.draw;
                try {
                    drawFn();
                    result.drawn.push(item.view);
                } catch (e) {
                    result.failed.push({ view: item.view, error: e });
                    if (single) {
                        threw = true;
                        thrown = e;
                        break;
                    }
                }
            }
        } finally {
            //  Also when a draw threw: the cursor is never left hidden.
            //  Asked again, as a draw may have moved focus (a module's draw).
            const focusAfter = View.getInputFocusView(client);
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

    if (threw) {
        throw thrown;
    }
    return result;
}

//
//  For setBackgroundInterval(): true if this tick of |view| is skipped,
//  because it is a pauseWhenInactive view and its form is inactive or
//  covered. It is marked as owing a redraw (redrawPausedView()), and if a
//  suspend covers it, the redraw at the end of that cover draws it too:
//  what covered the screen may have drawn over it.
//
function skipPausedTick(view) {
    if (!pauseWhenInactiveViews.has(view) || !isFormPaused(getViewForm(view))) {
        return false;
    }
    if (destroyedViews.has(view)) {
        return true;
    }
    pausedMissedViews.add(view);
    if (view.isBackgroundDrawSuspended()) {
        suspendedBackgroundDraw.get(view.client).missed.add(view);
    }
    return true;
}

//
//  For ViewController activate(): a pauseWhenInactive |view| that skipped a
//  tick while its form was inactive or covered gets one full redraw.
//  Returns true if it was owed one.
//
function redrawPausedView(view) {
    if (!pausedMissedViews.has(view)) {
        return false;
    }
    pausedMissedViews.delete(view);
    if (destroyedViews.has(view)) {
        return false;
    }
    view.forceNextRedraw();
    view.drawInBackground(() => view.redraw());
    return true;
}

function isPauseWhenInactive(view) {
    return pauseWhenInactiveViews.has(view);
}

exports.View = View;
exports.redrawPausedView = redrawPausedView;
exports.skipPausedTick = skipPausedTick;
exports.isPauseWhenInactive = isPauseWhenInactive;
exports.VIEW_SPECIAL_KEY_MAP_DEFAULT = VIEW_SPECIAL_KEY_MAP_DEFAULT;
