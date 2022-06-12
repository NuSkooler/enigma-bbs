/* jslint node: true */
'use strict';

//  ENiGMA½
var MCIViewFactory = require('./mci_view_factory.js').MCIViewFactory;
var menuUtil = require('./menu_util.js');
var asset = require('./asset.js');
var ansi = require('./ansi_term.js');

//  deps
var events = require('events');
var util = require('util');
var assert = require('assert');
var async = require('async');
var _ = require('lodash');
var paths = require('path');

exports.ViewController = ViewController;

var MCI_REGEXP = /([A-Z]{2})([0-9]{1,2})/;

function ViewController(options) {
    assert(_.isObject(options));
    assert(_.isObject(options.client));

    events.EventEmitter.call(this);

    var self = this;

    this.client = options.client;
    this.views = {}; //  map of ID -> view
    this.formId = options.formId || 0;
    this.mciViewFactory = new MCIViewFactory(this.client); //  :TODO: can this not be a singleton?
    this.noInput = _.isBoolean(options.noInput) ? options.noInput : false;
    this.actionKeyMap = {};

    //
    //  Small wrapper/proxy around handleAction() to ensure we do not allow
    //  input/additional actions queued while performing an action
    //
    this.handleActionWrapper = function (formData, actionBlock, cb) {
        if (self.waitActionCompletion) {
            if (cb) {
                return cb(null);
            }
            return; //  ignore until this is finished!
        }

        self.client.log.trace({ actionBlock }, 'Action match');

        self.waitActionCompletion = true;
        menuUtil.handleAction(self.client, formData, actionBlock, err => {
            if (err) {
                //  :TODO: What can we really do here?
                if ('ALREADYTHERE' === err.reasonCode) {
                    self.client.log.trace(err.reason);
                } else {
                    self.client.log.warn({ err: err }, 'Error during handleAction()');
                }
            }

            self.waitActionCompletion = false;
            if (cb) {
                return cb(null);
            }
        });
    };

    this.clientKeyPressHandler = function (ch, key) {
        //
        //  Process key presses treating form submit mapped keys special.
        //  Everything else is forwarded on to the focused View, if any.
        //
        var actionForKey = key ? self.actionKeyMap[key.name] : self.actionKeyMap[ch];
        if (actionForKey) {
            if (_.isNumber(actionForKey.viewId)) {
                //
                //  Key works on behalf of a view -- switch focus & submit
                //
                self.switchFocus(actionForKey.viewId);
                self.submitForm(key);
            } else if (_.isString(actionForKey.action)) {
                const formData = self.getFocusedView() ? self.getFormData() : {};
                self.handleActionWrapper(
                    Object.assign({ ch: ch, key: key }, formData), //  formData + key info
                    actionForKey
                ); //  actionBlock
            }
        } else {
            if (self.focusedView && self.focusedView.acceptsInput) {
                self.focusedView.onKeyPress(ch, key);
            }
        }
    };

    this.viewActionListener = function (action, key) {
        switch (action) {
            case 'next':
                self.emit('action', { view: this, action: action, key: key });
                self.nextFocus();
                break;

            case 'accept':
                if (self.focusedView && self.focusedView.submit) {
                    //  :TODO: need to do validation here!!!
                    var focusedView = self.focusedView;
                    self.validateView(
                        focusedView,
                        function validated(err, newFocusedViewId) {
                            if (err) {
                                var newFocusedView =
                                    self.getView(newFocusedViewId) || focusedView;
                                self.setViewFocusWithEvents(newFocusedView, true);
                            } else {
                                self.submitForm(key);
                            }
                        }
                    );
                    //self.submitForm(key);
                } else {
                    self.nextFocus();
                }
                break;
        }
    };

    this.submitForm = function (key) {
        self.emit('submit', this.getFormData(key));
    };

    this.getLogFriendlyFormData = function (formData) {
        var safeFormData = _.cloneDeep(formData);
        if (safeFormData.value.password) {
            safeFormData.value.password = '*****';
        }
        if (safeFormData.value.passwordConfirm) {
            safeFormData.value.passwordConfirm = '*****';
        }
        return safeFormData;
    };

    this.switchFocusEvent = function (event, view) {
        if (self.emitSwitchFocus) {
            return;
        }

        self.emitSwitchFocus = true;
        self.emit(event, view);
        self.emitSwitchFocus = false;
    };

    this.createViewsFromMCI = function (mciMap, cb) {
        async.each(
            Object.keys(mciMap),
            (name, nextItem) => {
                const mci = mciMap[name];
                const view = self.mciViewFactory.createFromMCI(mci);

                if (view) {
                    if (false === self.noInput) {
                        view.on('action', self.viewActionListener);
                    }

                    self.addView(view);
                }

                return nextItem(null);
            },
            err => {
                self.setViewOrder();
                return cb(err);
            }
        );
    };

    //  :TODO: move this elsewhere
    this.setViewPropertiesFromMCIConf = function (view, conf) {
        var propAsset;
        var propValue;

        for (var propName in conf) {
            propAsset = asset.getViewPropertyAsset(conf[propName]);
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
                                var methodModule = require(paths.join(
                                    __dirname,
                                    'system_view_validate.js'
                                ));
                                if (_.isFunction(methodModule[propAsset.asset])) {
                                    propValue = methodModule[propAsset.asset];
                                }
                            } else {
                                if (
                                    _.isFunction(
                                        self.client.currentMenuModule.menuMethods[
                                            propAsset.asset
                                        ]
                                    )
                                ) {
                                    propValue =
                                        self.client.currentMenuModule.menuMethods[
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
                                    var currentModule = self.client.currentMenuModule;
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
    };

    this.applyViewConfig = function (config, cb) {
        let highestId = 1;
        let submitId;
        let initialFocusId = 1;

        async.each(
            Object.keys(config.mci || {}),
            function entry(mci, nextItem) {
                const mciMatch = mci.match(MCI_REGEXP); //  :TODO: How to handle auto-generated IDs????
                if (null === mciMatch) {
                    self.client.log.warn({ mci: mci }, 'Unable to parse MCI code');
                    return;
                }

                const viewId = parseInt(mciMatch[2]);
                assert(!isNaN(viewId), 'Cannot parse view ID: ' + mciMatch[2]); //  shouldn't be possible with RegExp used

                if (viewId > highestId) {
                    highestId = viewId;
                }

                const view = self.getView(viewId);

                if (!view) {
                    return nextItem(null);
                }

                const mciConf = config.mci[mci];

                self.setViewPropertiesFromMCIConf(view, mciConf);

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
                    const highestIdView = self.getView(highestId);
                    if (highestIdView) {
                        highestIdView.submit = true;
                    }
                }

                return cb(err, { initialFocusId: initialFocusId });
            }
        );
    };

    //  method for comparing submitted form data to configuration entries
    this.actionBlockValueComparator = function (formValue, actionValue) {
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
            var actionValueKeys = Object.keys(actionValue);
            for (var i = 0; i < actionValueKeys.length; ++i) {
                var viewId = actionValueKeys[i];
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
    };

    if (!options.detached) {
        this.attachClientEvents();
    }

    this.setViewFocusWithEvents = function (view, focused) {
        if (!view || !view.acceptsFocus) {
            return;
        }

        if (focused) {
            self.switchFocusEvent('return', view);
            self.focusedView = view;
        } else {
            self.switchFocusEvent('leave', view);
        }

        view.setFocus(focused);
    };

    this.validateView = function (view, cb) {
        if (view && _.isFunction(view.validate)) {
            view.validate(view.getData(), function validateResult(err) {
                var viewValidationListener =
                    self.client.currentMenuModule.menuMethods.viewValidationListener;
                if (_.isFunction(viewValidationListener)) {
                    if (err) {
                        err.view = view; //  pass along the view that failed
                    }

                    viewValidationListener(
                        err,
                        function validationComplete(newViewFocusId) {
                            cb(err, newViewFocusId);
                        }
                    );
                } else {
                    cb(err);
                }
            });
        } else {
            cb(null);
        }
    };
}

util.inherits(ViewController, events.EventEmitter);

ViewController.prototype.attachClientEvents = function () {
    if (this.attached) {
        return;
    }

    var self = this;

    this.client.on('key press', this.clientKeyPressHandler);

    Object.keys(this.views).forEach(function vid(i) {
        //  remove, then add to ensure we only have one listener
        self.views[i].removeListener('action', self.viewActionListener);
        self.views[i].on('action', self.viewActionListener);
    });

    this.attached = true;
};

ViewController.prototype.detachClientEvents = function () {
    if (!this.attached) {
        return;
    }

    this.client.removeListener('key press', this.clientKeyPressHandler);

    for (var id in this.views) {
        this.views[id].removeAllListeners();
    }

    this.attached = false;
};

ViewController.prototype.viewExists = function (id) {
    return id in this.views;
};

ViewController.prototype.addView = function (view) {
    assert(!this.viewExists(view.id), 'View with ID ' + view.id + ' already exists');

    this.views[view.id] = view;
};

ViewController.prototype.getView = function (id) {
    return this.views[id];
};

ViewController.prototype.hasView = function (id) {
    return this.getView(id) ? true : false;
};

ViewController.prototype.getViewsByMciCode = function (mciCode) {
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
};

ViewController.prototype.getFocusedView = function () {
    return this.focusedView;
};

ViewController.prototype.setFocus = function (focused) {
    if (focused) {
        this.attachClientEvents();
    } else {
        this.detachClientEvents();
    }

    this.setViewFocusWithEvents(this.focusedView, focused);
};

ViewController.prototype.resetInitialFocus = function () {
    if (this.formInitialFocusId) {
        return this.switchFocus(this.formInitialFocusId);
    }
};

ViewController.prototype.switchFocus = function (id) {
    //
    //  Perform focus switching validation now
    //
    var self = this;
    var focusedView = self.focusedView;

    self.validateView(focusedView, function validated(err, newFocusedViewId) {
        if (err) {
            var newFocusedView = self.getView(newFocusedViewId) || focusedView;
            self.setViewFocusWithEvents(newFocusedView, true);
        } else {
            self.attachClientEvents();

            //  remove from old
            self.setViewFocusWithEvents(focusedView, false);

            //  set to new
            self.setViewFocusWithEvents(self.getView(id), true);
        }
    });
};

ViewController.prototype.nextFocus = function () {
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
};

ViewController.prototype.setViewOrder = function (order) {
    var viewIdOrder = order || [];

    if (0 === viewIdOrder.length) {
        for (var id in this.views) {
            if (this.views[id].acceptsFocus) {
                viewIdOrder.push(id);
            }
        }

        viewIdOrder.sort(function intSort(a, b) {
            return a - b;
        });
    }

    if (viewIdOrder.length > 0) {
        var count = viewIdOrder.length - 1;
        for (var i = 0; i < count; ++i) {
            this.views[viewIdOrder[i]].nextId = viewIdOrder[i + 1];
        }

        this.firstId = viewIdOrder[0];
        var lastId =
            viewIdOrder.length > 1 ? viewIdOrder[viewIdOrder.length - 1] : this.firstId;
        this.views[lastId].nextId = this.firstId;
    }
};

ViewController.prototype.redrawAll = function (initialFocusId) {
    this.client.term.rawWrite(ansi.hideCursor());

    for (var id in this.views) {
        if (initialFocusId === id) {
            continue; //  will draw @ focus
        }
        this.views[id].redraw();
    }

    this.client.term.rawWrite(ansi.showCursor());
};

ViewController.prototype.loadFromPromptConfig = function (options, cb) {
    assert(_.isObject(options));
    assert(_.isObject(options.mciMap));

    var self = this;
    var promptConfig = _.isObject(options.config)
        ? options.config
        : self.client.currentMenuModule.menuConfig.promptConfig;
    var initialFocusId = 1; //  default to first

    async.waterfall(
        [
            function createViewsFromMCI(callback) {
                self.createViewsFromMCI(options.mciMap, function viewsCreated(err) {
                    callback(err);
                });
            },
            function applyViewConfiguration(callback) {
                if (_.isObject(promptConfig.mci)) {
                    self.applyViewConfig(promptConfig, function configApplied(err, info) {
                        initialFocusId = info.initialFocusId;
                        callback(err);
                    });
                } else {
                    callback(null);
                }
            },
            function prepareFormSubmission(callback) {
                if (false === self.noInput) {
                    self.on('submit', function promptSubmit(formData) {
                        self.client.log.trace({ formData }, 'Prompt submit');

                        const doSubmitNotify = () => {
                            if (options.submitNotify) {
                                options.submitNotify();
                            }
                        };

                        const handleIt = (fd, conf) => {
                            self.handleActionWrapper(fd, conf, () => {
                                doSubmitNotify();
                            });
                        };

                        if (_.isString(self.client.currentMenuModule.menuConfig.action)) {
                            handleIt(formData, self.client.currentMenuModule.menuConfig);
                        } else {
                            //
                            //  Menus that reference prompts can have a special "submit" block without the
                            //  hassle of by-form-id configurations, etc.
                            //
                            //  "submit" : [
                            //      { ... }
                            //  ]
                            //
                            const menuConfig = self.client.currentMenuModule.menuConfig;
                            let submitConf;
                            if (Array.isArray(menuConfig.submit)) {
                                //  standalone prompts)) {
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
                                return self.client.log.debug(
                                    'No configuration to handle submit'
                                );
                            }

                            //  locate any matching action block
                            const actionBlock = submitConf.find(actionBlock =>
                                _.isEqualWith(
                                    formData.value,
                                    actionBlock.value,
                                    self.actionBlockValueComparator
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
            function loadActionKeys(callback) {
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
                        self.actionKeyMap[kn] = ak;
                    });
                });

                return callback(null);
            },
            function drawAllViews(callback) {
                self.redrawAll(initialFocusId);
                callback(null);
            },
            function setInitialViewFocus(callback) {
                if (initialFocusId) {
                    self.switchFocus(initialFocusId);
                }
                callback(null);
            },
        ],
        function complete(err) {
            cb(err);
        }
    );
};

ViewController.prototype.loadFromMenuConfig = function (options, cb) {
    assert(_.isObject(options));

    if (!_.isObject(options.mciMap)) {
        cb(new Error('Missing option: mciMap'));
        return;
    }

    var self = this;
    var formIdKey = options.formId ? options.formId.toString() : '0';
    this.formInitialFocusId = 1; //  default to first
    var formConfig;

    //  :TODO: honor options.withoutForm

    async.waterfall(
        [
            function findMatchingFormConfig(callback) {
                menuUtil.getFormConfigByIDAndMap(
                    self.client.currentMenuModule.menuConfig,
                    formIdKey,
                    options.mciMap,
                    function matchingConfig(err, fc) {
                        formConfig = fc;

                        if (err) {
                            //  non-fatal
                            self.client.log.trace(
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
            function createViews(callback) {
                self.createViewsFromMCI(options.mciMap, function viewsCreated(err) {
                    callback(err);
                });
            },
            /*
            function applyThemeCustomization(callback) {
                formConfig = formConfig || {};
                formConfig.mci = formConfig.mci || {};
                //self.client.currentMenuModule.menuConfig.config = self.client.currentMenuModule.menuConfig.config || {};

                //console.log('menu config.....');
                //console.log(self.client.currentMenuModule.menuConfig)

                menuUtil.applyMciThemeCustomization({
                    name        : self.client.currentMenuModule.menuName,
                    type        : 'menus',
                    client      : self.client,
                    mci         : formConfig.mci,
                    //config        : self.client.currentMenuModule.menuConfig.config,
                    formId      : formIdKey,
                });

                //console.log('after theme...')
                //console.log(self.client.currentMenuModule.menuConfig.config)

                callback(null);
            },
            */
            function applyViewConfiguration(callback) {
                if (_.isObject(formConfig)) {
                    self.applyViewConfig(formConfig, function configApplied(err, info) {
                        self.formInitialFocusId = info.initialFocusId;
                        callback(err);
                    });
                } else {
                    callback(null);
                }
            },
            function prepareFormSubmission(callback) {
                if (!_.isObject(formConfig) || !_.isObject(formConfig.submit)) {
                    callback(null);
                    return;
                }

                self.on('submit', function formSubmit(formData) {
                    self.client.log.trace({ formData }, 'Form submit');

                    //
                    //  Locate configuration for this form ID
                    //
                    const confForFormId =
                        _.get(formConfig, ['submit', formData.submitId]) ||
                        _.get(formConfig, ['submit', '*']);

                    if (!Array.isArray(confForFormId)) {
                        return self.client.log.debug(
                            { formId: formData.submitId },
                            'No configuration for form ID'
                        );
                    }

                    //  locate a matching action block, if any
                    const actionBlock = confForFormId.find(actionBlock =>
                        _.isEqualWith(
                            formData.value,
                            actionBlock.value,
                            self.actionBlockValueComparator
                        )
                    );
                    if (actionBlock) {
                        self.handleActionWrapper(formData, actionBlock);
                    }
                });

                callback(null);
            },
            function loadActionKeys(callback) {
                if (!_.isObject(formConfig) || !_.isArray(formConfig.actionKeys)) {
                    callback(null);
                    return;
                }

                formConfig.actionKeys.forEach(function akEntry(ak) {
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

                    ak.keys.forEach(function actionKeyName(kn) {
                        self.actionKeyMap[kn] = ak;
                    });
                });

                callback(null);
            },
            function drawAllViews(callback) {
                self.redrawAll(self.formInitialFocusId);
                callback(null);
            },
            function setInitialViewFocus(callback) {
                if (self.formInitialFocusId) {
                    self.switchFocus(self.formInitialFocusId);
                }
                callback(null);
            },
        ],
        function complete(err) {
            if (_.isFunction(cb)) {
                cb(err);
            }
        }
    );
};

ViewController.prototype.formatMCIString = function (format) {
    var self = this;
    var view;

    return format.replace(/{(\d+)}/g, function replacer(match, number) {
        view = self.getView(number);

        if (!view) {
            return match;
        }

        return view.getData();
    });
};

ViewController.prototype.getFormData = function (key) {
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

    let viewData;
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

            viewData = view.getData();
            if (_.isUndefined(viewData)) {
                return;
            }

            formData.value[view.submitArgName ? view.submitArgName : view.id] = viewData;
        } catch (e) {
            this.client.log.error(
                { error: e.message },
                'Exception caught gathering form data'
            );
        }
    });

    return formData;
};
