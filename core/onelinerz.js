/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const { ViewController, FormLifecycle } = require('./view_controller.js');

const { getModDatabasePath, openDatabase } = require('./database.js');

//  deps
const async = require('async');
const _ = require('lodash');
const moment = require('moment');

/*
    Module :TODO:
    * Add ability to at least alternate formatStrings -- every other
*/

exports.moduleInfo = {
    name: 'Onelinerz',
    desc: 'Standard local onelinerz',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.onelinerz',
};

const MciViewIds = {
    view: {
        entries: 1,
        addPrompt: 2,
    },
    add: {
        newEntry: 1,
        entryPreview: 2,
        addPrompt: 3,
    },
};

const FormIds = {
    view: 0,
    add: 1,
};

//  Ends a screen's steps early: the menu was left (see hasLeftMenu())
const MenuLeft = Symbol('menuLeft');

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

    const vc = menu.viewControllers[name];
    if (vc instanceof ViewController) {
        FormLifecycle.cover(vc);
    } else if (vc) {
        vc.setFocus(false);
    }
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

exports.getModule = class OnelinerzModule extends MenuModule {
    constructor(options) {
        super(options);

        const self = this;

        this.menuMethods = {
            viewAddScreen: function (formData, extraArgs, cb) {
                return self.displayAddScreen(cb);
            },

            addEntry: function (formData, extraArgs, cb) {
                if (
                    _.isString(formData.value.oneliner) &&
                    formData.value.oneliner.length > 0
                ) {
                    const oneliner = formData.value.oneliner.trim(); //  remove any trailing ws

                    self.storeNewOneliner(oneliner, err => {
                        if (err) {
                            self.client.log.warn(
                                { error: err.message },
                                'Failed saving oneliner'
                            );
                        }

                        self.clearAddForm();
                        return self.displayViewScreen(true, cb); //  true=cls
                    });
                } else {
                    //  empty message - treat as if cancel was hit
                    return self.displayViewScreen(true, cb); //  true=cls
                }
            },

            cancelAdd: function (formData, extraArgs, cb) {
                self.clearAddForm();
                return self.displayViewScreen(true, cb); //  true=cls
            },
        };
    }

    initSequence() {
        const self = this;
        async.series(
            [
                function beforeDisplayArt(callback) {
                    return self.beforeArt(callback);
                },
                function display(callback) {
                    return self.displayViewScreen(false, callback);
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
                function prepArtAndViewController(callback) {
                    coverForm(self, 'add');

                    return self.prepViewControllerWithArt(
                        'view',
                        FormIds.view,
                        {
                            clearScreen,
                            trailingLF: false,
                        },
                        (err, artInfo, wasCreated) => {
                            if (err) {
                                return callback(err);
                            }
                            //  the screen is another menu's now
                            if (self.hasLeftMenu()) {
                                return callback(MenuLeft);
                            }
                            if (!wasCreated) {
                                self.viewControllers.view.setFocus(true);
                                self.viewControllers.view
                                    .getView(MciViewIds.view.addPrompt)
                                    .redraw();
                                return callback(null);
                            }
                            return self.validateMCIByViewIds(
                                'view',
                                [MciViewIds.view.entries, MciViewIds.view.addPrompt],
                                callback
                            );
                        }
                    );
                },
                function fetchEntries(callback) {
                    const entriesView = self.viewControllers.view.getView(
                        MciViewIds.view.entries
                    );
                    const limit = entriesView.dimens.height;

                    try {
                        const rows = self.db
                            .prepare(
                                `SELECT *
                                FROM (
                                    SELECT *
                                    FROM onelinerz
                                    ORDER BY timestamp DESC
                                    LIMIT ${limit}
                                )
                                ORDER BY timestamp ASC;`
                            )
                            .all();

                        const entries = rows.map(row => {
                            row.timestamp = moment(row.timestamp); //  convert -> moment
                            return row;
                        });

                        return callback(null, entriesView, entries);
                    } catch (err) {
                        return callback(err);
                    }
                },
                function populateEntries(entriesView, entries, callback) {
                    const tsFormat =
                        self.menuConfig.config.dateTimeFormat ||
                        self.menuConfig.config.timestampFormat || //  deprecated
                        self.client.currentTheme.helpers.getDateFormat('short');

                    entriesView.setItems(
                        entries.map(e => {
                            return {
                                text: e.oneliner, //  standard
                                userId: e.user_id,
                                userName: e.user_name,
                                oneliner: e.oneliner,
                                ts: e.timestamp.format(tsFormat),
                            };
                        })
                    );

                    entriesView.redraw();
                    return callback(null);
                },
                function finalPrep(callback) {
                    const promptView = self.viewControllers.view.getView(
                        MciViewIds.view.addPrompt
                    );
                    promptView.setFocusItemIndex(1); //  default to NO
                    return callback(null);
                },
            ],
            err => {
                if (cb) {
                    return cb(MenuLeft === err ? null : err);
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

                    return self.prepViewControllerWithArt(
                        'add',
                        FormIds.add,
                        {
                            clearScreen: true,
                            trailingLF: false,
                        },
                        (err, artInfo, wasCreated) => {
                            if (err) {
                                return callback(err);
                            }
                            //  the screen is another menu's now
                            if (self.hasLeftMenu()) {
                                return callback(MenuLeft);
                            }
                            if (!wasCreated) {
                                self.viewControllers.add.setFocus(true);
                                self.viewControllers.add.redrawAll();
                                self.viewControllers.add.switchFocus(
                                    MciViewIds.add.newEntry
                                );
                                return callback(null);
                            }
                            return self.validateMCIByViewIds(
                                'add',
                                [MciViewIds.add.newEntry, MciViewIds.add.addPrompt],
                                callback
                            );
                        }
                    );
                },
                function initPreviewUpdates(callback) {
                    const previewView = self.viewControllers.add.getView(
                        MciViewIds.add.entryPreview
                    );
                    const entryView = self.viewControllers.add.getView(
                        MciViewIds.add.newEntry
                    );
                    if (previewView) {
                        bindPreviewUpdates(self, entryView, previewView);
                    }
                    return callback(null);
                },
            ],
            err => {
                if (cb) {
                    return cb(MenuLeft === err ? null : err);
                }
            }
        );
    }

    clearAddForm() {
        this.setViewText('add', MciViewIds.add.newEntry, '');
        this.setViewText('add', MciViewIds.add.entryPreview, '');
    }

    initDatabase(cb) {
        try {
            const dbSuffix = this.menuConfig.config.dbSuffix;
            this.db = openDatabase(getModDatabasePath(exports.moduleInfo, dbSuffix));
            this.db.exec(
                `CREATE TABLE IF NOT EXISTS onelinerz (
                    id              INTEGER PRIMARY KEY,
                    user_id         INTEGER_NOT NULL,
                    user_name       VARCHAR NOT NULL,
                    oneliner        VARCHAR NOT NULL,
                    timestamp       DATETIME NOT NULL
                );`
            );
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    storeNewOneliner(oneliner, cb) {
        const ts = moment().format('YYYY-MM-DDTHH:mm:ss.SSSZ');
        const retainCount = this.menuConfig.config.retainCount || 25;

        try {
            this.db
                .prepare(
                    `INSERT INTO onelinerz (user_id, user_name, oneliner, timestamp)
                    VALUES (?, ?, ?, ?);`
                )
                .run(this.client.user.userId, this.client.user.username, oneliner, ts);

            //  keep 25 max most recent items by default - remove the older ones
            this.db
                .prepare(
                    `DELETE FROM onelinerz
                    WHERE id IN (
                        SELECT id
                        FROM onelinerz
                        ORDER BY id DESC
                        LIMIT -1 OFFSET ${retainCount}
                    );`
                )
                .run();

            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    beforeArt(cb) {
        super.beforeArt(err => {
            return err ? cb(err) : this.initDatabase(cb);
        });
    }
};
