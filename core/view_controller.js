'use strict';

//  ENiGMA½
const { MCIViewFactory } = require('./mci_view_factory.js');
const menuUtil = require('./menu_util.js');
const asset = require('./asset.js');
const ansi = require('./ansi_term.js');

//  deps
const events = require('events');
const assert = require('assert');
const async = require('async');
const _ = require('lodash');
const paths = require('path');

const MCI_REGEXP = /([A-Z]{2})([0-9]{1,2})/;

class ViewController extends events.EventEmitter {
    constructor(options) {
        assert(_.isObject(options));
        assert(_.isObject(options.client));

        super();

        this.client = options.client;
        this.views = {}; //  map of ID -> view
        this.formId = options.formId || 0;
        this.mciViewFactory = new MCIViewFactory(this.client); //  :TODO: can this not be a singleton?
        this.noInput = _.isBoolean(options.noInput) ? options.noInput : false;
        this.actionKeyMap = {};

        //
        //  clientKeyPressHandler uses arrow function so `this` is always the ViewController.
        //  It needs a stable reference for attach/detachClientEvents.
        //
        this.clientKeyPressHandler = (ch, key) => {
            //
            //  Process key presses treating form submit mapped keys special.
            //  Everything else is forwarded on to the focused View, if any.
            //
            const actionForKey = key
                ? this.actionKeyMap[key.name]
                : this.actionKeyMap[ch];
            if (actionForKey) {
                if (_.isNumber(actionForKey.viewId)) {
                    //
                    //  Key works on behalf of a view -- switch focus & submit
                    //
                    this.switchFocus(actionForKey.viewId);
                    this.submitForm(key);
                } else if (_.isString(actionForKey.action)) {
                    const formData = this.getFocusedView() ? this.getFormData() : {};
                    this.handleActionWrapper(
                        Object.assign({ ch: ch, key: key }, formData), //  formData + key info
                        actionForKey
                    ); //  actionBlock
                }
            } else {
                if (this.focusedView && this.focusedView.acceptsInput) {
                    this.focusedView.onKeyPress(ch, key);
                }
            }
        };

        //
        //  viewActionListener must remain a regular function so that `this` inside
        //  the callback is the emitting view (Node.js EventEmitter behavior).
        //  We close over `self` to reference the ViewController.
        //
        const self = this;
        this.viewActionListener = function (action, key) {
            switch (action) {
                case 'next':
                    self.emit('action', { view: this, action: action, key: key });
                    self.nextFocus();
                    break;

                case 'accept':
                    if (self.focusedView && self.focusedView.submit) {
                        //  :TODO: need to do validation here!!!
                        const focusedView = self.focusedView;
                        self.validateView(
                            focusedView,
                            function validated(err, newFocusedViewId) {
                                if (err) {
                                    const newFocusedView =
                                        self.getView(newFocusedViewId) || focusedView;
                                    self.setViewFocusWithEvents(newFocusedView, true);
                                } else {
                                    self.submitForm(key);
                                }
                            }
                        );
                    } else {
                        self.nextFocus();
                    }
                    break;
            }
        };

        if (!options.detached) {
            this.attachClientEvents();
        }
    }

    //
    //  Small wrapper/proxy around handleAction() to ensure we do not allow
    //  input/additional actions queued while performing an action
    //
    handleActionWrapper(formData, actionBlock, cb) {
        if (this.waitActionCompletion) {
            if (cb) {
                return cb(null);
            }
            return; //  ignore until this is finished!
        }

        this.client.log.trace({ actionBlock }, 'Action match');

        this.waitActionCompletion = true;
        menuUtil.handleAction(this.client, formData, actionBlock, err => {
            if (err) {
                //  :TODO: What can we really do here?
                if ('ALREADYTHERE' === err.reasonCode) {
                    this.client.log.trace(err.reason);
                } else {
                    this.client.log.warn({ err: err }, 'Error during handleAction()');
                }
            }

            this.waitActionCompletion = false;
            if (cb) {
                return cb(null);
            }
        });
    }

    submitForm(key) {
        this.emit('submit', this.getFormData(key));
    }

    getLogFriendlyFormData(formData) {
        const safeFormData = _.cloneDeep(formData);
        if (safeFormData.value.password) {
            safeFormData.value.password = '*****';
        }
        if (safeFormData.value.passwordConfirm) {
            safeFormData.value.passwordConfirm = '*****';
        }
        return safeFormData;
    }

    switchFocusEvent(event, view) {
        if (this.emitSwitchFocus) {
            return;
        }

        this.emitSwitchFocus = true;
        this.emit(event, view);
        this.emitSwitchFocus = false;
    }

    setViewFocusWithEvents(view, focused) {
        if (!view || !view.acceptsFocus) {
            return;
        }

        if (focused) {
            this.switchFocusEvent('return', view);
            this.focusedView = view;
        } else {
            this.switchFocusEvent('leave', view);
        }

        view.setFocus(focused);
    }

    validateView(view, cb) {
        if (view && _.isFunction(view.validate)) {
            view.validate(view.getData(), err => {
                const viewValidationListener =
                    this.client.currentMenuModule.menuMethods.viewValidationListener;
                if (_.isFunction(viewValidationListener)) {
                    if (err) {
                        err.view = view; //  pass along the view that failed
                        err.friendlyText = err.reason || err.message;
                    }

                    viewValidationListener(err, (err, newFocusedViewId) => {
                        // validator may have updated |err|
                        return cb(err, newFocusedViewId);
                    });
                } else {
                    cb(err);
                }
            });
        } else {
            cb(null);
        }
    }

    createViewsFromMCI(mciMap, cb) {
        const views = [];

        async.each(
            Object.keys(mciMap),
            (name, nextItem) => {
                const mci = mciMap[name];
                const view = this.mciViewFactory.createFromMCI(mci);

                if (view) {
                    if (false === this.noInput) {
                        view.on('action', this.viewActionListener);
                    }

                    views.push(view);
                    this.addView(view);
                }

                return nextItem(null);
            },
            err => {
                this.setViewOrder();
                return cb(err, views);
            }
        );
    }

    //  :TODO: move this elsewhere
    setViewPropertiesFromMCIConf(view, conf) {
        for (const propName in conf) {
            const propAsset = asset.getViewPropertyAsset(conf[propName]);
            let propValue;

            if (propAsset) {
                switch (propAsset.type) {
                    case 'config':
                        propValue = asset.resolveConfigAsset(conf[propName]);
                        break;

                    case 'sysStat':
                        propValue = asset.resolveSystemStatAsset(conf[propName]);
                        break;

                    //  :TODO: handle @art (e.g. text : @art ...)

                    case 'method':
                    case 'systemMethod':
                        if ('validate' === propName) {
                            //  :TODO: handle propAsset.location for @method script specification
                            if ('systemMethod' === propAsset.type) {
                                //  :TODO: implementation validation @systemMethod handling!
                                const methodModule = require(
                                    paths.join(__dirname, 'system_view_validate.js')
                                );
                                if (_.isFunction(methodModule[propAsset.asset])) {
                                    propValue = methodModule[propAsset.asset];
                                }
                            } else {
                                if (
                                    _.isFunction(
                                        this.client.currentMenuModule.menuMethods[
                                            propAsset.asset
                                        ]
                                    )
                                ) {
                                    propValue =
                                        this.client.currentMenuModule.menuMethods[
                                            propAsset.asset
                                        ];
                                }
                            }
                        } else {
                            if (_.isString(propAsset.location)) {
                                // :TODO: clean this code up!
                            } else {
                                if ('systemMethod' === propAsset.type) {
                                    //  :TODO:
                                } else {
                                    //  local to current module
                                    const currentModule = this.client.currentMenuModule;
                                    if (
                                        _.isFunction(
                                            currentModule.menuMethods[propAsset.asset]
                                        )
                                    ) {
                                        //  :TODO: Fix formData & extraArgs... this all needs general processing
                                        propValue = currentModule.menuMethods[
                                            propAsset.asset
                                        ]({}, {}); //formData, conf.extraArgs);
                                    }
                                }
                            }
                        }
                        break;

                    default:
                        propValue = conf[propName];
                        break;
                }
            } else {
                propValue = conf[propName];
            }

            if (!_.isUndefined(propValue)) {
                view.setPropertyValue(propName, propValue);
            }
        }
    }

    applyViewConfig(config, cb) {
        let highestId = 1;
        let submitId;
        let initialFocusId = 1;

        async.each(
            Object.keys(config.mci || {}),
            (mci, nextItem) => {
                const mciMatch = mci.match(MCI_REGEXP); //  :TODO: How to handle auto-generated IDs????
                if (null === mciMatch) {
                    this.client.log.warn({ mci: mci }, 'Unable to parse MCI code');
                    return;
                }

                const viewId = parseInt(mciMatch[2]);
                assert(!isNaN(viewId), 'Cannot parse view ID: ' + mciMatch[2]); //  shouldn't be possible with RegExp used

                if (viewId > highestId) {
                    highestId = viewId;
                }

                const view = this.getView(viewId);

                if (!view) {
                    return nextItem(null);
                }

                const mciConf = config.mci[mci];

                this.setViewPropertiesFromMCIConf(view, mciConf);

                if (mciConf.focus) {
                    initialFocusId = viewId;
                }

                if (true === view.submit) {
                    submitId = viewId;
                }

                nextItem(null);
            },
            err => {
                //  default to highest ID if no 'submit' entry present
                if (!submitId) {
                    const highestIdView = this.getView(highestId);
                    if (highestIdView) {
                        highestIdView.submit = true;
                    }
                }

                return cb(err, { initialFocusId: initialFocusId });
            }
        );
    }

    //  method for comparing submitted form data to configuration entries
    actionBlockValueComparator(formValue, actionValue) {
        //
        //  For a match to occur, one of the following must be true:
        //
        //  *   actionValue is a Object:
        //      a)  All key/values must exactly match
        //      b)  value is null; The key (view ID or "argName") must be present
        //          in formValue. This is a wildcard/any match.
        //  *   actionValue is a Number: This represents a view ID that
        //      must be present in formValue.
        //  *   actionValue is a string: This represents a view with
        //      "argName" set that must be present in formValue.
        //
        if (_.isUndefined(actionValue)) {
            return false;
        }

        if (_.isNumber(actionValue) || _.isString(actionValue)) {
            if (_.isUndefined(formValue[actionValue])) {
                return false;
            }
        } else {
            /*
                :TODO: support:
                value: {
                    someArgName: [ "key1", "key2", ... ],
                    someOtherArg: [ "key1, ... ]
                }
            */
            const actionValueKeys = Object.keys(actionValue);
            for (let i = 0; i < actionValueKeys.length; ++i) {
                const viewId = actionValueKeys[i];
                if (!_.has(formValue, viewId)) {
                    return false;
                }

                if (
                    null !== actionValue[viewId] &&
                    actionValue[viewId] !== formValue[viewId]
                ) {
                    return false;
                }
            }
        }
        return true;
    }

    attachClientEvents() {
        if (this.attached) {
            return;
        }

        this.client.on('key press', this.clientKeyPressHandler);

        Object.keys(this.views).forEach(i => {
            //  remove, then add to ensure we only have one listener
            this.views[i].removeListener('action', this.viewActionListener);
            this.views[i].on('action', this.viewActionListener);
        });

        this.attached = true;
    }

    detachClientEvents() {
        if (!this.attached) {
            return;
        }

        this.client.removeListener('key press', this.clientKeyPressHandler);

        for (const id in this.views) {
            this.views[id].removeAllListeners();
        }

        this.attached = false;
    }

    viewExists(id) {
        return id in this.views;
    }

    addView(view) {
        assert(!this.viewExists(view.id), 'View with ID ' + view.id + ' already exists');

        this.views[view.id] = view;
    }

    getView(id) {
        return this.views[id];
    }

    hasView(id) {
        return this.getView(id) ? true : false;
    }

    getViewsByMciCode(mciCode) {
        if (!Array.isArray(mciCode)) {
            mciCode = [mciCode];
        }

        const views = [];
        _.each(this.views, v => {
            if (mciCode.includes(v.mciCode)) {
                views.push(v);
            }
        });
        return views;
    }

    getFocusedView() {
        return this.focusedView;
    }

    setFocus(focused) {
        if (focused) {
            this.attachClientEvents();
        } else {
            this.detachClientEvents();
        }

        this.setViewFocusWithEvents(this.focusedView, focused);
    }

    resetInitialFocus() {
        if (this.formInitialFocusId) {
            return this.switchFocus(this.formInitialFocusId);
        }
    }

    applyViewOffsets(views, offsetCol, offsetRow, force = false) {
        if (!Array.isArray(views)) {
            views = [views];
        }

        views.forEach(view => {
            if (force || !view.offsetsApplied) {
                view.offsetsApplied = true;
                view.setPosition({
                    col: view.position.col + offsetCol,
                    row: view.position.row + offsetRow,
                });
            }
        });
    }

    switchFocus(id) {
        //
        //  Perform focus switching validation now
        //
        const focusedView = this.focusedView;

        this.validateView(focusedView, (err, newFocusedViewId) => {
            if (err) {
                const newFocusedView = this.getView(newFocusedViewId) || focusedView;
                this.setViewFocusWithEvents(newFocusedView, true);
            } else {
                this.attachClientEvents();

                //  remove from old
                this.setViewFocusWithEvents(focusedView, false);

                //  set to new
                this.setViewFocusWithEvents(this.getView(id), true);
            }
        });
    }

    nextFocus() {
        let nextFocusView = this.focusedView ? this.focusedView : this.views[this.firstId];

        //  find the next view that accepts focus
        while (nextFocusView && nextFocusView.nextId) {
            nextFocusView = this.getView(nextFocusView.nextId);
            if (!nextFocusView || nextFocusView.acceptsFocus) {
                break;
            }
        }

        if (nextFocusView && this.focusedView !== nextFocusView) {
            this.switchFocus(nextFocusView.id);
        }
    }

    setViewOrder(order) {
        const viewIdOrder = order || [];

        if (0 === viewIdOrder.length) {
            for (const id in this.views) {
                if (this.views[id].acceptsFocus) {
                    viewIdOrder.push(id);
                }
            }

            viewIdOrder.sort(function intSort(a, b) {
                return a - b;
            });
        }

        if (viewIdOrder.length > 0) {
            const count = viewIdOrder.length - 1;
            for (let i = 0; i < count; ++i) {
                this.views[viewIdOrder[i]].nextId = viewIdOrder[i + 1];
            }

            this.firstId = viewIdOrder[0];
            const lastId =
                viewIdOrder.length > 1 ? viewIdOrder[viewIdOrder.length - 1] : this.firstId;
            this.views[lastId].nextId = this.firstId;
        }
    }

    redrawAll(initialFocusId) {
        this.client.term.rawWrite(ansi.hideCursor());

        for (const id in this.views) {
            if (initialFocusId === id) {
                continue; //  will draw @ focus
            }
            this.views[id].redraw();
        }

        this.client.term.rawWrite(ansi.showCursor());
    }

    loadFromPromptConfig(options, cb) {
        assert(_.isObject(options));
        assert(_.isObject(options.mciMap));

        let initialFocusId = 1; //  default to first
        const promptConfig = _.isObject(options.config)
            ? options.config
            : this.client.currentMenuModule.menuConfig.promptConfig;

        async.waterfall(
            [
                callback => {
                    this.createViewsFromMCI(options.mciMap, err => {
                        callback(err);
                    });
                },
                callback => {
                    if (promptConfig && _.isObject(promptConfig.mci)) {
                        this.applyViewConfig(promptConfig, (err, info) => {
                            initialFocusId = info.initialFocusId;
                            callback(err);
                        });
                    } else {
                        callback(null);
                    }
                },
                callback => {
                    if (false === this.noInput) {
                        this.on('submit', formData => {
                            this.client.log.trace({ formData }, 'Prompt submit');

                            const doSubmitNotify = () => {
                                if (options.submitNotify) {
                                    options.submitNotify();
                                }
                            };

                            const handleIt = (fd, conf) => {
                                this.handleActionWrapper(fd, conf, () => {
                                    doSubmitNotify();
                                });
                            };

                            if (
                                _.isString(
                                    this.client.currentMenuModule.menuConfig.action
                                )
                            ) {
                                handleIt(
                                    formData,
                                    this.client.currentMenuModule.menuConfig
                                );
                            } else {
                                //
                                //  Menus that reference prompts can have a special "submit" block without the
                                //  hassle of by-form-id configurations, etc.
                                //
                                //  "submit" : [
                                //      { ... }
                                //  ]
                                //
                                const menuConfig =
                                    this.client.currentMenuModule.menuConfig;
                                let submitConf;
                                if (Array.isArray(menuConfig.submit)) {
                                    //  standalone prompts
                                    submitConf = menuConfig.submit;
                                } else {
                                    //  look for embedded prompt configurations - using their own form ID within the menu
                                    submitConf =
                                        _.get(menuConfig, [
                                            'form',
                                            formData.id,
                                            'submit',
                                            formData.submitId,
                                        ]) ||
                                        _.get(menuConfig, [
                                            'form',
                                            formData.id,
                                            'submit',
                                            '*',
                                        ]);
                                }

                                if (!Array.isArray(submitConf)) {
                                    doSubmitNotify();
                                    return this.client.log.debug(
                                        'No configuration to handle submit'
                                    );
                                }

                                //  locate any matching action block
                                const actionBlock = submitConf.find(actionBlock =>
                                    _.isEqualWith(
                                        formData.value,
                                        actionBlock.value,
                                        this.actionBlockValueComparator.bind(this)
                                    )
                                );
                                if (actionBlock) {
                                    handleIt(formData, actionBlock);
                                } else {
                                    doSubmitNotify();
                                }
                            }
                        });
                    }

                    callback(null);
                },
                callback => {
                    if (!_.isObject(promptConfig) || !_.isArray(promptConfig.actionKeys)) {
                        return callback(null);
                    }

                    promptConfig.actionKeys.forEach(ak => {
                        //
                        //  *   'keys' must be present and be an array of key names
                        //  *   If 'viewId' is present, key(s) will focus & submit on behalf
                        //      of the specified view.
                        //  *   If 'action' is present, that action will be procesed when
                        //      triggered by key(s)
                        //
                        //  Ultimately, create a map of key -> { action block }
                        //
                        if (!_.isArray(ak.keys)) {
                            return;
                        }

                        ak.keys.forEach(kn => {
                            this.actionKeyMap[kn] = ak;
                        });
                    });

                    return callback(null);
                },
                callback => {
                    this.redrawAll(initialFocusId);
                    callback(null);
                },
                callback => {
                    if (initialFocusId) {
                        this.switchFocus(initialFocusId);
                    }
                    callback(null);
                },
            ],
            err => {
                cb(err);
            }
        );
    }

    loadFromMenuConfig(options, cb) {
        assert(_.isObject(options));

        if (!_.isObject(options.mciMap)) {
            cb(new Error('Missing option: mciMap'));
            return;
        }

        const formIdKey = options.formId ? options.formId.toString() : '0';
        this.formInitialFocusId = 1; //  default to first
        let formConfig;

        //  :TODO: honor options.withoutForm

        async.waterfall(
            [
                callback => {
                    menuUtil.getFormConfigByIDAndMap(
                        this.client.currentMenuModule.menuConfig,
                        formIdKey,
                        options.mciMap,
                        (err, fc) => {
                            formConfig = fc;

                            if (err) {
                                //  non-fatal
                                this.client.log.trace(
                                    {
                                        reason: err.message,
                                        mci: Object.keys(options.mciMap),
                                        formId: formIdKey,
                                    },
                                    'Unable to find matching form configuration'
                                );
                            }

                            callback(null);
                        }
                    );
                },
                callback => {
                    this.createViewsFromMCI(options.mciMap, (err, views) => {
                        if (!err && _.isObject(options.viewOffsets)) {
                            this.applyViewOffsets(
                                views,
                                options.viewOffsets.col,
                                options.viewOffsets.row
                            );
                        }
                        callback(err);
                    });
                },
                /*
                callback => {
                    formConfig = formConfig || {};
                    formConfig.mci = formConfig.mci || {};

                    menuUtil.applyMciThemeCustomization({
                        name        : this.client.currentMenuModule.menuName,
                        type        : 'menus',
                        client      : this.client,
                        mci         : formConfig.mci,
                        formId      : formIdKey,
                    });

                    callback(null);
                },
                */
                callback => {
                    if (_.isObject(formConfig)) {
                        this.applyViewConfig(formConfig, (err, info) => {
                            this.formInitialFocusId = info.initialFocusId;
                            callback(err);
                        });
                    } else {
                        callback(null);
                    }
                },
                callback => {
                    if (!_.isObject(formConfig) || !_.isObject(formConfig.submit)) {
                        callback(null);
                        return;
                    }

                    this.on('submit', formData => {
                        this.client.log.trace({ formData }, 'Form submit');

                        //
                        //  Locate configuration for this form ID
                        //
                        const confForFormId =
                            _.get(formConfig, ['submit', formData.submitId]) ||
                            _.get(formConfig, ['submit', '*']);

                        if (!Array.isArray(confForFormId)) {
                            return this.client.log.debug(
                                { formId: formData.submitId },
                                'No configuration for form ID'
                            );
                        }

                        //  locate a matching action block, if any
                        const actionBlock = confForFormId.find(actionBlock =>
                            _.isEqualWith(
                                formData.value,
                                actionBlock.value,
                                this.actionBlockValueComparator.bind(this)
                            )
                        );
                        if (actionBlock) {
                            this.handleActionWrapper(formData, actionBlock);
                        }
                    });

                    callback(null);
                },
                callback => {
                    if (!_.isObject(formConfig) || !_.isArray(formConfig.actionKeys)) {
                        callback(null);
                        return;
                    }

                    formConfig.actionKeys.forEach(ak => {
                        //
                        //  *   'keys' must be present and be an array of key names
                        //  *   If 'viewId' is present, key(s) will focus & submit on behalf
                        //      of the specified view.
                        //  *   If 'action' is present, that action will be procesed when
                        //      triggered by key(s)
                        //
                        //  Ultimately, create a map of key -> { action block }
                        //
                        if (!_.isArray(ak.keys)) {
                            return;
                        }

                        ak.keys.forEach(kn => {
                            this.actionKeyMap[kn] = ak;
                        });
                    });

                    callback(null);
                },
                callback => {
                    this.redrawAll(this.formInitialFocusId);
                    callback(null);
                },
                callback => {
                    if (this.formInitialFocusId) {
                        this.switchFocus(this.formInitialFocusId);
                    }
                    callback(null);
                },
            ],
            err => {
                if (_.isFunction(cb)) {
                    cb(err);
                }
            }
        );
    }

    formatMCIString(format) {
        return format.replace(/{(\d+)}/g, (match, number) => {
            const view = this.getView(number);

            if (!view) {
                return match;
            }

            return view.getData();
        });
    }

    getFormData(key) {
        /*
            Example form data:
            {
                id : 0,
                submitId : 1,
                value : {
                    "1" : "hurp",
                    "2" : [ 'a', 'b', ... ],
                    "3" 2,
                    "pants" : "no way"
                }

            }
        */
        const formData = {
            id: this.formId,
            submitId: this.focusedView.id,
            value: {},
        };

        if (key) {
            formData.key = key;
        }

        _.each(this.views, view => {
            try {
                //  don't fill forms with static, non user-editable data data
                if (!view.acceptsInput) {
                    return;
                }

                //  some form values may be omitted from submission all together
                if (view.omitFromSubmission) {
                    return;
                }

                const viewData = view.getData();
                if (_.isUndefined(viewData)) {
                    return;
                }

                formData.value[view.submitArgName ? view.submitArgName : view.id] =
                    viewData;
            } catch (e) {
                this.client.log.error(
                    { error: e.message },
                    'Exception caught gathering form data'
                );
            }
        });

        return formData;
    }
}

exports.ViewController = ViewController;
