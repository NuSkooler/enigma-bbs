/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;

const { getModDatabasePath, getTransactionDatabase } = require('./database.js');

//  deps
const sqlite3 = require('sqlite3');
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
                    if (self.viewControllers.add) {
                        self.viewControllers.add.setFocus(false);
                    }

                    return self.prepViewControllerWithArt(
                        'view',
                        FormIds.view,
                        {
                            clearScreen,
                            trailingLF: false,
                        },
                        (err, artInfo, wasCreated) => {
                            if (!err && !wasCreated) {
                                self.viewControllers.view.setFocus(true);
                                self.viewControllers.view
                                    .getView(MciViewIds.view.addPrompt)
                                    .redraw();
                            }
                            return callback(err);
                        }
                    );
                },
                function fetchEntries(callback) {
                    const entriesView = self.viewControllers.view.getView(
                        MciViewIds.view.entries
                    );
                    const limit = entriesView.dimens.height;
                    let entries = [];

                    self.db.each(
                        `SELECT *
                        FROM (
                            SELECT *
                            FROM onelinerz
                            ORDER BY timestamp DESC
                            LIMIT ${limit}
                            )
                        ORDER BY timestamp ASC;`,
                        (err, row) => {
                            if (!err) {
                                row.timestamp = moment(row.timestamp); //  convert -> moment
                                entries.push(row);
                            }
                        },
                        err => {
                            return callback(err, entriesView, entries);
                        }
                    );
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
                    return cb(err);
                }
            }
        );
    }

    displayAddScreen(cb) {
        const self = this;

        async.waterfall(
            [
                function clearAndDisplayArt(callback) {
                    self.viewControllers.view.setFocus(false);

                    return self.prepViewControllerWithArt(
                        'add',
                        FormIds.add,
                        {
                            clearScreen: true,
                            trailingLF: false,
                        },
                        (err, artInfo, wasCreated) => {
                            if (!wasCreated) {
                                self.viewControllers.add.setFocus(true);
                                self.viewControllers.add.redrawAll();
                                self.viewControllers.add.switchFocus(
                                    MciViewIds.add.newEntry
                                );
                            }
                            return callback(err);
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
                        let timerId;
                        entryView.on('key press', () => {
                            clearTimeout(timerId);
                            timerId = setTimeout(() => {
                                const focused = self.viewControllers.add.getFocusedView();
                                if (focused === entryView) {
                                    previewView.setText(entryView.getData());
                                    focused.setFocus(true);
                                }
                            }, 500);
                        });
                    }
                    return callback(null);
                },
            ],
            err => {
                if (cb) {
                    return cb(err);
                }
            }
        );
    }

    clearAddForm() {
        this.setViewText('add', MciViewIds.add.newEntry, '');
        this.setViewText('add', MciViewIds.add.entryPreview, '');
    }

    initDatabase(cb) {
        const self = this;

        async.series(
            [
                function openDatabase(callback) {
                    const dbSuffix = self.menuConfig.config.dbSuffix;
                    self.db = getTransactionDatabase(
                        new sqlite3.Database(
                            getModDatabasePath(exports.moduleInfo, dbSuffix),
                            err => {
                                return callback(err);
                            }
                        )
                    );
                },
                function createTables(callback) {
                    self.db.run(
                        `CREATE TABLE IF NOT EXISTS onelinerz (
                            id              INTEGER PRIMARY KEY,
                            user_id         INTEGER_NOT NULL,
                            user_name       VARCHAR NOT NULL,
                            oneliner        VARCHAR NOT NULL,
                            timestamp       DATETIME NOT NULL
                        );`,
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

    storeNewOneliner(oneliner, cb) {
        const self = this;
        const ts = moment().format('YYYY-MM-DDTHH:mm:ss.SSSZ');

        async.series(
            [
                function addRec(callback) {
                    self.db.run(
                        `INSERT INTO onelinerz (user_id, user_name, oneliner, timestamp)
                        VALUES (?, ?, ?, ?);`,
                        [
                            self.client.user.userId,
                            self.client.user.username,
                            oneliner,
                            ts,
                        ],
                        callback
                    );
                },
                function removeOld(callback) {
                    //  keep 25 max most recent items by default - remove the older ones
                    const retainCount = self.menuConfig.config.retainCount || 25;
                    self.db.run(
                        `DELETE FROM onelinerz
                        WHERE id IN (
                            SELECT id
                            FROM onelinerz
                            ORDER BY id DESC
                            LIMIT -1 OFFSET ${retainCount}
                        );`,
                        callback
                    );
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    beforeArt(cb) {
        super.beforeArt(err => {
            return err ? cb(err) : this.initDatabase(cb);
        });
    }
};
