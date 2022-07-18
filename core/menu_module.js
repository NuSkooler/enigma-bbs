/* jslint node: true */
'use strict';

const PluginModule = require('./plugin_module.js').PluginModule;
const theme = require('./theme.js');
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

//  deps
const async = require('async');
const assert = require('assert');
const _ = require('lodash');
const iconvDecode = require('iconv-lite').decode;

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

                    self.displayAsset(
                        self.menuConfig.art,
                        self.menuConfig.config,
                        (err, artData) => {
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
                        }
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
                    if (!self.shouldPause()) {
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
        if (_.isNumber(this.menuConfig.config.baudRate)) {
            //  :TODO: some terminals not supporting cterm style emulated baud rate end up displaying a broken ESC sequence or a single "r" here
            this.client.term.rawWrite(
                ansi.setEmulatedBaudRate(this.menuConfig.config.baudRate)
            );
        }

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
        return (
            'end' === this.menuConfig.config.pause ||
            true === this.menuConfig.config.pause
        );
    }

    hasNextTimeout() {
        return _.isNumber(this.menuConfig.config.nextTimeout);
    }

    haveNext() {
        return _.isString(this.menuConfig.next) || _.isArray(this.menuConfig.next);
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
        const needsCreated = _.isUndefined(this.viewControllers[name]);
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

    pausePrompt(position, cb) {
        if (!cb && _.isFunction(position)) {
            cb = position;
            position = null;
        }

        this.optionalMoveToPosition(position);

        return theme.displayThemedPause(this.client, { position }, cb);
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
                    if (_.isUndefined(this.viewControllers[name])) {
                        const vcOpts = {
                            client: this.client,
                            formId: formId,
                        };

                        if (!_.isUndefined(options.noInput)) {
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

    updateCustomViewTextsWithFilter(formName, startId, fmtObj, options) {
        options = options || {};

        let textView;
        let customMciId = startId;
        const config = this.menuConfig.config;
        const endId = options.endId || 99; //  we'll fail to get a view before 99

        while (
            customMciId <= endId &&
            (textView = this.viewControllers[formName].getView(customMciId))
        ) {
            const key = `${formName}InfoFormat${customMciId}`; //  e.g. "mainInfoFormat10"
            const format = config[key];

            if (
                format &&
                (!options.filter || options.filter.find(f => format.indexOf(f) > -1))
            ) {
                const text = stringFormat(format, fmtObj);

                if (
                    options.appendMultiLine &&
                    textView instanceof MultiLineEditTextView
                ) {
                    textView.addText(text);
                } else if (textView.getData() != text) {
                    textView.setText(text);
                }
            }

            ++customMciId;
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
            if (_.isUndefined(c)) {
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
