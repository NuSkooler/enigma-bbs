/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;

const { getModDatabasePath, getTransactionDatabase } = require('./database.js');

const ViewController = require('./view_controller.js').ViewController;
const ansi = require('./ansi_term.js');
const theme = require('./theme.js');
const User = require('./user.js');
const stringFormat = require('./string_format.js');

//  deps
const async = require('async');
const sqlite3 = require('sqlite3');
const _ = require('lodash');

//  :TODO: add notes field

const moduleInfo = (exports.moduleInfo = {
    name: 'BBS List',
    desc: 'List of other BBSes',
    author: 'Andrew Pamment',
    packageName: 'com.magickabbs.enigma.bbslist',
});

const MciViewIds = {
    view: {
        BBSList: 1,
        SelectedBBSName: 2,
        SelectedBBSSysOp: 3,
        SelectedBBSTelnet: 4,
        SelectedBBSWww: 5,
        SelectedBBSLoc: 6,
        SelectedBBSSoftware: 7,
        SelectedBBSNotes: 8,
        SelectedBBSSubmitter: 9,
    },
    add: {
        BBSName: 1,
        Sysop: 2,
        Telnet: 3,
        Www: 4,
        Location: 5,
        Software: 6,
        Notes: 7,
        Error: 8,
    },
};

const FormIds = {
    View: 0,
    Add: 1,
};

const SELECTED_MCI_NAME_TO_ENTRY = {
    SelectedBBSName: 'bbsName',
    SelectedBBSSysOp: 'sysOp',
    SelectedBBSTelnet: 'telnet',
    SelectedBBSWww: 'www',
    SelectedBBSLoc: 'location',
    SelectedBBSSoftware: 'software',
    SelectedBBSSubmitter: 'submitter',
    SelectedBBSSubmitterId: 'submitterUserId',
    SelectedBBSNotes: 'notes',
};

exports.getModule = class BBSListModule extends MenuModule {
    constructor(options) {
        super(options);

        const self = this;
        this.menuMethods = {
            //
            //  Validators
            //
            viewValidationListener: function (err, cb) {
                const errMsgView = self.viewControllers.add.getView(MciViewIds.add.Error);
                if (errMsgView) {
                    if (err) {
                        errMsgView.setText(err.message);
                    } else {
                        errMsgView.clearText();
                    }
                }

                return cb(null);
            },

            //
            //  Key & submit handlers
            //
            addBBS: function (formData, extraArgs, cb) {
                self.displayAddScreen(cb);
            },
            deleteBBS: function (formData, extraArgs, cb) {
                if (!_.isNumber(self.selectedBBS) || 0 === self.entries.length) {
                    return cb(null);
                }

                const entriesView = self.viewControllers.view.getView(
                    MciViewIds.view.BBSList
                );

                if (
                    self.entries[self.selectedBBS].submitterUserId !==
                        self.client.user.userId &&
                    !self.client.user.isSysOp()
                ) {
                    //  must be owner or +op
                    return cb(null);
                }

                const entry = self.entries[self.selectedBBS];
                if (!entry) {
                    return cb(null);
                }

                self.database.run(
                    `DELETE FROM bbs_list 
                    WHERE id=?;`,
                    [entry.id],
                    err => {
                        if (err) {
                            self.client.log.error(
                                { err: err },
                                'Error deleting from BBS list'
                            );
                        } else {
                            self.entries.splice(self.selectedBBS, 1);

                            self.setEntries(entriesView);

                            if (self.entries.length > 0) {
                                entriesView.focusPrevious();
                            }

                            self.viewControllers.view.redrawAll();
                        }

                        return cb(null);
                    }
                );
            },
            submitBBS: function (formData, extraArgs, cb) {
                let ok = true;
                ['BBSName', 'Sysop', 'Telnet'].forEach(mciName => {
                    if (
                        '' ===
                        self.viewControllers.add
                            .getView(MciViewIds.add[mciName])
                            .getData()
                    ) {
                        ok = false;
                    }
                });
                if (!ok) {
                    //  validators should prevent this!
                    return cb(null);
                }

                self.database.run(
                    `INSERT INTO bbs_list (bbs_name, sysop, telnet, www, location, software, submitter_user_id, notes) 
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?);`,
                    [
                        formData.value.name,
                        formData.value.sysop,
                        formData.value.telnet,
                        formData.value.www,
                        formData.value.location,
                        formData.value.software,
                        self.client.user.userId,
                        formData.value.notes,
                    ],
                    err => {
                        if (err) {
                            self.client.log.error(
                                { err: err },
                                'Error adding to BBS list'
                            );
                        }

                        self.clearAddForm();
                        self.displayBBSList(true, cb);
                    }
                );
            },
            cancelSubmit: function (formData, extraArgs, cb) {
                self.clearAddForm();
                self.displayBBSList(true, cb);
            },
        };
    }

    initSequence() {
        const self = this;
        async.series(
            [
                function beforeDisplayArt(callback) {
                    self.beforeArt(callback);
                },
                function display(callback) {
                    self.displayBBSList(false, callback);
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

    drawSelectedEntry(entry) {
        if (!entry) {
            Object.keys(SELECTED_MCI_NAME_TO_ENTRY).forEach(mciName => {
                this.setViewText('view', MciViewIds.view[mciName], '');
            });
        } else {
            const youSubmittedFormat =
                this.menuConfig.youSubmittedFormat || '{submitter} (You!)';

            Object.keys(SELECTED_MCI_NAME_TO_ENTRY).forEach(mciName => {
                const t = entry[SELECTED_MCI_NAME_TO_ENTRY[mciName]];
                if (MciViewIds.view[mciName]) {
                    if (
                        'SelectedBBSSubmitter' == mciName &&
                        entry.submitterUserId == this.client.user.userId
                    ) {
                        this.setViewText(
                            'view',
                            MciViewIds.view.SelectedBBSSubmitter,
                            stringFormat(youSubmittedFormat, entry)
                        );
                    } else {
                        this.setViewText('view', MciViewIds.view[mciName], t);
                    }
                }
            });
        }
    }

    setEntries(entriesView) {
        return entriesView.setItems(this.entries);
    }

    displayBBSList(clearScreen, cb) {
        const self = this;

        async.waterfall(
            [
                function clearAndDisplayArt(callback) {
                    if (self.viewControllers.add) {
                        self.viewControllers.add.setFocus(false);
                    }
                    if (clearScreen) {
                        self.client.term.rawWrite(ansi.resetScreen());
                    }
                    theme.displayThemedAsset(
                        self.menuConfig.config.art.entries,
                        self.client,
                        { font: self.menuConfig.font, trailingLF: false },
                        (err, artData) => {
                            return callback(err, artData);
                        }
                    );
                },
                function initOrRedrawViewController(artData, callback) {
                    if (_.isUndefined(self.viewControllers.add)) {
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

                        return vc.loadFromMenuConfig(loadOpts, callback);
                    } else {
                        self.viewControllers.view.setFocus(true);
                        self.viewControllers.view
                            .getView(MciViewIds.view.BBSList)
                            .redraw();
                        return callback(null);
                    }
                },
                function fetchEntries(callback) {
                    const entriesView = self.viewControllers.view.getView(
                        MciViewIds.view.BBSList
                    );
                    self.entries = [];

                    self.database.each(
                        `SELECT id, bbs_name, sysop, telnet, www, location, software, submitter_user_id, notes
                        FROM bbs_list;`,
                        (err, row) => {
                            if (!err) {
                                self.entries.push({
                                    text: row.bbs_name, //  standard field
                                    id: row.id,
                                    bbsName: row.bbs_name,
                                    sysOp: row.sysop,
                                    telnet: row.telnet,
                                    www: row.www,
                                    location: row.location,
                                    software: row.software,
                                    submitterUserId: row.submitter_user_id,
                                    notes: row.notes,
                                });
                            }
                        },
                        err => {
                            return callback(err, entriesView);
                        }
                    );
                },
                function getUserNames(entriesView, callback) {
                    async.each(
                        self.entries,
                        (entry, next) => {
                            User.getUserName(entry.submitterUserId, (err, username) => {
                                if (username) {
                                    entry.submitter = username;
                                } else {
                                    entry.submitter = 'N/A';
                                }
                                return next();
                            });
                        },
                        () => {
                            return callback(null, entriesView);
                        }
                    );
                },
                function populateEntries(entriesView, callback) {
                    self.setEntries(entriesView);

                    entriesView.on('index update', idx => {
                        const entry = self.entries[idx];

                        self.drawSelectedEntry(entry);

                        if (!entry) {
                            self.selectedBBS = -1;
                        } else {
                            self.selectedBBS = idx;
                        }
                    });

                    if (self.selectedBBS >= 0) {
                        entriesView.setFocusItemIndex(self.selectedBBS);
                        self.drawSelectedEntry(self.entries[self.selectedBBS]);
                    } else if (self.entries.length > 0) {
                        self.selectedBBS = 0;
                        entriesView.setFocusItemIndex(0);
                        self.drawSelectedEntry(self.entries[0]);
                    }

                    entriesView.redraw();

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
                    self.client.term.rawWrite(ansi.resetScreen());

                    theme.displayThemedAsset(
                        self.menuConfig.config.art.add,
                        self.client,
                        { font: self.menuConfig.font },
                        (err, artData) => {
                            return callback(err, artData);
                        }
                    );
                },
                function initOrRedrawViewController(artData, callback) {
                    if (_.isUndefined(self.viewControllers.add)) {
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

                        return vc.loadFromMenuConfig(loadOpts, callback);
                    } else {
                        self.viewControllers.add.setFocus(true);
                        self.viewControllers.add.redrawAll();
                        self.viewControllers.add.switchFocus(MciViewIds.add.BBSName);
                        return callback(null);
                    }
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
        [
            'BBSName',
            'Sysop',
            'Telnet',
            'Www',
            'Location',
            'Software',
            'Error',
            'Notes',
        ].forEach(mciName => {
            this.setViewText('add', MciViewIds.add[mciName], '');
        });
    }

    initDatabase(cb) {
        const self = this;

        async.series(
            [
                function openDatabase(callback) {
                    self.database = getTransactionDatabase(
                        new sqlite3.Database(getModDatabasePath(moduleInfo), callback)
                    );
                },
                function createTables(callback) {
                    self.database.serialize(() => {
                        self.database.run(
                            `CREATE TABLE IF NOT EXISTS bbs_list (
                                id                  INTEGER PRIMARY KEY,
                                bbs_name            VARCHAR NOT NULL,
                                sysop               VARCHAR NOT NULL,
                                telnet              VARCHAR NOT NULL,
                                www                 VARCHAR,
                                location            VARCHAR,
                                software            VARCHAR,
                                submitter_user_id   INTEGER NOT NULL,
                                notes               VARCHAR
                            );`
                        );
                    });
                    callback(null);
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
