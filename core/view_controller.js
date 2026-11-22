'use strict';

//  ENiGMA½
const { MCIViewFactory } = require('./mci_view_factory.js');
const { View, redrawPausedView } = require('./view');
const FormState = require('./form_state.js');
const menuUtil = require('./menu_util.js');
const asset = require('./asset.js');
const ansi = require('./ansi_term.js');
const { isKeyPressCaptured, ensureKeyDispatch } = require('./input_capture.js');
const { getArtOrigin } = require('./mci_map_origin.js');
const { isAnimationView } = require('./animation_view.js');

//  deps
const events = require('events');
const assert = require('assert');
const async = require('async');
const _ = require('lodash');
const paths = require('path');

//  How an `mci` config key is read: a code and a view ID, found anywhere in
//  the key (`MET3` is read as ET3, as it always has been)
const MCI_REGEXP = /([A-Z]{2})([0-9]{1,2})/;

//  What an `mci` config key should be: anything else still applies as read
//  by MCI_REGEXP, with a warning
const MCI_KEY_EXACT_REGEXP = /^[A-Z]{2}[0-9]{1,2}$/;

//
//  Views created from an `mci` config key with a `position` and no marker in
//  the art ("config-placed"). Their keys are left out of the implicit submit
//  choice (see applyViewConfig()).
//
const configPlacedViews = new WeakSet();

//  |position| from an `mci` config block as { row, col }, or null
function parseConfigPosition(position) {
    let row;
    let col;
    if (Array.isArray(position)) {
        [row, col] = position;
    } else if (_.isObject(position)) {
        ({ row, col } = position);
    }
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || col < 1) {
        return null;
    }
    return { row, col };
}

//
//  Passed down a load waterfall to stop it: the form was destroyed (its
//  menu left) while its views prepared. The final callback maps it back to
//  no error, as a caller still expects its callback.
const FormLoadStop = Symbol('formDestroyedWhileLoading');

//
//  Run the optional prepare(cb) of every view of |vc| that has one (an
//  AnimationView loading its frames), all at once, before the form is first
//  drawn. cb(stop): |stop| is FormLoadStop if the form was destroyed (or
//  the client went) meanwhile; nothing more of the load should happen.
//
//  Views without prepare() are as they were: with none on the form, cb is
//  called at once, synchronously, and the load goes on exactly as before.
//  A prepare() that throws costs only its own view (warned).
//
function prepareViews(vc, cb) {
    const views = Object.values(vc.views).filter(v => _.isFunction(v.prepare));
    if (0 === views.length) {
        return cb(null);
    }

    async.each(
        views,
        (view, next) => {
            let called = false;
            const done = () => {
                if (!called) {
                    called = true;
                    next(null);
                }
            };
            try {
                view.prepare(done);
            } catch (e) {
                vc.client.log.warn(
                    Object.assign(vc._formLogContext(view.mciCode + view.id), {
                        error: e.message,
                    }),
                    'View prepare failed'
                );
                done();
            }
        },
        () => {
            if (FormState.isFormDestroyed(vc) || vc.client.clientEnded) {
                return cb(FormLoadStop);
            }
            return cb(null);
        }
    );
}

//  Tear down every view of |vc|: it takes no more input, its listeners are
//  removed and it is destroyed (its timers stopped). A view that was the
//  input focus is released first: nothing should put the cursor back into
//  it. Views torn down before are torn down again, as always: a module may
//  have added listeners to them since (a page shown again after
//  setFocus(false) / setFocus(true)), and those go too.
//
function tearDownViews(vc) {
    for (const id in vc.views) {
        const view = vc.views[id];
        View.releaseInputFocus(view);
        view.removeAllListeners();
        if (typeof view.destroy === 'function') {
            view.destroy();
        }
        //  also for a destroy() that does not call super: no background
        //  redraw is owed to a view that is gone
        View.markDestroyed(view);
    }
}

//  Give back |vc|'s cover() suspend, if it holds one, redrawing nothing
function releaseCover(vc) {
    const token = FormState.getFormCoverToken(vc);
    if (token) {
        FormState.setFormCoverToken(vc, null);
        View.resumeBackgroundDraw(vc.client, token, { redrawMissed: false });
    }
}

//  For a call on a form that destroy() has ended: say so, do nothing
function refuseDestroyed(vc, what) {
    if (!FormState.isFormDestroyed(vc)) {
        return false;
    }
    const log = vc.client && vc.client.log;
    if (log && _.isFunction(log.debug)) {
        log.debug(
            { formId: vc.formId, call: what },
            'Form was destroyed (its menu was left); ignoring'
        );
    }
    return true;
}

//
//  The form state machine (see "Form states" below). Core calls these
//  module-private functions, never the public methods, so a mod's
//  ViewController subclass that defines its own activate(), deactivate(),
//  cover(), uncover() or destroy() does not change what core does (as
//  setFocus(true), or a menu being left). The calls core made before these
//  states existed (attachClientEvents(), setViewFocusWithEvents(),
//  detachClientEvents()) still go through the methods, as they always did.
//

function activateForm(vc) {
    if (refuseDestroyed(vc, 'activate')) {
        return;
    }

    if (FormState.getFormCoverToken(vc)) {
        uncoverForm(vc);
    }

    //  active again here, not only in attachClientEvents(): a subclass may
    //  replace that method without calling it
    FormState.setFormInactive(vc, false);
    vc.attachClientEvents();
    vc.setViewFocusWithEvents(vc.focusedView, true);

    for (const id in vc.views) {
        redrawPausedView(vc.views[id]);
    }
}

function deactivateForm(vc) {
    if (refuseDestroyed(vc, 'deactivate')) {
        return;
    }

    FormState.setFormInactive(vc, true);
    if (vc.attached) {
        vc.client.removeListener('key press', vc.clientKeyPressHandler);
        vc.attached = false;
    }

    const focused = vc.focusedView;
    if (focused) {
        View.releaseInputFocus(focused);
        if (focused.hasFocus) {
            vc.setViewFocusWithEvents(focused, false);
        }
    }
}

function coverForm(vc) {
    if (refuseDestroyed(vc, 'cover')) {
        return;
    }

    deactivateForm(vc);
    //  a token dropped at a menu change is not held any more: take a new one
    if (!FormState.getFormCoverToken(vc)) {
        FormState.setFormCoverToken(
            vc,
            View.suspendBackgroundDraw(vc.client, { forms: [vc] })
        );
    }
}

function uncoverForm(vc, options) {
    const redraw = !!(options && options.redraw);
    const token = FormState.getFormCoverToken(vc);
    if (!token) {
        return;
    }
    FormState.setFormCoverToken(vc, null);

    if (!redraw || FormState.isFormDestroyed(vc)) {
        return View.resumeBackgroundDraw(vc.client, token);
    }

    View.resumeBackgroundDraw(vc.client, token, { redrawMissed: false });

    //  through drawInBackground(): a view still under another cover is
    //  noted and drawn when that cover goes, and the cursor goes back
    //  to the field being typed into
    const term = vc.client.term;
    const batch = _.isFunction(term.beginWrite) && _.isFunction(term.commitWrite);
    if (batch) {
        term.beginWrite();
    }
    try {
        for (const id in vc.views) {
            const view = vc.views[id];
            if (View.isDestroyed(view)) {
                continue;
            }
            view.forceNextRedraw();
            view.drawInBackground(() => view.redraw());
        }
    } finally {
        if (batch) {
            term.commitWrite();
        }
    }
}

function destroyForm(vc) {
    if (FormState.isFormDestroyed(vc)) {
        return;
    }
    FormState.markFormDestroyed(vc);
    releaseCover(vc);

    if (vc.attached) {
        vc.client.removeListener('key press', vc.clientKeyPressHandler);
    }
    tearDownViews(vc);
    FormState.setFormInactive(vc, false);
    vc.attached = false;
}

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
            //  Something covering the screen owns the input (an interrupt or
            //  a help page, or a mod's captureInput()): the form under it
            //  gets nothing.
            if (isKeyPressCaptured(this.client)) {
                return;
            }

            //  Deactivated, covered or destroyed: no keys. This matters for
            //  a key still being delivered when that happened (another
            //  listener's action for it covered this form): Node hands a key
            //  to the listeners as they were when it was sent. Forms torn
            //  down with setFocus(false) are not marked inactive, and behave
            //  as before.
            if (FormState.isFormInactive(this) || FormState.isFormDestroyed(this)) {
                return;
            }

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
                } else if (
                    _.isString(actionForKey.action) ||
                    Array.isArray(actionForKey.action) //  conditional (e.g. ACS) action list
                ) {
                    const formData = this.getFocusedView() ? this.getFormData() : {};
                    this.handleActionWrapper(
                        Object.assign({ ch: ch, key: key }, formData), //  formData + key info
                        actionForKey
                    ); //  actionBlock
                }
            } else {
                if (this.focusedView && this.focusedView.acceptsInput) {
                    this.client.term.beginWrite();
                    this.focusedView.onKeyPress(ch, key);
                    this.client.term.commitWrite();
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
        const safeFormData = structuredClone(formData);
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

    //
    //  Create the view for |mci| (an mciMap entry) and add it, unless its ID
    //  is taken. |name| is its MCI code and ID ("TL1"), for the log. Returns
    //  the view added, or undefined.
    //
    _addViewFromMCI(mci, name, logExtra) {
        const view = this.mciViewFactory.createFromMCI(mci);
        if (!view) {
            return;
        }

        if (this.viewExists(view.id)) {
            this.client.log.warn(
                Object.assign({ viewId: view.id, mciCode: name }, logExtra),
                'Duplicate MCI view ID — skipping. Check art for conflicting codes.'
            );
            return;
        }

        if (false === this.noInput) {
            view.on('action', this.viewActionListener);
        }

        this.addView(view);
        return view;
    }

    createViewsFromMCI(mciMap, cb) {
        const views = [];

        async.each(
            Object.keys(mciMap),
            (name, nextItem) => {
                const view = this._addViewFromMCI(mciMap[name], name);
                if (view) {
                    views.push(view);
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

            if (propValue !== undefined) {
                view.setPropertyValue(propName, propValue);
            }
        }
    }

    //
    //  Which form this is, for warnings about its config: the menu, the
    //  form (or prompt) and |mci|, the config key.
    //
    _formLogContext(mci) {
        const context = {
            menuName: _.get(this.client, 'currentMenuModule.menuName'),
            formId: undefined === this._configFormId ? this.formId : this._configFormId,
        };
        if (this._configPromptName) {
            context.promptName = this._configPromptName;
        }
        context.mci = mci;
        return context;
    }

    //
    //  Placement from config (run once per form load, before
    //  applyViewConfig()): every `mci` key in |config| with a `position`.
    //
    //  *   No view with its ID yet: a view is created as if the art held the
    //      code there ("config-placed").
    //  *   A view with its ID and code (an art marker): the explicit
    //      position wins; the view is moved.
    //  *   A view with its ID but another code: the ID is taken; skipped
    //      with the "Duplicate MCI view ID" warning. Its other properties
    //      still apply to that view, as they always have.
    //
    //  |position| is { row, col } from the art's top-left corner (row 1,
    //  column 1), wherever |mciMap|'s art was drawn, plus |viewOffsets| as
    //  marker views get. A position off screen is skipped with a warning.
    //
    //  Returns the IDs of keys asking for config placement whose ID had no
    //  view from the art (created or not): applyViewConfig() leaves them
    //  out of the implicit submit choice.
    //
    _placeViewsFromConfig(config, mciMap, viewOffsets) {
        const configOnlyIds = new Set();
        const mciConfig = _.isObject(config) && _.isObject(config.mci) ? config.mci : {};
        const origin = getArtOrigin(mciMap);
        const offsetRow = _.get(viewOffsets, 'row', 0) || 0;
        const offsetCol = _.get(viewOffsets, 'col', 0) || 0;
        const term = this.client.term;
        let added = false;

        Object.keys(mciConfig).forEach(mci => {
            const mciConf = mciConfig[mci];
            if (!_.isObject(mciConf) || !_.has(mciConf, 'position')) {
                return;
            }

            const mciMatch = mci.match(MCI_REGEXP);
            if (null === mciMatch) {
                return; //  applyViewConfig() warns
            }

            const code = mciMatch[1];
            const viewId = parseInt(mciMatch[2]);
            if (!(viewId >= 1)) {
                return this.client.log.warn(
                    this._formLogContext(mci),
                    'MCI "position" needs a view ID from 1 to 99; view not created'
                );
            }
            const existing = this.getView(viewId);

            const pos = parseConfigPosition(mciConf.position);
            if (!pos) {
                return this.client.log.warn(
                    Object.assign(this._formLogContext(mci), {
                        position: mciConf.position,
                    }),
                    'MCI "position" needs a whole row and col from 1 (e.g. { row: 5, col: 10 }); ignoring it'
                );
            }

            const screenPos = {
                row: origin.row + pos.row - 1 + offsetRow,
                col: origin.col + pos.col - 1 + offsetCol,
            };
            const offScreen =
                screenPos.row < 1 ||
                screenPos.col < 1 ||
                (term.termHeight > 0 && screenPos.row > term.termHeight) ||
                (term.termWidth > 0 && screenPos.col > term.termWidth);

            if (existing) {
                if (existing.mciCode && existing.mciCode !== code) {
                    //  a view of its own was asked for: its ID is taken. The
                    //  key's other properties still apply to the art's view,
                    //  as any key does (applyViewConfig() warns about that)
                    this.client.log.warn(
                        Object.assign(
                            { viewId, mciCode: mci },
                            this._formLogContext(mci),
                            { existingMciCode: existing.mciCode }
                        ),
                        'MCI "position" ignored: the art already has this view ID for another code'
                    );
                    return;
                }

                if (offScreen) {
                    return this.client.log.warn(
                        Object.assign(this._formLogContext(mci), {
                            position: pos,
                            screenPosition: screenPos,
                        }),
                        'MCI "position" is off screen; the view stays where its art marker is'
                    );
                }

                //  an explicit position wins over the art marker
                existing.setPosition(screenPos);
                existing.offsetsApplied = true;
                return;
            }

            if (offScreen) {
                return this.client.log.warn(
                    Object.assign(this._formLogContext(mci), {
                        position: pos,
                        screenPosition: screenPos,
                    }),
                    'MCI "position" is off screen; view not created'
                );
            }

            //  as if the art held the code at |screenPos|
            const view = this._addViewFromMCI(
                {
                    code,
                    id: viewId,
                    position: [screenPos.row, screenPos.col],
                    args: [],
                },
                `${code}${viewId}`,
                this._formLogContext(mci)
            );

            if (!view) {
                return this.client.log.warn(
                    this._formLogContext(mci),
                    `MCI code "${code}" makes no view; view not created`
                );
            }

            view.offsetsApplied = true;
            configPlacedViews.add(view);
            //  only a view actually placed is left out of the implicit
            //  submit choice; a key that placed nothing counts, as before
            configOnlyIds.add(viewId);
            added = true;
        });

        if (added) {
            this.setViewOrder();
        }

        return configOnlyIds;
    }

    //
    //  |configOnlyIds|: from _placeViewsFromConfig(), view IDs placed by
    //  config with no art marker. They are left out of the implicit submit
    //  choice below; anything else is as it always was.
    //
    applyViewConfig(config, cb, configOnlyIds) {
        let highestId = 1;
        let submitId;
        let initialFocusId = 1;

        async.each(
            Object.keys(config.mci || {}),
            (mci, nextItem) => {
                const mciMatch = mci.match(MCI_REGEXP); //  :TODO: How to handle auto-generated IDs????
                if (null === mciMatch) {
                    //  skip it: the rest of the form still loads
                    this.client.log.warn(
                        Object.assign({ mci: mci }, this._formLogContext(mci)),
                        'Unable to parse MCI code'
                    );
                    return nextItem(null);
                }

                if (!MCI_KEY_EXACT_REGEXP.test(mci)) {
                    //  applied as read, as it always has been
                    this.client.log.warn(
                        Object.assign(this._formLogContext(mci), {
                            readAs: mciMatch[0],
                        }),
                        `MCI key "${mci}" is not a code and view ID alone; read as "${mciMatch[0]}"`
                    );
                }

                const viewId = parseInt(mciMatch[2]);
                assert(!isNaN(viewId), 'Cannot parse view ID: ' + mciMatch[2]); //  shouldn't be possible with RegExp used

                const view = this.getView(viewId);
                //  Left out of the implicit submit choice: config-placed
                //  keys, and animations (never focused, so Enter could
                //  never submit from them), including an AV key whose
                //  view was not made
                const configOnly =
                    (configOnlyIds && configOnlyIds.has(viewId)) ||
                    (view && configPlacedViews.has(view)) ||
                    (view ? isAnimationView(view) : 'AV' === mciMatch[1]);

                if (viewId > highestId && !configOnly) {
                    highestId = viewId;
                }

                if (!view) {
                    return nextItem(null);
                }

                if (view.mciCode && view.mciCode !== mciMatch[1]) {
                    //  applied anyway, as it always has been (views are
                    //  matched by ID)
                    this.client.log.warn(
                        Object.assign(this._formLogContext(mci), {
                            viewMciCode: view.mciCode,
                        }),
                        `MCI key "${mci}" configures view ${viewId}, which is a %${view.mciCode}; applying it anyway`
                    );
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
        if (actionValue === undefined) {
            return false;
        }

        if (_.isNumber(actionValue) || _.isString(actionValue)) {
            if (formValue[actionValue] === undefined) {
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
        //  a destroyed form (its menu was left) never takes keys again
        if (refuseDestroyed(this, 'attachClientEvents')) {
            return;
        }

        //  taking keys again: no longer covered or inactive (as activate();
        //  a no-op for a form never deactivated or covered)
        if (FormState.getFormCoverToken(this)) {
            uncoverForm(this);
        }
        FormState.setFormInactive(this, false);

        if (this.attached) {
            return;
        }

        //  the capture dispatcher must run first; put it back if a mod
        //  removed every 'key press' listener (see input_capture.js)
        ensureKeyDispatch(this.client);
        this.client.on('key press', this.clientKeyPressHandler);

        Object.keys(this.views).forEach(i => {
            //  remove, then add to ensure we only have one listener
            this.views[i].removeListener('action', this.viewActionListener);
            this.views[i].on('action', this.viewActionListener);
        });

        this.attached = true;
    }

    //
    //  Detach from the client's keys and tear the form's views down
    //  (listeners removed, views destroyed, their timers stopped). Kept as
    //  it always was for mods; deprecated in favour of destroy(), or
    //  deactivate() / cover() for a form that will be used again. A form
    //  that is not attached is left alone, as before -- unless deactivate()
    //  detached it, as its views are still live then.
    //
    detachClientEvents() {
        if (!this.attached && !FormState.isFormInactive(this)) {
            return;
        }

        this.client.removeListener('key press', this.clientKeyPressHandler);
        tearDownViews(this);
        releaseCover(this);
        FormState.setFormInactive(this, false);
        this.attached = false;
    }

    //  ── Form states ──────────────────────────────────────────────────────────
    //
    //  active      takes keys; views live; background drawing runs
    //  inactive    deactivate(): no keys; views and their listeners kept;
    //              background drawing runs (except pauseWhenInactive views)
    //  covered     cover(): inactive, and its views do not draw in the
    //              background; uncover() gives them back
    //  destroyed   destroy(): terminal. Its menu was left (MenuModule
    //              leave()). activate(), setFocus(true), attachClientEvents()
    //              and switchFocus() do nothing on it any more.
    //
    //  "Inactive" means deactivate() or cover() was called: a form built and
    //  never attached is not inactive. attachClientEvents() (also through
    //  switchFocus()) on an inactive or covered form makes it active again:
    //  it uncovers it and gives it the keys. Unlike activate() it does not
    //  refocus the focused view or redraw paused views (switchFocus()
    //  focuses its target).
    //
    //  setFocus(false) is unchanged: it detaches and tears down
    //  (detachClientEvents()). setFocus(true) is activate().
    //

    //
    //  Take keys again: uncover if covered, attach, focus the focused view,
    //  and redraw once any pauseWhenInactive view that skipped a tick.
    //
    activate() {
        return activateForm(this);
    }

    //
    //  Stop taking keys, but keep everything: the key handler is removed,
    //  input focus released and the focused view blurred (it stays the
    //  form's focused view, for activate()). Views, their listeners and
    //  timers are untouched, so a ticker keeps running while the form is
    //  visible but another form has the keys.
    //
    deactivate() {
        return deactivateForm(this);
    }

    //
    //  Something is drawn over this form (a prompt, another form): it is
    //  deactivated, and its views stop drawing in the background until
    //  uncover(). Other forms on the screen are not affected. The suspend
    //  is held until uncover(), activate(), attachClientEvents(),
    //  destroy() or a teardown (setFocus(false), detachClientEvents()), or
    //  the next menu change, which drops every suspend.
    //
    cover() {
        return coverForm(this);
    }

    //
    //  The form is visible again. Views that missed a background draw get
    //  one full redraw; with { redraw: true } every view of the form is
    //  redrawn instead (what covered it overlapped all of it). Still
    //  inactive: activate() gives it the keys.
    //
    uncover(options) {
        return uncoverForm(this, options);
    }

    //
    //  The form is finished with, for good: detached, its views torn down,
    //  any cover given back. Terminal: nothing can attach it again (see
    //  attachClientEvents()). Idempotent.
    //
    destroy() {
        return destroyForm(this);
    }

    viewExists(id) {
        return id in this.views;
    }

    addView(view) {
        assert(!this.viewExists(view.id), 'View with ID ' + view.id + ' already exists');

        this.views[view.id] = view;
        FormState.setViewForm(view, this);
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

    //
    //  setFocus(true) is activate(). setFocus(false) is as it always was:
    //  detach and tear down (detachClientEvents()), then blur the focused
    //  view. For a form that will be shown again use deactivate() or
    //  cover() instead.
    //
    setFocus(focused) {
        if (focused) {
            return activateForm(this);
        }

        this.detachClientEvents();
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
        //  a destroyed form (its menu was left) takes no focus or keys
        if (refuseDestroyed(this, 'switchFocus')) {
            return;
        }

        //
        //  Perform focus switching validation now
        //
        const focusedView = this.focusedView;

        this.validateView(focusedView, (err, newFocusedViewId) => {
            //  validation can be asynchronous
            if (refuseDestroyed(this, 'switchFocus')) {
                return;
            }
            this.client.term.beginWrite();
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
            this.client.term.commitWrite();
        });
    }

    nextFocus() {
        let nextFocusView = this.focusedView
            ? this.focusedView
            : this.views[this.firstId];

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
                viewIdOrder.length > 1
                    ? viewIdOrder[viewIdOrder.length - 1]
                    : this.firstId;
            this.views[lastId].nextId = this.firstId;
        }
    }

    redrawAll(initialFocusId) {
        //  one socket write for the whole form, as for a key press
        const term = this.client.term;
        const batch = _.isFunction(term.beginWrite) && _.isFunction(term.commitWrite);
        if (batch) {
            term.beginWrite();
        }

        try {
            term.rawWrite(ansi.hideCursor());

            for (const id in this.views) {
                if (initialFocusId === id) {
                    continue; //  will draw @ focus
                }
                this.views[id].redraw();
            }

            term.rawWrite(ansi.showCursor());
        } finally {
            if (batch) {
                term.commitWrite();
            }
        }
    }

    //
    //  Build the key -> action block map from an "actionKeys" array.
    //
    //  *   'keys' must be present and be an array of key names
    //  *   If 'viewId' is present, key(s) will focus & submit on behalf
    //      of the specified view.
    //  *   If 'action' is present, that action will be procesed when
    //      triggered by key(s)
    //
    //  An entry that is not an object with a 'keys' array binds nothing. That
    //  is worth saying out loud rather than skipping quietly: the usual way to
    //  arrive at one is an "@reference:" that does not resolve, which
    //  ConfigLoader leaves in place as a literal string, so what the operator
    //  sees is a key that has simply stopped working with nothing logged
    //  anywhere. "oputil.js config validate --check-env" finds those, but only
    //  if you already suspect the configuration.
    //
    mapActionKeys(actionKeys, what) {
        actionKeys.forEach((ak, i) => {
            if (!_.isObject(ak) || !Array.isArray(ak.keys)) {
                return this.client.log.warn(
                    {
                        menu: _.get(this.client, 'currentMenuModule.menuName'),
                        formId: this.formId,
                        index: i,
                        entry: ak,
                    },
                    `Ignoring ${what} actionKeys entry without a "keys" array; it binds nothing`
                );
            }

            ak.keys.forEach(kn => {
                this.actionKeyMap[kn] = ak;
            });
        });
    }

    loadFromPromptConfig(options, cb) {
        assert(_.isObject(options));
        assert(_.isObject(options.mciMap));

        let initialFocusId = 1; //  default to first
        const promptConfig = _.isObject(options.config)
            ? options.config
            : this.client.currentMenuModule.menuConfig.promptConfig;

        //  for warnings about its config
        const promptName = _.isObject(options.config)
            ? options.promptName
            : _.get(this.client, 'currentMenuModule.menuConfig.prompt');
        if (_.isString(promptName)) {
            this._configPromptName = promptName;
        }

        let configOnlyIds;

        async.waterfall(
            [
                callback => {
                    this.createViewsFromMCI(options.mciMap, err => {
                        callback(err);
                    });
                },
                callback => {
                    //  views placed by config `position`; the prompt's art
                    //  markers are already where the prompt was drawn
                    configOnlyIds = this._placeViewsFromConfig(
                        promptConfig,
                        options.mciMap
                    );
                    return callback(null);
                },
                callback => {
                    if (promptConfig && _.isObject(promptConfig.mci)) {
                        this.applyViewConfig(
                            promptConfig,
                            (err, info) => {
                                initialFocusId = info.initialFocusId;
                                callback(err);
                            },
                            configOnlyIds
                        );
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

                            //
                            //  A menu's own prompt has no submitNotify to dispose of it, so
                            //  input matching no action would otherwise stay in the field
                            //  (re-submitting it, or prefixing the next command). Empty the
                            //  field and put the cursor back at its start. Other callers
                            //  (promptForInput, forms) own that decision via submitNotify.
                            //
                            const doNoMatch = () => {
                                if (options.submitNotify) {
                                    return doSubmitNotify();
                                }

                                if (options.callingMenu) {
                                    const view = this.getView(formData.submitId);
                                    if (view && _.isFunction(view.clearText)) {
                                        view.clearText();
                                        if (view.hasFocus) {
                                            view.setFocus(true);
                                        }
                                    }
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
                                    doNoMatch();
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
                                    doNoMatch();
                                }
                            }
                        });
                    }

                    callback(null);
                },
                callback => {
                    if (
                        !_.isObject(promptConfig) ||
                        !Array.isArray(promptConfig.actionKeys)
                    ) {
                        return callback(null);
                    }

                    this.mapActionKeys(promptConfig.actionKeys, 'prompt');

                    return callback(null);
                },
                callback => {
                    //  views that load something before they are drawn
                    return prepareViews(this, callback);
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
                cb(FormLoadStop === err ? null : err);
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
        let configOnlyIds;
        this._configFormId = formIdKey; //  for warnings about its config

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
                callback => {
                    //  Views placed by config `position`: after the form
                    //  config was matched above, so the art's MCI codes that
                    //  explicit form keys (`VMTL: { ... }`) match are as
                    //  they were
                    if (_.isObject(formConfig)) {
                        configOnlyIds = this._placeViewsFromConfig(
                            formConfig,
                            options.mciMap,
                            _.isObject(options.viewOffsets) ? options.viewOffsets : null
                        );
                    }
                    return callback(null);
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
                        this.applyViewConfig(
                            formConfig,
                            (err, info) => {
                                this.formInitialFocusId = info.initialFocusId;
                                callback(err);
                            },
                            configOnlyIds
                        );
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
                    if (
                        !_.isObject(formConfig) ||
                        !Array.isArray(formConfig.actionKeys)
                    ) {
                        callback(null);
                        return;
                    }

                    this.mapActionKeys(formConfig.actionKeys, 'form');

                    callback(null);
                },
                callback => {
                    //  views that load something before they are drawn
                    return prepareViews(this, callback);
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
                    cb(FormLoadStop === err ? null : err);
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
                if (viewData === undefined) {
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

//  For core (MenuModule, theme): the form states without going through
//  methods a subclass may have replaced. Not for mods: use the methods.
exports.FormLifecycle = Object.freeze({
    activate: activateForm,
    deactivate: deactivateForm,
    cover: coverForm,
    uncover: uncoverForm,
    destroy: destroyForm,
    //  cover() a ViewController; anything else a module keeps in
    //  viewControllers gets setFocus(false), as before form states
    coverAny: vc => {
        if (vc instanceof ViewController) {
            return coverForm(vc);
        }
        if (vc) {
            vc.setFocus(false);
        }
    },
});
exports.MCI_REGEXP = MCI_REGEXP;
exports.MCI_KEY_EXACT_REGEXP = MCI_KEY_EXACT_REGEXP;
