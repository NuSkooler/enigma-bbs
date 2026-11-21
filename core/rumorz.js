/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule, MenuLeftStop } = require('./menu_module.js');
const { ViewController, FormLifecycle } = require('./view_controller.js');
const theme = require('./theme.js');
const resetScreen = require('./ansi_term.js').resetScreen;
const StatLog = require('./stat_log.js');
const renderStringLength = require('./string_util.js').renderStringLength;
const SystemLogKeys = require('./system_log.js');

//  deps
const async = require('async');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'Rumorz',
    desc: 'Standard local rumorz',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.rumorz',
};

const FormIds = {
    View: 0,
    Add: 1,
};

const MciCodeIds = {
    ViewForm: {
        Entries: 1,
        AddPrompt: 2,
    },
    AddForm: {
        NewEntry: 1,
        EntryPreview: 2,
        AddPrompt: 3,
    },
};

//  Ends a screen's steps early: the menu was left (see hasLeftMenu())

//  module -> its add form's preview updates (see bindPreviewUpdates()).
//  Kept here, not on the module, so no name is taken from a subclass.
const previewUpdates = new WeakMap();

//
//  The view and add screens take turns: the one not shown is covered (no
//  keys, no background drawing), not torn down, as it is shown again. It
//  is covered before the other screen's art is drawn, as blurring its
//  focused view draws that view. A preview update still pending for the
//  add form is dropped with it.
//
function coverForm(menu, name) {
    if ('add' === name) {
        const preview = previewUpdates.get(menu);
        if (preview && preview.timer) {
            menu.clearMenuTimeout(preview.timer);
            preview.timer = null;
        }
    }

    FormLifecycle.coverAny(menu.viewControllers[name]);
}

//
//  The preview shows the new entry 500 ms after the last key. Removed, then
//  added: the add form keeps its views' listeners while covered, so adding
//  again on each show would update the preview once more per visit. The
//  timer is the menu's (setMenuTimeout()), so leaving the menu drops it.
//
function bindPreviewUpdates(menu, entryView, previewView) {
    let preview = previewUpdates.get(menu);
    if (!preview) {
        preview = { timer: null };
        preview.onKeyPress = () => {
            if (preview.timer) {
                menu.clearMenuTimeout(preview.timer);
            }
            preview.timer = menu.setMenuTimeout(() => {
                preview.timer = null;
                const focused = menu.viewControllers.add.getFocusedView();
                if (focused === preview.entryView) {
                    preview.previewView.setText(preview.entryView.getData());
                    focused.setFocus(true);
                }
            }, 500);
        };
        previewUpdates.set(menu, preview);
    }

    if (preview.entryView && preview.entryView !== entryView) {
        preview.entryView.removeListener('key press', preview.onKeyPress);
    }
    preview.entryView = entryView;
    preview.previewView = previewView;
    entryView.removeListener('key press', preview.onKeyPress);
    entryView.on('key press', preview.onKeyPress);
}

exports.getModule = class RumorzModule extends MenuModule {
    constructor(options) {
        super(options);

        this.menuMethods = {
            viewAddScreen: (formData, extraArgs, cb) => {
                return this.displayAddScreen(cb);
            },

            addEntry: (formData, extraArgs, cb) => {
                if (
                    _.isString(formData.value.rumor) &&
                    renderStringLength(formData.value.rumor) > 0
                ) {
                    const rumor = formData.value.rumor.trim(); //  remove any trailing ws

                    StatLog.appendSystemLogEntry(
                        SystemLogKeys.UserAddedRumorz,
                        rumor,
                        StatLog.KeepDays.Forever,
                        StatLog.KeepType.Forever,
                        () => {
                            this.clearAddForm();
                            return this.displayViewScreen(true, cb); //  true=cls
                        }
                    );
                } else {
                    //  empty message - treat as if cancel was hit
                    return this.displayViewScreen(true, cb); //  true=cls
                }
            },

            cancelAdd: (formData, extraArgs, cb) => {
                this.clearAddForm();
                return this.displayViewScreen(true, cb); //  true=cls
            },
        };
    }

    get config() {
        return this.menuConfig.config;
    }

    clearAddForm() {
        const newEntryView = this.viewControllers.add.getView(
            MciCodeIds.AddForm.NewEntry
        );
        const previewView = this.viewControllers.add.getView(
            MciCodeIds.AddForm.EntryPreview
        );

        newEntryView.setText('');

        //  preview is optional
        if (previewView) {
            previewView.setText('');
        }
    }

    initSequence() {
        const self = this;

        async.series(
            [
                function beforeDisplayArt(callback) {
                    self.beforeArt(callback);
                },
                function display(callback) {
                    self.displayViewScreen(false, callback);
                },
            ],
            err => {
                if (err) {
                    //  :TODO: Handle me -- initSequence() should really take a completion callback
                }
                self.finishedLoading();
            }
        );
    }

    displayViewScreen(clearScreen, cb) {
        const self = this;
        async.waterfall(
            [
                function clearAndDisplayArt(callback) {
                    coverForm(self, 'add');

                    if (clearScreen) {
                        self.client.term.rawWrite(resetScreen());
                    }

                    theme.displayThemedAsset(
                        self.config.art.entries,
                        self.client,
                        { font: self.menuConfig.font, trailingLF: false },
                        (err, artData) => {
                            return callback(err, artData);
                        }
                    );
                },
                function initOrRedrawViewController(artData, callback) {
                    //  the screen is another menu's now
                    if (self.hasLeftMenu()) {
                        return callback(MenuLeftStop);
                    }
                    if (self.viewControllers.add === undefined) {
                        const vc = self.addViewController(
                            'view',
                            new ViewController({
                                client: self.client,
                                formId: FormIds.View,
                            })
                        );

                        const loadOpts = {
                            callingMenu: self,
                            mciMap: artData.mciMap,
                            formId: FormIds.View,
                        };

                        return vc.loadFromMenuConfig(loadOpts, err => {
                            if (err) {
                                return callback(err);
                            }
                            return self.validateMCIByViewIds(
                                'view',
                                [
                                    MciCodeIds.ViewForm.Entries,
                                    MciCodeIds.ViewForm.AddPrompt,
                                ],
                                callback
                            );
                        });
                    } else {
                        self.viewControllers.view.setFocus(true);
                        self.viewControllers.view
                            .getView(MciCodeIds.ViewForm.AddPrompt)
                            .redraw();
                        return callback(null);
                    }
                },
                function fetchEntries(callback) {
                    const entriesView = self.viewControllers.view.getView(
                        MciCodeIds.ViewForm.Entries
                    );

                    StatLog.getSystemLogEntries(
                        SystemLogKeys.UserAddedRumorz,
                        StatLog.Order.TimestampDesc,
                        (err, entries) => {
                            return callback(err, entriesView, entries);
                        }
                    );
                },
                function populateEntries(entriesView, entries, callback) {
                    if (self.hasLeftMenu()) {
                        return callback(MenuLeftStop);
                    }
                    entriesView.setItems(
                        entries.map(e => {
                            return {
                                text: e.log_value, //  standard
                                rumor: e.log_value,
                            };
                        })
                    );

                    entriesView.redraw();

                    return callback(null);
                },
                function finalPrep(callback) {
                    const promptView = self.viewControllers.view.getView(
                        MciCodeIds.ViewForm.AddPrompt
                    );
                    promptView.setFocusItemIndex(1); //  default to NO
                    return callback(null);
                },
            ],
            err => {
                if (cb) {
                    return cb(MenuLeftStop === err ? null : err);
                }
            }
        );
    }

    displayAddScreen(cb) {
        const self = this;

        async.waterfall(
            [
                function clearAndDisplayArt(callback) {
                    coverForm(self, 'view');
                    self.client.term.rawWrite(resetScreen());

                    theme.displayThemedAsset(
                        self.config.art.add,
                        self.client,
                        { font: self.menuConfig.font },
                        (err, artData) => {
                            return callback(err, artData);
                        }
                    );
                },
                function initOrRedrawViewController(artData, callback) {
                    //  the screen is another menu's now
                    if (self.hasLeftMenu()) {
                        return callback(MenuLeftStop);
                    }
                    if (self.viewControllers.add === undefined) {
                        const vc = self.addViewController(
                            'add',
                            new ViewController({
                                client: self.client,
                                formId: FormIds.Add,
                            })
                        );

                        const loadOpts = {
                            callingMenu: self,
                            mciMap: artData.mciMap,
                            formId: FormIds.Add,
                        };

                        return vc.loadFromMenuConfig(loadOpts, err => {
                            if (err) {
                                return callback(err);
                            }
                            return self.validateMCIByViewIds(
                                'add',
                                [
                                    MciCodeIds.AddForm.NewEntry,
                                    MciCodeIds.AddForm.AddPrompt,
                                ],
                                callback
                            );
                        });
                    } else {
                        self.viewControllers.add.setFocus(true);
                        self.viewControllers.add.redrawAll();
                        self.viewControllers.add.switchFocus(MciCodeIds.AddForm.NewEntry);
                        return callback(null);
                    }
                },
                function initPreviewUpdates(callback) {
                    const previewView = self.viewControllers.add.getView(
                        MciCodeIds.AddForm.EntryPreview
                    );
                    const entryView = self.viewControllers.add.getView(
                        MciCodeIds.AddForm.NewEntry
                    );
                    if (previewView) {
                        bindPreviewUpdates(self, entryView, previewView);
                    }
                    return callback(null);
                },
            ],
            err => {
                if (cb) {
                    return cb(MenuLeftStop === err ? null : err);
                }
            }
        );
    }
};
