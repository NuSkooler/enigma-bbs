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
const Errors = require('../core/enig_error.js').Errors;
const { getPredefinedMCIValue } = require('../core/predefined_mci.js');
const EnigAssert = require('./enigma_assert');
const { pipeToAnsi } = require('./color_codes.js');

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

exports.MenuModule = class MenuModule extends PluginModule {
    constructor(options) {
        super(options);

        this.menuName = options.menuName;
        this.menuConfig = options.menuConfig;
        this.client = options.client;
        this.menuMethods = {}; //  methods called from @method's
        this.menuConfig.config = this.menuConfig.config || {};
        this.cls = _.get(this.menuConfig.config, 'cls', Config().menus.cls);
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

    enter() {
        this.initSequence();
    }

    leave() {
        this.detachViewControllers();
    }

    initSequence() {
        const self = this;
        const mciData = {};
        let pausePosition = { row: 0, column: 0 };

        const hasArt = () => {
            return (
                _.isString(self.menuConfig.art) ||
                (Array.isArray(self.menuConfig.art) &&
                    _.has(self.menuConfig.art[0], 'acs'))
            );
        };

        async.waterfall(
            [
                function beforeArtInterrupt(callback) {
                    return self.displayQueuedInterruptions(callback);
                },
                function beforeDisplayArt(callback) {
                    return self.beforeArt(callback);
                },
                function displayMenuArt(callback) {
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
                    return self.mciReady(mciData, callback);
                },
                function displayPauseIfRequested(callback) {
                    if (!self.shouldPause() || self.getPauseMode() === 'pageBreak') {
                        return callback(null, null);
                    }

                    if (
                        self.client.term.termHeight > 0 &&
                        pausePosition.row > self.client.termHeight
                    ) {
                        // If this scrolled, the prompt will go to the bottom of the screen
                        pausePosition.row = self.client.termHeight;
                    }

                    return self.pausePrompt(pausePosition, callback);
                },
                function finishAndNext(artInfo, callback) {
                    self.finishedLoading();
                    self.realTimeInterrupt = 'allowed';
                    return self.autoNextMenu(callback);
                },
            ],
            err => {
                if (err) {
                    self.client.log.warn('Error during init sequence', {
                        error: err.message,
                    });

                    return self.prevMenu(() => {
                        /* dummy */
                    });
                }
            }
        );
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

        this.displayQueuedInterruptions(() => {
            return this.client.menuStack.next(cb);
        });
    }

    prevMenu(cb) {
        this.displayQueuedInterruptions(() => {
            return this.client.menuStack.prev(cb);
        });
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

    gotoMenuOrShowMessage(name, message, options, cb) {
        if (!cb && _.isFunction(options)) {
            cb = options;
            options = {};
        }

        options = options || { clearScreen: true };

        this.gotoMenu(name, options, err => {
            if (err) {
                if (options.clearScreen) {
                    this.client.term.rawWrite(ansi.resetScreen());
                }

                this.client.term.write(`${message}\n`);
                return this.pausePrompt(() => {
                    return this.prevMenu(cb);
                });
            }

            if (cb) {
                return cb(null);
            }
        });
    }

    reload(cb) {
        const prevMenu = this.client.menuStack.pop();
        prevMenu.instance.leave();
        return this.client.menuStack.goto(prevMenu.name, cb);
    }

    prevMenuOnTimeout(timeout, cb) {
        setTimeout(() => {
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

        const { pages, hasAbsolutePositioning } = artUtil.paginate(artInfo.data, {
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

        //  Buffer artSpec: decode and paginate directly without fetching via name
        if (Buffer.isBuffer(artSpec)) {
            const data = iconvDecode(artSpec, artOptions.encoding || 'cp437');
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
            Object.assign({ client: self.client, name: artSpec }, artOptions),
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
                this.displayQueuedInterruptions(() => {
                    return menuUtil.handleNext(this.client, this.menuConfig.next, {}, cb);
                });
            } else {
                return this.prevMenu(cb);
            }
        };

        if (
            _.has(this.menuConfig, 'runtime.autoNext') &&
            true === this.menuConfig.runtime.autoNext
        ) {
            if (this.hasNextTimeout()) {
                setTimeout(() => {
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
            { client: this.client, font: this.menuConfig.config.font },
            options
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

    prepViewController(name, formId, mciMap, cb) {
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
                return cb(err, vc, true);
            });
        }

        this.viewControllers[name].setFocus(true);

        return cb(null, this.viewControllers[name], false);
    }

    prepViewControllerWithArt(name, formId, options, cb) {
        this.displayAsset(this.menuConfig.config.art[name], options, (err, artData) => {
            if (err) {
                return cb(err);
            }

            return this.prepViewController(name, formId, artData.mciMap, cb);
        });
    }

    optionalMoveToPosition(position) {
        if (position) {
            position.x = position.row || position.x || 1;
            position.y = position.col || position.y || 1;

            this.client.term.rawWrite(ansi.goto(position.x, position.y));
        }
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
                        { font: this.menuConfig.font, trailingLF: false },
                        (err, artData) => {
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

                        return vc.loadFromMenuConfig(loadOpts, callback);
                    }

                    this.viewControllers[name].setFocus(true);
                    return callback(null);
                },
            ],
            err => {
                return cb(err);
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

    getCustomViewsWithFilter(formName, startId, options) {
        options = options || {};

        const views = [];

        let view;
        let customMciId = startId;
        const config = this.menuConfig.config;
        const endId = options.endId || 99; //  we'll fail to get a view before 99

        while (
            customMciId <= endId &&
            (view = this.viewControllers[formName].getView(customMciId))
        ) {
            const key = `${formName}InfoFormat${customMciId}`; //  e.g. "mainInfoFormat10"
            const format = config[key];

            if (
                format &&
                (!options.filter || options.filter.find(f => format.indexOf(f) > -1))
            ) {
                view.key = key; // cache
                views.push(view);
            }

            ++customMciId;
        }

        return views;
    }

    updateCustomViewTextsWithFilter(formName, startId, fmtObj, options) {
        options = options || {};
        const views = this.getCustomViewsWithFilter(formName, startId, options);
        const config = this.menuConfig.config;

        views.forEach(view => {
            const format = config[view.key];
            const text = stringFormat(format, fmtObj);

            if (view instanceof MultiLineEditTextView) {
                if (options.appendMultiLine) {
                    view.addText(text);
                } else {
                    if (options.pipeSupport) {
                        const ansi = pipeToAnsi(text, this.client);
                        if (view.getData() !== ansi) {
                            view.setAnsi(ansi);
                        } else {
                            view.redraw();
                        }
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
