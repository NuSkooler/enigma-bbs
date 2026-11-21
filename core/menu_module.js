/* jslint node: true */
'use strict';

const PluginModule = require('./plugin_module.js').PluginModule;
const theme = require('./theme.js');
const artUtil = require('./art.js');
const ansi = require('./ansi_term.js');
const ViewController = require('./view_controller.js').ViewController;
const menuUtil = require('./menu_util.js');
const Config = require('./config.js').get;
const stringFormat = require('../core/string_format.js');
const MultiLineEditTextView =
    require('../core/multi_line_edit_text_view.js').MultiLineEditTextView;
const { TextView } = require('../core/text_view.js');
const { View } = require('./view');
const ScreenCover = require('./screen_cover.js');
const { Errors, ErrorReasons } = require('../core/enig_error.js');
const { getPredefinedMCIValue } = require('../core/predefined_mci.js');
const EnigAssert = require('./enigma_assert');

//  deps
const async = require('async');
const assert = require('assert');
const _ = require('lodash');
const iconvDecode = require('iconv-lite').decode;

const MenuFlags = {
    // When leaving this menu to load/chain to another, remove this
    // menu from history. In other words, the fallback from
    // the next menu would *not* be this one, but the previous.
    NoHistory: 'noHistory',

    // Generally used in code only: Request that any flags from menu.hjson
    // are merged in to the total set of flags vs overriding the default.
    MergeFlags: 'mergeFlags',

    //  Forward this menu's 'extraArgs' to the next.
    ForwardArgs: 'forwardArgs',
};

exports.MenuFlags = MenuFlags;

//
//  Menus that have been left (leave() has run). Kept here rather than as a
//  property, so no name is taken from a mod's MenuModule subclass (some
//  keep their own `left`). See hasLeftMenu().
//
const leftMenus = new WeakSet();

//  menu -> Set of timeout handles from setMenuTimeout(), cleared by leave()
const menuTimeouts = new WeakMap();

//  passed down initSequence()'s waterfall to stop it once the menu is left
const MenuLeftStop = Symbol('menuLeft');

//
//  Tear down |vc| for a menu that has been left. detachClientEvents() does
//  it for an attached form; a form that never attached (or was blurred)
//  still has its views, and a ticker among them its timer.
//
function destroyForm(vc) {
    if (vc.attached) {
        return vc.detachClientEvents();
    }

    _.forEach(vc.views, view => {
        if (View.isDestroyed(view)) {
            return;
        }
        View.releaseInputFocus(view);
        view.removeAllListeners();
        if (_.isFunction(view.destroy)) {
            view.destroy();
        }
        View.markDestroyed(view);
    });
}

exports.MenuModule = class MenuModule extends PluginModule {
    constructor(options) {
        super(options);

        this.menuName = options.menuName;
        this.menuConfig = options.menuConfig;
        this.client = options.client;
        //
        //  A folder mod's own art/ folder (mods/<name>/art), set by
        //  menu_util.loadMenu() for a menu whose module is that mod; undefined
        //  for every other menu. Art this menu shows through the helpers below
        //  (displayAsset(), prepViewControllerWithArt(),
        //  displayArtAndPrepViewController(), promptForInput(), paged art) is
        //  looked for there after the themes and before the general art
        //  directory: see theme.getThemeArt(). Mod code calling theme.js
        //  directly can pass it on as |modArtPath| too.
        //
        this.modArtPath = options.modArtPath;
        this.menuMethods = {}; //  methods called from @method's
        this.menuConfig.config = this.menuConfig.config || {};
        //  Fall back to the global menus.cls, defaulting to false if the config
        //  has no `menus` section (e.g. a minimal/partial config). The explicit
        //  default avoids a hard TypeError on Config().menus.cls when menus is
        //  absent.
        this.cls = _.get(
            this.menuConfig.config,
            'cls',
            _.get(Config(), 'menus.cls', false)
        );
        this.viewControllers = {};
        this.interrupt = _.get(
            this.menuConfig.config,
            'interrupt',
            MenuModule.InterruptTypes.Queued
        ).toLowerCase();

        if (MenuModule.InterruptTypes.Realtime === this.interrupt) {
            this.realTimeInterrupt = 'blocked';
        }
    }

    setConfigWithExtraArgs(options) {
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });
    }

    setMergedFlag(flag) {
        this.menuConfig.config.menuFlags.push(flag);
        this.menuConfig.config.menuFlags = [
            ...new Set([...this.menuConfig.config.menuFlags, MenuFlags.MergeFlags]),
        ];
    }

    static get InterruptTypes() {
        return {
            Never: 'never',
            Queued: 'queued',
            Realtime: 'realtime',
        };
    }

    //
    //  Queued interrupts are drained here -- on *arrival*, by the menu that is
    //  about to own the screen -- and nowhere else.
    //
    //  They used to be drained on departure too, by prevMenu()/nextMenu()/
    //  autoNextMenu(), which ran before menuStack reached leave(): the outgoing
    //  menu's form was still attached to 'key press' while pausePrompt() waited
    //  on a non-exclusive once('key press'), so the key dismissing an interrupt
    //  also fired that menu's action keys, and any refresh timer it had kept
    //  painting over the interrupt art.
    //
    //  enter() rather than initSequence() because ~29 modules override
    //  initSequence() without draining, and would never show a queued item at
    //  all. enter() is overridden by four modules and every one of them calls
    //  super.enter(), so this reaches everything. A module that must not be
    //  interrupted on arrival overrides displayQueuedInterruptions() (the WFC
    //  routes instead of displaying; sysop_chat defers) or sets
    //  `interrupt: never`, which displayQueuedInterruptions() short-circuits.
    //
    enter() {
        this.displayQueuedInterruptions(() => {
            return this.initSequence();
        });
    }

    //
    //  The caller is leaving this menu (or it is being reloaded). A module
    //  that overrides this must call super.leave(): that marks the menu
    //  left (hasLeftMenu()), clears its setMenuTimeout() timers and tears
    //  down its forms.
    //
    leave() {
        leftMenus.add(this);
        this.clearMenuTimeouts();
        this.detachViewControllers();
    }

    //
    //  True once leave() has run. Anything that finishes after an async
    //  step (art loading, a pause, a database read) and would draw or build
    //  forms checks this first: the screen belongs to another menu now. The
    //  default initSequence() and the prep*() helpers below do.
    //
    hasLeftMenu() {
        return leftMenus.has(this);
    }

    //
    //  setTimeout() for this menu: |fn| runs after |ms| unless the menu has
    //  been left first; leave() clears every one still pending. Returns a
    //  handle for clearMenuTimeout().
    //
    setMenuTimeout(fn, ms) {
        let timeouts = menuTimeouts.get(this);
        if (!timeouts) {
            timeouts = new Set();
            menuTimeouts.set(this, timeouts);
        }

        const handle = setTimeout(() => {
            timeouts.delete(handle);
            if (this.hasLeftMenu()) {
                return;
            }
            return fn();
        }, ms);
        timeouts.add(handle);
        return handle;
    }

    clearMenuTimeout(handle) {
        const timeouts = menuTimeouts.get(this);
        if (timeouts && timeouts.delete(handle)) {
            clearTimeout(handle);
        }
    }

    clearMenuTimeouts() {
        const timeouts = menuTimeouts.get(this);
        if (timeouts) {
            timeouts.forEach(handle => clearTimeout(handle));
            timeouts.clear();
        }
    }

    //  Forms that may have been built after leave() tore down the others
    _destroyFormsAfterLeave() {
        Object.keys(this.viewControllers).forEach(name => {
            destroyForm(this.viewControllers[name]);
        });
    }

    //  For a step that finished after leave(): note it, and stop
    _stoppedAfterLeave(step) {
        if (!this.hasLeftMenu()) {
            return false;
        }
        this.client.log.debug(
            { menuName: this.menuName, step },
            'Menu was left; not continuing'
        );
        return true;
    }

    initSequence() {
        const self = this;
        const mciData = {};
        let pausePosition = { row: 0, column: 0 };
        this.afterArtPosition = pausePosition;

        const hasArt = () => {
            return (
                _.isString(self.menuConfig.art) ||
                (Array.isArray(self.menuConfig.art) &&
                    _.has(self.menuConfig.art[0], 'acs'))
            );
        };

        async.waterfall(
            [
                function beforeDisplayArt(callback) {
                    return self.beforeArt(callback);
                },
                function displayMenuArt(callback) {
                    if (self._stoppedAfterLeave('beforeArt')) {
                        return callback(MenuLeftStop);
                    }

                    if (!hasArt()) {
                        return callback(null, null);
                    }

                    const doDisplay = (err, artData) => {
                        if (err) {
                            self.client.log.trace('Could not display art', {
                                art: self.menuConfig.art,
                                reason: err.message,
                            });
                        } else {
                            mciData.menu = artData.mciMap;
                        }

                        if (artData) {
                            pausePosition.row = artData.height + 1;
                        }

                        return callback(null, artData); //  any errors are non-fatal
                    };

                    if (self.getPauseMode() === 'pageBreak') {
                        return self._displayArtPaginated(
                            self.menuConfig.art,
                            self.menuConfig.config,
                            doDisplay
                        );
                    }

                    self.displayAsset(
                        self.menuConfig.art,
                        self.menuConfig.config,
                        doDisplay
                    );
                },
                function displayPromptArt(artData, callback) {
                    if (self._stoppedAfterLeave('art')) {
                        return callback(MenuLeftStop);
                    }

                    if (!_.isString(self.menuConfig.prompt)) {
                        return callback(null);
                    }

                    if (!_.isObject(self.menuConfig.promptConfig)) {
                        return callback(
                            Errors.MissingConfig(
                                'Prompt specified but no "promptConfig" block found'
                            )
                        );
                    }

                    const options = Object.assign({}, self.menuConfig.config);

                    if (_.isNumber(artData?.height)) {
                        options.startRow = artData.height + 1;
                    }

                    self.displayAsset(
                        self.menuConfig.promptConfig.art,
                        options,
                        (err, artData) => {
                            if (artData) {
                                mciData.prompt = artData.mciMap;
                                pausePosition.row = artData.height + 1;
                            }

                            return callback(err); //  pass err here; prompts *must* have art
                        }
                    );
                },
                function afterArtDisplayed(callback) {
                    //  left while the art loaded: no forms (or tickers) for
                    //  a menu that is gone
                    if (self._stoppedAfterLeave('promptArt')) {
                        return callback(MenuLeftStop);
                    }

                    return self.mciReady(mciData, callback);
                },
                function displayPauseIfRequested(callback) {
                    if (self._stoppedAfterLeave('mciReady')) {
                        //  forms built after leave() tore down the others
                        self._destroyFormsAfterLeave();
                        return callback(MenuLeftStop);
                    }

                    if (!self.shouldPause() || self.getPauseMode() === 'pageBreak') {
                        return callback(null, null);
                    }

                    //  If the art scrolled, the prompt goes to the bottom of the screen
                    return self.pausePrompt(
                        self._clampRowToScreen(pausePosition),
                        callback
                    );
                },
                function finishAndNext(artInfo, callback) {
                    if (self._stoppedAfterLeave('pause')) {
                        return callback(MenuLeftStop);
                    }

                    self.finishedLoading();
                    self.realTimeInterrupt = 'allowed';
                    return self.autoNextMenu(callback);
                },
            ],
            err => {
                if (MenuLeftStop === err) {
                    return; //  left part-way; see hasLeftMenu()
                }

                if (err) {
                    return self.initSequenceFailed(err);
                }

                self.initSequenceSucceeded();
            }
        );
    }

    //  see MenuStack.initSucceeded(); a stand-in client may have no stack
    initSequenceSucceeded() {
        const menuStack = this.client.menuStack;
        if (menuStack && _.isFunction(menuStack.initSucceeded)) {
            menuStack.initSucceeded(this.menuName);
        }
    }

    //
    //  initSequence() failed: fall back to the previous menu -- unless that
    //  would cycle. A previous menu that advances on its own (autoNext, with
    //  a pause prompt that could not be shown, say) comes straight back here
    //  to fail again, as fast as the CPU allows. See
    //  MenuStack.initFailureWouldCycle(): a second failure with no input from
    //  the caller in between stays put, with the session left to the idle
    //  timeout. If the caller pressed a key since the last failure, they are
    //  trying again, and this failure falls back as before.
    //
    initSequenceFailed(err) {
        if (ErrorReasons.ClientEnded === err.reasonCode) {
            return; //  the caller has gone; there is nowhere to go
        }

        this.client.log.warn('Error during init sequence', {
            error: err.message,
        });

        if (this.client.menuStack.initFailureWouldCycle(this.menuName)) {
            return this.client.log.error(
                { menuName: this.menuName, error: err.message },
                'Menu failed again with no input since its last failure; not returning to the previous menu, which led straight back here'
            );
        }

        return this.prevMenu(() => {
            /* dummy */
        });
    }

    beforeArt(cb) {
        //  baudRate is now handled server-side inside art.display() via collect-and-drip;
        //  no terminal escape sequence needed (and none sent — fixes sticky baud state).
        if (this.cls) {
            this.client.term.rawWrite(ansi.resetScreen());
        }

        return cb(null);
    }

    mciReady(mciData, cb) {
        //  available for sub-classes
        return cb(null);
    }

    finishedLoading() {
        //  nothing in base
    }

    displayQueuedInterruptions(cb) {
        if (MenuModule.InterruptTypes.Never === this.interrupt) {
            return cb(null);
        }

        let opts = { cls: true }; //  clear screen for first message

        async.whilst(
            callback => callback(null, this.client.interruptQueue.hasItems()),
            next => {
                this.client.interruptQueue.displayNext(opts, err => {
                    opts = {};
                    return next(err);
                });
            },
            err => {
                return cb(err);
            }
        );
    }

    attemptInterruptNow(interruptItem, cb) {
        if (
            this.realTimeInterrupt !== 'allowed' ||
            MenuModule.InterruptTypes.Realtime !== this.interrupt
        ) {
            return cb(null, false); //  don't eat up the item; queue for later
        }

        this.realTimeInterrupt = 'blocked';

        //
        //  Default impl: clear screen -> standard display -> reload menu
        //
        const done = (err, removeFromQueue) => {
            this.realTimeInterrupt = 'allowed';
            return cb(err, removeFromQueue);
        };

        this.client.interruptQueue.displayWithItem(
            Object.assign({}, interruptItem, { cls: true }),
            err => {
                if (err) {
                    return done(err, false);
                }
                this.reload(err => {
                    return done(err, err ? false : true);
                });
            }
        );
    }

    getSaveState() {
        //  nothing in base
    }

    restoreSavedState(/*savedState*/) {
        //  nothing in base
    }

    getMenuResult() {
        //  default to the formData that was provided @ a submit, if any
        return this.submitFormData;
    }

    nextMenu(cb) {
        if (!this.haveNext()) {
            return this.prevMenu(cb); //  no next, go to prev
        }

        //  No drain here: the destination drains on arrival. See enter().
        return this.client.menuStack.next(cb);
    }

    prevMenu(cb) {
        return this.client.menuStack.prev(cb);
    }

    gotoMenu(name, options, cb) {
        return this.client.menuStack.goto(name, options, cb);
    }

    gotoMenuOrPrev(name, options, cb) {
        this.client.menuStack.goto(name, options, err => {
            if (!err) {
                if (cb) {
                    return cb(null);
                }
            }

            return this.prevMenu(cb);
        });
    }

    //
    //  coverScreen([options,] fn, cb) -- show something over this menu's
    //  screen (a help page, a message) while its forms stay attached: keys
    //  go to the cover, not the forms, and the forms' tickers and status
    //  bars do not draw over it. See core/screen_cover.js for |options|
    //  (restore(cb) repaints the menu afterwards).
    //
    coverScreen(options, fn, cb) {
        return ScreenCover.coverScreen(this.client, options, fn, cb);
    }

    gotoMenuOrShowMessage(name, message, options, cb) {
        if (!cb && _.isFunction(options)) {
            cb = options;
            options = {};
        }

        options = options || { clearScreen: true };

        this.gotoMenu(name, options, err => {
            if (err) {
                //  The message is shown over this menu, which is still
                //  attached: its forms get no key and its tickers do not
                //  draw while the pause waits. prevMenu() repaints, after.
                return this.coverScreen(
                    { redrawMissed: false },
                    done => {
                        if (options.clearScreen) {
                            this.client.term.rawWrite(ansi.resetScreen());
                        }

                        this.client.term.write(`${message}\n`);
                        return this.pausePrompt(() => done());
                    },
                    () => {
                        return this.prevMenu(cb);
                    }
                );
            }

            if (cb) {
                return cb(null);
            }
        });
    }

    reload(cb) {
        const prevMenu = this.client.menuStack.pop();
        //  so leave() can tell a reload from the caller leaving the menu
        prevMenu.instance.reloading = true;
        prevMenu.instance.leave();
        return this.client.menuStack.goto(
            prevMenu.name,
            { extraArgs: prevMenu.extraArgs },
            cb
        );
    }

    //  not if the menu has been left by then (see setMenuTimeout())
    prevMenuOnTimeout(timeout, cb) {
        return this.setMenuTimeout(() => {
            return this.prevMenu(cb);
        }, timeout);
    }

    addViewController(name, vc) {
        assert(
            !this.viewControllers[name],
            `ViewController by the name of "${name}" already exists!`
        );

        this.viewControllers[name] = vc;
        return vc;
    }

    removeViewController(name) {
        if (this.viewControllers[name]) {
            this.viewControllers[name].detachClientEvents();
            delete this.viewControllers[name];
        }
    }

    detachViewControllers() {
        Object.keys(this.viewControllers).forEach(name => {
            this.viewControllers[name].detachClientEvents();
        });
    }

    shouldPause() {
        const p = this.menuConfig.config.pause;
        //  pause: true | 'end' | 'pageBreak' | '<promptId>'
        return (
            p === true ||
            p === 'end' ||
            p === 'pageBreak' ||
            (_.isString(p) && p.length > 0)
        );
    }

    getPauseMode() {
        return 'pageBreak' === this.menuConfig.config.pause ? 'pageBreak' : 'end';
    }

    _resolvePromptName(type) {
        //  type is 'end' or 'page'
        //  pausePrompt: 'myPrompt'             → use for both (takes precedence)
        //  pausePrompt: { end: 'x', page: 'y' } → use per type (takes precedence)
        //  pause: 'myPrompt'                   → shorthand: use for both (end mode only)
        const cfg = this.menuConfig.config.pausePrompt;
        if (cfg) {
            if (_.isString(cfg)) {
                return cfg;
            }
            if (_.isObject(cfg)) {
                const named = type === 'page' ? cfg.page : cfg.end;
                if (_.isString(named)) {
                    return named;
                }
            }
        }
        //  If pause itself is a prompt ID (not a keyword), use it for 'end' type
        const pauseVal = this.menuConfig.config.pause;
        if (
            type === 'end' &&
            _.isString(pauseVal) &&
            pauseVal !== 'end' &&
            pauseVal !== 'pageBreak'
        ) {
            return pauseVal;
        }
        return type === 'page' ? 'pausePage' : 'pause';
    }

    _applyPausePosition(base) {
        const cfg = this.menuConfig.config.pausePosition;
        if (!cfg) {
            return base;
        }
        const result = Object.assign({}, base);
        if (_.isNumber(cfg.row)) {
            result.row = cfg.row;
        }
        if (_.isNumber(cfg.col)) {
            result.col = cfg.col;
        }
        return result;
    }

    _getContinuousKey() {
        const promptName = this._resolvePromptName('page');
        const promptCfg = _.get(this.client, ['currentTheme', 'prompts', promptName]);
        return _.get(promptCfg, 'config.continuousKey', null);
    }

    _getQuitKey() {
        const promptName = this._resolvePromptName('page');
        const promptCfg = _.get(this.client, ['currentTheme', 'prompts', promptName]);
        return _.get(promptCfg, 'config.quitKey', null);
    }

    _paginateAndDisplay(artInfo, artOptions, cb) {
        const self = this;

        //  native art (.seq, .ata) positions itself on the screen, and RIP art
        //  draws by its own coordinates: never paged
        const { pages, hasAbsolutePositioning } =
            artInfo.native || artInfo.rip
                ? { pages: [], hasAbsolutePositioning: true }
                : artUtil.paginate(artInfo.data, {
                      termHeight: self.client.term.termHeight,
                  });

        if (hasAbsolutePositioning || pages.length <= 1) {
            //  Not pageable — display normally and return
            return theme.displayPreparedArt(
                Object.assign({ client: self.client }, artOptions),
                artInfo,
                (err, artData) => cb(err, artData)
            );
        }

        let continuous = false;
        let quit = false;
        let finalArtData = null;
        const contKey = self._getContinuousKey();
        const quitKey = self._getQuitKey();

        const showPage = (index, next) => {
            if (index >= pages.length || quit) {
                return next(null);
            }

            const isLast = index === pages.length - 1;
            const pageArtInfo = Object.assign({}, artInfo, { data: pages[index] });

            theme.displayPreparedArt(
                Object.assign({ client: self.client }, artOptions),
                pageArtInfo,
                (err, artData) => {
                    if (err) {
                        return next(err);
                    }
                    finalArtData = artData;

                    if (isLast || continuous || quit) {
                        return showPage(index + 1, next);
                    }

                    //  Page-break prompt
                    const promptName = self._resolvePromptName('page');
                    const promptExists = _.has(self.client, [
                        'currentTheme',
                        'prompts',
                        promptName,
                    ]);
                    if (!promptExists) {
                        self.client.log.warn(
                            { promptName },
                            'Page-break prompt not found; skipping pause'
                        );
                        return showPage(index + 1, next);
                    }

                    const position = self._applyPausePosition({
                        row: self.client.term.termHeight,
                        col: 1,
                    });

                    self.optionalMoveToPosition(position);
                    theme.displayThemedPause(
                        self.client,
                        { position, promptName, clearPrompt: true },
                        (err, _artInfo, pressedKey) => {
                            if (!err && pressedKey) {
                                const keyName =
                                    _.get(pressedKey, 'key.name') || pressedKey.ch || '';
                                const keyLower = keyName.toLowerCase();
                                if (contKey && keyLower === contKey.toLowerCase()) {
                                    continuous = true;
                                } else if (
                                    quitKey &&
                                    keyLower === quitKey.toLowerCase()
                                ) {
                                    quit = true;
                                }
                            }
                            return showPage(index + 1, next);
                        }
                    );
                }
            );
        };

        showPage(0, err => {
            if (err) {
                return cb(err, finalArtData);
            }

            //  End-of-art pause after all pages have been shown (skipped on quit)
            if (quit) {
                return cb(null, finalArtData);
            }

            const endPosition = self._applyPausePosition({
                row: self.client.term.termHeight,
                col: 1,
            });
            self.optionalMoveToPosition(endPosition);
            theme.displayThemedPause(
                self.client,
                {
                    position: endPosition,
                    promptName: self._resolvePromptName('end'),
                    clearPrompt: true,
                },
                () => cb(null, finalArtData)
            );
        });
    }

    _displayArtPaginated(artSpec, artOptions, cb) {
        const self = this;

        //  Buffer artSpec: decode and paginate directly without fetching via name.
        //  Promote bare LF to CRLF; see getArtFromPath() in core/art.js for rationale.
        if (Buffer.isBuffer(artSpec)) {
            const data = iconvDecode(artSpec, artOptions.encoding || 'cp437').replace(
                /(?<!\r)\n/g,
                '\r\n'
            );
            return self._paginateAndDisplay({ data, sauce: null }, artOptions, cb);
        }

        //  ACS conditional array: resolve to the winning entry's art name
        if (Array.isArray(artSpec)) {
            artSpec = self.client.acs.getConditionalValue(artSpec, 'art');
            if (!artSpec) {
                return cb(null, { mciMap: {}, height: 0 });
            }
        }

        theme.getThemeArt(
            Object.assign({ client: self.client, name: artSpec }, artOptions, {
                acceptNative: true, //  _paginateAndDisplay() shows native art
                //  and RIP art, unless the caller says |artSpec| may not be the
                //  operator's choice (see theme.getThemeArt())
                acceptRip: false !== artOptions.acceptRip,
                modArtPath: self.modArtPath,
            }),
            (err, artInfo) => {
                if (err) {
                    return cb(err);
                }
                return self._paginateAndDisplay(artInfo, artOptions, cb);
            }
        );
    }

    hasNextTimeout() {
        return _.isNumber(this.menuConfig.config.nextTimeout);
    }

    haveNext() {
        return _.isString(this.menuConfig.next) || Array.isArray(this.menuConfig.next);
    }

    autoNextMenu(cb) {
        const gotoNextMenu = () => {
            if (this.haveNext()) {
                return menuUtil.handleNext(this.client, this.menuConfig.next, {}, cb);
            } else {
                return this.prevMenu(cb);
            }
        };

        if (
            _.has(this.menuConfig, 'runtime.autoNext') &&
            true === this.menuConfig.runtime.autoNext
        ) {
            if (this.hasNextTimeout()) {
                //  not if the caller has moved on by then
                this.setMenuTimeout(() => {
                    return gotoNextMenu();
                }, this.menuConfig.config.nextTimeout);
            } else {
                return gotoNextMenu();
            }
        }
    }

    standardMCIReadyHandler(mciData, cb) {
        //
        //  A quick rundown:
        //  *   We may have mciData.menu, mciData.prompt, or both.
        //  *   Prompt form is favored over menu form if both are present.
        //  *   Standard/predefined MCI entries must load both (e.g. %BN is expected to resolve)
        //
        const self = this;

        async.series(
            [
                function addViewControllers(callback) {
                    _.forEach(mciData, (mciMap, name) => {
                        assert('menu' === name || 'prompt' === name);
                        self.addViewController(
                            name,
                            new ViewController({ client: self.client })
                        );
                    });

                    return callback(null);
                },
                function createMenu(callback) {
                    if (!self.viewControllers.menu) {
                        return callback(null);
                    }

                    const menuLoadOpts = {
                        mciMap: mciData.menu,
                        callingMenu: self,
                        withoutForm: _.isObject(mciData.prompt),
                    };

                    self.viewControllers.menu.loadFromMenuConfig(menuLoadOpts, err => {
                        return callback(err);
                    });
                },
                function createPrompt(callback) {
                    if (!self.viewControllers.prompt) {
                        return callback(null);
                    }

                    const promptLoadOpts = {
                        callingMenu: self,
                        mciMap: mciData.prompt,
                    };

                    self.viewControllers.prompt.loadFromPromptConfig(
                        promptLoadOpts,
                        err => {
                            return callback(err);
                        }
                    );
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    displayAsset(nameOrData, options, cb) {
        if (_.isFunction(options)) {
            cb = options;
            options = {};
        }

        if (options.clearScreen) {
            this.client.term.rawWrite(ansi.resetScreen());
        }

        options = Object.assign(
            {
                client: this.client,
                font: this.menuConfig.config.font,
                encodedAs: this.menuConfig.config.encodedAs, //  propagate to art loader; undefined if unset
            },
            options, //  caller can override
            //  ...but not this: |options| is often the menu's config block,
            //  and no config key may name a folder to look for art in
            { modArtPath: this.modArtPath }
        );

        if (Buffer.isBuffer(nameOrData)) {
            const data = iconvDecode(nameOrData, options.encoding || 'cp437');
            return theme.displayPreparedArt(options, { data }, (err, artData) => {
                if (cb) {
                    return cb(err, artData);
                }
            });
        }

        return theme.displayThemedAsset(
            nameOrData,
            this.client,
            options,
            (err, artData) => {
                if (cb) {
                    return cb(err, artData);
                }
            }
        );
    }

    //
    //  The prep*() helpers stop quietly, without calling |cb|, once the menu
    //  has been left (hasLeftMenu()): what would follow draws on a screen
    //  that belongs to another menu.
    //
    prepViewController(name, formId, mciMap, cb) {
        if (this._stoppedAfterLeave(`prepViewController:${name}`)) {
            return;
        }

        const needsCreated = this.viewControllers[name] === undefined;
        if (needsCreated) {
            const vcOpts = {
                client: this.client,
                formId: formId,
            };

            const vc = this.addViewController(name, new ViewController(vcOpts));

            const loadOpts = {
                callingMenu: this,
                mciMap: mciMap,
                formId: formId,
            };

            return vc.loadFromMenuConfig(loadOpts, err => {
                if (this._stoppedAfterLeave(`prepViewController:${name}`)) {
                    destroyForm(vc);
                    return;
                }
                return cb(err, vc, true);
            });
        }

        this.viewControllers[name].setFocus(true);

        return cb(null, this.viewControllers[name], false);
    }

    prepViewControllerWithArt(name, formId, options, cb) {
        this.displayAsset(this.menuConfig.config.art[name], options, (err, artData) => {
            if (this._stoppedAfterLeave(`prepViewControllerWithArt:${name}`)) {
                return;
            }

            if (err) {
                return cb(err);
            }

            return this.prepViewController(name, formId, artData.mciMap, cb);
        });
    }

    optionalMoveToPosition(position) {
        if (!position) {
            return;
        }

        //  initSequence() spells the column 'column', _applyPausePosition
        //  'col', and a caller may hand us x/y
        const row = position.row || position.x;
        const col = position.col || position.column || position.y;

        //  no coordinates means wherever the cursor is
        if (!row && !col) {
            return;
        }

        this.client.term.rawWrite(ansi.goto(row || 1, col || 1));
    }

    //
    //  For a module that finishes on its own rather than through a form: say
    //  how it went in |statusView| when the menu's art has one, else on the
    //  terminal. Then hold it with pauseBelowArt().
    //
    showOutcome(text, statusView) {
        if (statusView) {
            statusView.setText(text);
        } else {
            this.client.term.write(`\n${text}\n`);
        }
    }

    //  below the art rather than wherever the last view write left the cursor
    pauseBelowArt(cb) {
        return this.pausePrompt(this._clampRowToScreen(this.afterArtPosition), cb);
    }

    //  A copy of |position| whose row is no lower than the terminal's last row
    _clampRowToScreen(position) {
        const clamped = Object.assign({}, position);
        const termHeight = this.client.term.termHeight;
        if (termHeight > 0 && clamped.row > termHeight) {
            clamped.row = termHeight;
        }
        return clamped;
    }

    pausePrompt(position, cb, type = 'end') {
        if (!cb && _.isFunction(position)) {
            cb = position;
            position = null;
        }

        const resolvedPosition = this._applyPausePosition(position || {});
        this.optionalMoveToPosition(resolvedPosition);

        const promptName = this._resolvePromptName(type);
        return theme.displayThemedPause(
            this.client,
            { position: resolvedPosition, promptName },
            err => cb(err)
        );
    }

    promptForInput(
        { formName, formId, promptName, prevFormName, position } = {},
        options,
        cb
    ) {
        if (!cb && _.isFunction(options)) {
            cb = options;
            options = {};
        }

        options.viewController = this.addViewController(
            formName,
            new ViewController({ client: this.client, formId })
        );

        options.trailingLF = _.get(options, 'trailingLF', false);

        let prevVc;
        if (prevFormName) {
            prevVc = this.viewControllers[prevFormName];
            if (prevVc) {
                prevVc.setFocus(false);
            }
        }

        const originalSubmitNotify = options.submitNotify;

        options.submitNotify = () => {
            if (_.isFunction(originalSubmitNotify)) {
                originalSubmitNotify();
            }

            if (prevVc) {
                prevVc.setFocus(true);
            }
            this.removeViewController(formName);
            if (options.clearAtSubmit) {
                this.optionalMoveToPosition(position);
                if (options.clearWidth) {
                    this.client.term.rawWrite(
                        `${ansi.reset()}${' '.repeat(options.clearWidth)}`
                    );
                } else {
                    //  :TODO: handle multi-rows via artHeight
                    this.client.term.rawWrite(ansi.eraseLine());
                }
            }
        };

        options.viewController.setFocus(true);
        //  a prompt this menu asks for may have its art in the mod's folder
        options.modArtPath = this.modArtPath;

        this.optionalMoveToPosition(position);
        if (!options.position) {
            options.position = position;
        }
        theme.displayThemedPrompt(promptName, this.client, options, (err, artInfo) => {
            /*
            if(artInfo) {
                artHeight = artInfo.height;
            }
            */
            return cb(err, artInfo);
        });
    }

    //
    //  Show art |name| (menu config `art.<name>`) and load form |formId|
    //  over it into view controller |name|, or refocus that controller if
    //  it already exists. Calls back (err, artInfo, wasCreated) like
    //  prepViewController(); nothing at all once the menu has been left.
    //
    displayArtAndPrepViewController(name, formId, options, cb) {
        const config = this.menuConfig.config;
        EnigAssert(_.isObject(config));

        async.waterfall(
            [
                callback => {
                    if (options.clearScreen) {
                        this.client.term.rawWrite(ansi.resetScreen());
                    }

                    if (!_.has(config.art, name)) {
                        const artKeys = Object.keys(config.art);
                        this.client.log.warn(
                            { requestedArtName: name, availableArtKeys: artKeys },
                            'Art name is not set! Check configuration for typos.'
                        );
                    }

                    theme.displayThemedAsset(
                        config.art[name],
                        this.client,
                        {
                            font: this.menuConfig.font,
                            trailingLF: false,
                            modArtPath: this.modArtPath,
                        },
                        (err, artData) => {
                            //  quietly, error or not: see prepViewController()
                            if (
                                this._stoppedAfterLeave(
                                    `displayArtAndPrepViewController:${name}`
                                )
                            ) {
                                return;
                            }
                            return callback(err, artData);
                        }
                    );
                },
                (artData, callback) => {
                    if (this.viewControllers[name] === undefined) {
                        const vcOpts = {
                            client: this.client,
                            formId: formId,
                        };

                        if (options.noInput !== undefined) {
                            vcOpts.noInput = options.noInput;
                        }

                        const vc = this.addViewController(
                            name,
                            new ViewController(vcOpts)
                        );

                        if (_.isFunction(options.artDataPrep)) {
                            try {
                                options.artDataPrep(name, artData, vc);
                            } catch (e) {
                                return callback(e);
                            }
                        }

                        const loadOpts = {
                            callingMenu: this,
                            mciMap: artData.mciMap,
                            formId: formId,
                            viewOffsets: options.viewOffsets,
                        };

                        return vc.loadFromMenuConfig(loadOpts, err => {
                            if (
                                this._stoppedAfterLeave(
                                    `displayArtAndPrepViewController:${name}`
                                )
                            ) {
                                return destroyForm(vc);
                            }
                            return callback(err, artData, true);
                        });
                    }

                    this.viewControllers[name].setFocus(true);
                    return callback(null, artData, false);
                },
            ],
            (err, artData, wasCreated) => {
                return cb(err, artData, wasCreated);
            }
        );
    }

    setViewText(formName, mciId, text, appendMultiLine) {
        const view = this.getView(formName, mciId);
        if (!view) {
            return;
        }

        if (appendMultiLine && view instanceof MultiLineEditTextView) {
            view.setAnsi(text);
        } else {
            view.setText(text);
        }
    }

    getView(formName, id) {
        const form = this.viewControllers[formName];
        return form && form.getView(id);
    }

    //
    //  Defaults for the custom info formats (`${formName}InfoFormat${id}`) of
    //  |formName|, as { id: formatString }, e.g. { 10: '{msgCount} new' }.
    //  A module overrides this to ship formats that work with no operator
    //  config. Return a new object; never write into menuConfig, which is the
    //  shared, cached theme object.
    //
    getDefaultCustomInfoFormats(/*formName*/) {
        return {};
    }

    //
    //  The format for custom view |id| of |formName|. Anything an operator
    //  sets (menu `config` / theme) always wins, including an empty string,
    //  null or false, which hide the view even when the module has a default
    //  for it. Absent that, the module's default, else undefined. A format
    //  that comes out empty is treated as unset by the callers (no view,
    //  nothing drawn).
    //
    getCustomInfoFormat(formName, id) {
        const config = (this.menuConfig && this.menuConfig.config) || {};
        const configured = config[`${formName}InfoFormat${id}`];
        if (undefined !== configured) {
            return configured;
        }

        const defaults = this.getDefaultCustomInfoFormats(formName) || {};
        const dflt = defaults[id];
        return 'string' === typeof dflt ? dflt : undefined;
    }

    getCustomViewsWithFilter(formName, startId, options) {
        options = options || {};

        const views = [];

        //  a menu with no art has no view controller at all, as getView()
        //  just above already allows for
        const form = this.viewControllers[formName];
        if (!form) {
            return views;
        }

        const endId = options.endId || 99;

        //  Walk the whole range rather than stopping at the first missing ID:
        //  art that drops one custom view (e.g. a %TL10 replaced by a status
        //  bar) must not silently freeze every custom view after it.
        for (let customMciId = startId; customMciId <= endId; ++customMciId) {
            const view = form.getView(customMciId);
            if (!view) {
                continue;
            }

            const key = `${formName}InfoFormat${customMciId}`; //  e.g. "mainInfoFormat10"
            const format = this.getCustomInfoFormat(formName, customMciId);

            if (
                format &&
                (!options.filter || options.filter.find(f => format.indexOf(f) > -1))
            ) {
                view.key = key; // cache
                view.infoFormat = format; // what updateCustomViewTextsWithFilter() draws
                views.push(view);
            }
        }

        return views;
    }

    //
    //  |options|:
    //    filter          only views whose format holds one of these strings
    //    appendMultiLine an MLE gets the text added rather than replaced
    //    pipeSupport     an MLE gets the text through setPipeText()
    //    skipUnchanged   a view whose text comes out the same is not drawn
    //                    again. For screens refreshed on a timer, where most
    //                    values hold still from one tick to the next. Only
    //                    a plain TextView (or one that keeps TextView's
    //                    setText() and getData(), e.g. a StatusBarView) is
    //                    compared; anything else is drawn as without it.
    //                    A caller that writes over its custom views outside
    //                    of them must leave this off for the next call, or
    //                    what it covered stays covered.
    //
    updateCustomViewTextsWithFilter(formName, startId, fmtObj, options) {
        options = options || {};
        const views = this.getCustomViewsWithFilter(formName, startId, options);
        let drawn = 0;

        views.forEach(view => {
            const format = view.infoFormat;
            //  measured with the client the view renders it with
            const text = stringFormat(format, fmtObj, { client: this.client });

            if (options.skipUnchanged && MenuModule.canSkipUnchangedText(view)) {
                //  getData() is the text as setText() leaves it -- predefined
                //  MCI resolved, pipe codes converted, clipped and styled --
                //  which is exactly what redraw() puts on screen
                const prev = view.getData();
                view.setText(text, false); //  false=do not draw yet
                if (view.getData() !== prev || !view.hasDrawnOnce) {
                    view.redraw();
                    ++drawn;
                }
                return;
            }

            ++drawn;

            if (view instanceof MultiLineEditTextView) {
                if (options.appendMultiLine) {
                    view.addText(text);
                } else {
                    if (options.pipeSupport) {
                        //  getData() is the laid out buffer, never the source
                        //  text, so there is nothing to compare: always set it
                        view.setPipeText(text);
                    } else if (view.getData() !== text) {
                        view.setText(text);
                    } else {
                        view.redraw();
                    }
                }
            } else {
                if (view.getData() !== text) {
                    view.setText(text);
                } else {
                    view.redraw();
                }
            }
        });

        //
        //  Drawing the views above leaves the terminal cursor wherever the last
        //  one finished -- typically parked on a status line well away from the
        //  view the user is actually typing into. Put it back (#831). Nothing
        //  drawn, nothing moved: leave the cursor alone.
        //
        if (drawn > 0) {
            this.repositionCursorToFocusedView(formName);
        }
    }

    //
    //  A view whose setText(text, false) followed by redraw() draws what
    //  setText(text) would, and whose getData() is the text it draws.
    //  EditTextView and MaskEditTextView are left out: their getData() is the
    //  text being edited, not what is drawn (an itemFormat previews its colour
    //  codes, a mask adds its literals); a ButtonView's getData() is not its
    //  text at all.
    //
    static canSkipUnchangedText(view) {
        return (
            view instanceof TextView &&
            view.setText === TextView.prototype.setText &&
            view.getData === TextView.prototype.getData
        );
    }

    //
    //  Move the terminal cursor back to where the view the user is typing
    //  into wants it, after something else has drawn over the screen.
    //
    //  That is the client's input focus view (View.getInputFocusView()), on
    //  whichever form it is: the custom views may be in the menu's art and
    //  the field in its prompt. |_formName| is no longer used to find it and
    //  is kept so existing callers and overrides still work.
    //
    //  The view's restoreFocusPosition() puts back its cursor and SGR:
    //  EditTextView through _repositionCursor() (so a version patched onto a
    //  view, as sysop chat does, is used), MultiLineEditTextView at its edit
    //  row and column, MaskEditTextView and other TextViews where
    //  setFocus(true) leaves the cursor. Menu views know no cursor position
    //  and write nothing; with nothing focused this is a no-op, and the
    //  caller's cursor handling stands. No focus state is changed and no
    //  switch-focus events are fired.
    //
    repositionCursorToFocusedView(_formName) {
        const view = View.getInputFocusView(this.client);
        if (view) {
            view.restoreFocusPosition();
        }
    }

    refreshPredefinedMciViewsByCode(formName, mciCodes) {
        const form = _.get(this, ['viewControllers', formName]);
        if (form) {
            form.getViewsByMciCode(mciCodes).forEach(v => {
                if (!v.setText) {
                    return;
                }

                v.setText(getPredefinedMCIValue(this.client, v.mciCode));
            });
        }
    }

    validateMCIByViewIds(formName, viewIds, cb) {
        if (!Array.isArray(viewIds)) {
            viewIds = [viewIds];
        }
        const form = _.get(this, ['viewControllers', formName]);
        if (!form) {
            return cb(Errors.DoesNotExist(`Form does not exist: ${formName}`));
        }
        for (let i = 0; i < viewIds.length; ++i) {
            if (!form.hasView(viewIds[i])) {
                return cb(Errors.MissingMci(`Missing MCI ${viewIds[i]}`));
            }
        }
        return cb(null);
    }

    validateConfigFields(fields, cb) {
        //
        //  fields is expected to be { key : type || validator(key, config) }
        //  where |type| is 'string', 'array', object', 'number'
        //
        if (!_.isObject(fields)) {
            return cb(Errors.Invalid('Invalid validator!'));
        }

        const config = this.config || this.menuConfig.config;
        let firstBadKey;
        let badReason;
        const good = _.every(fields, (type, key) => {
            if (_.isFunction(type)) {
                if (!type(key, config)) {
                    firstBadKey = key;
                    badReason = 'Validate failure';
                    return false;
                }
                return true;
            }

            const c = config[key];
            let typeOk;
            if (c === undefined) {
                typeOk = false;
                badReason = `Missing "${key}", expected ${type}`;
            } else {
                switch (type) {
                    case 'string':
                        typeOk = _.isString(c);
                        break;
                    case 'object':
                        typeOk = _.isObject(c);
                        break;
                    case 'array':
                        typeOk = Array.isArray(c);
                        break;
                    case 'number':
                        typeOk = !isNaN(parseInt(c));
                        break;
                    default:
                        typeOk = false;
                        badReason = `Don't know how to validate ${type}`;
                        break;
                }
            }
            if (!typeOk) {
                firstBadKey = key;
                if (!badReason) {
                    badReason = `Expected ${type}`;
                }
            }
            return typeOk;
        });

        return cb(
            good
                ? null
                : Errors.Invalid(
                      `Invalid or missing config option "${firstBadKey}" (${badReason})`
                  )
        );
    }

    //  Various common helpers
    getDateFormat(defaultStyle = 'short') {
        return (
            this.config.dateFormat ||
            this.client.currentTheme.helpers.getDateFormat(defaultStyle)
        );
    }

    getTimeFormat(defaultStyle = 'short') {
        return (
            this.config.timeFormat ||
            this.client.currentTheme.helpers.getTimeFormat(defaultStyle)
        );
    }

    getDateTimeFormat(defaultStyle = 'short') {
        return (
            this.config.dateTimeFormat ||
            this.client.currentTheme.helpers.getDateTimeFormat(defaultStyle)
        );
    }
};
