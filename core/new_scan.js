/* jslint node: true */
'use strict';

//  ENiGMA½
const msgArea = require('./message_area.js');
const MenuModule = require('./menu_module.js').MenuModule;
const ViewController = require('./view_controller.js').ViewController;
const stringFormat = require('./string_format.js');
const FileEntry = require('./file_entry.js');
const FileBaseFilters = require('./file_base_filter.js');
const Errors = require('./enig_error.js').Errors;
const { getAvailableFileAreaTags } = require('./file_base_area.js');
const { valueAsArray } = require('./misc_util.js');
const { SystemInternalConfTags } = require('./message_const');
const UserProps = require('./user_property.js');

//  deps
const _ = require('lodash');
const async = require('async');

exports.moduleInfo = {
    name: 'New Scan',
    desc: 'Performs a new scan against various areas of the system',
    author: 'NuSkooler',
};

/*
 * :TODO:
 * * User configurable new scan: Area selection (avail from messages area) (sep module)
 * * Add status TL/VM (either/both should update if present)
 * *

*/

const MciCodeIds = {
    ScanStatusLabel: 1, //  TL1
    ScanStatusList: 2, //  VM2 (appends)
};

const Steps = {
    MessageConfs: 'messageConferences',
    FileBase: 'fileBase',

    Finished: 'finished',
};

exports.getModule = class NewScanModule extends MenuModule {
    constructor(options) {
        super(options);

        this.newScanFullExit = _.get(options, 'lastMenuResult.fullExit', false);

        this.currentStep = Steps.MessageConfs;
        this.currentScanAux = {};

        //  :TODO: Make this conf/area specific:
        //  :TODO: Use newer custom info format - TL10+
        const config = this.menuConfig.config;
        this.scanStartFmt = config.scanStartFmt || 'Scanning {confName} - {areaName}...';
        this.scanFinishNoneFmt = config.scanFinishNoneFmt || 'Nothing new';
        this.scanFinishNewFmt = config.scanFinishNewFmt || '{count} entries found';
        this.scanCompleteMsg = config.scanCompleteMsg || 'Finished newscan';
    }

    updateScanStatus(statusText) {
        this.setViewText('allViews', MciCodeIds.ScanStatusLabel, statusText);
    }

    newScanMessageConference(cb) {
        //  lazy init
        if (!this.sortedMessageConfs) {
            //  includeSystemInternal: pick up private mail, bulletins, etc.
            //  includeHidden:         pick up confs flagged hideFromBrowse
            //                         (e.g. ActivityPub) that are kept out of
            //                         the regular browse UI but still scanned.
            const getAvailOpts = {
                includeSystemInternal: true,
                includeHidden: true,
            };

            this.sortedMessageConfs = _.map(
                msgArea.getAvailableMessageConferences(this.client, getAvailOpts),
                (v, k) => {
                    return {
                        confTag: k,
                        conf: v,
                    };
                }
            );

            //
            //  Sort conferences by name, other than "System Internal" which should
            //  always come first such that we display private mails/etc. before
            //  other conferences & areas
            //
            this.sortedMessageConfs.sort((a, b) => {
                if (SystemInternalConfTags.includes(a.confTag)) {
                    return -1;
                } else {
                    return a.conf.name.localeCompare(b.conf.name, {
                        sensitivity: false,
                        numeric: true,
                    });
                }
            });

            this.currentScanAux.conf = this.currentScanAux.conf || 0;
            this.currentScanAux.area = this.currentScanAux.area || 0;
        }

        const currentConf = this.sortedMessageConfs[this.currentScanAux.conf];

        this.newScanMessageArea(currentConf, () => {
            if (this.sortedMessageConfs.length > this.currentScanAux.conf + 1) {
                this.currentScanAux.conf += 1;
                this.currentScanAux.area = 0;

                return this.newScanMessageConference(cb); //  recursive to next conf
            }

            this.updateScanStatus(this.scanCompleteMsg);
            return cb(Errors.DoesNotExist('No more conferences'));
        });
    }

    //  Returns null (scan all) or an array of area tag strings the user has selected.
    _getSelectedScanAreaTags() {
        const raw = this.client.user.getProperty(UserProps.NewScanAreaTags);
        if (!raw) {
            return null;
        }
        try {
            const tags = JSON.parse(raw);
            return Array.isArray(tags) && tags.length > 0 ? tags : null;
        } catch (e) {
            return null;
        }
    }

    newScanMessageArea(conf, cb) {
        //  :TODO: it would be nice to cache this - must be done by conf!
        const omitMessageAreaTags = valueAsArray(
            _.get(this, 'menuConfig.config.omitMessageAreaTags', [])
        );

        //  Lazy-init the user's selected area tags once per scan session
        if (this._selectedAreaTags === undefined) {
            this._selectedAreaTags = this._getSelectedScanAreaTags();
        }

        const sortedAreas = msgArea
            .getSortedAvailMessageAreasByConfTag(conf.confTag, {
                client: this.client,
                includeHidden: true,
            })
            .filter(area => {
                if (omitMessageAreaTags.includes(area.areaTag)) {
                    return false;
                }
                if (
                    this._selectedAreaTags !== null &&
                    !this._selectedAreaTags.includes(area.areaTag)
                ) {
                    return false;
                }
                return true;
            });
        const currentArea = sortedAreas[this.currentScanAux.area];

        //
        //  Scan and update index until we find something. If results are found,
        //  we'll goto the list module & show them.
        //
        const self = this;
        async.waterfall(
            [
                function checkAndUpdateIndex(callback) {
                    //  Advance to next area if possible
                    if (sortedAreas.length >= self.currentScanAux.area + 1) {
                        self.currentScanAux.area += 1;
                        return callback(null);
                    } else {
                        self.updateScanStatus(self.scanCompleteMsg);
                        return callback(Errors.DoesNotExist('No more areas')); //  this will stop our scan
                    }
                },
                function updateStatusScanStarted(callback) {
                    self.updateScanStatus(
                        stringFormat(self.scanStartFmt, {
                            confName: conf.conf.name,
                            confDesc: conf.conf.desc,
                            areaName: currentArea.area.name,
                            areaDesc: currentArea.area.desc,
                        })
                    );
                    return callback(null);
                },
                function getNewMessagesCountInArea(callback) {
                    //  Use the effective last-read ID which incorporates the
                    //  NewScanMinTimestamp floor, ensuring count and list queries
                    //  use the same baseline (avoids empty-list false-positives).
                    msgArea.getEffectiveNewScanLastReadId(
                        self.client.user,
                        currentArea.areaTag,
                        (err, effectiveLastReadId) => {
                            if (err) {
                                return callback(null, 0, 0);
                            }
                            const Message = require('./message.js');
                            const filter = {
                                areaTag: currentArea.areaTag,
                                newerThanMessageId: effectiveLastReadId,
                                resultType: 'count',
                            };
                            if (Message.isPrivateAreaTag(currentArea.areaTag)) {
                                filter.privateTagUserId = self.client.user.userId;
                            }
                            Message.findMessages(filter, (err, count) => {
                                callback(err, count);
                            });
                        }
                    );
                },
                function displayMessageList(newMessageCount) {
                    if (newMessageCount <= 0) {
                        return self.newScanMessageArea(conf, cb); //  next area, if any
                    }

                    const nextModuleOpts = {
                        extraArgs: {
                            messageAreaTag: currentArea.areaTag,
                        },
                    };

                    //  ActivityPub-flavored areas (e.g. activitypub_shared)
                    //  have a dedicated browser/viewer with thread, attachment,
                    //  and reaction handling that the standard msg_list path
                    //  cannot replicate. Route to the AP newscan menu instead.
                    //
                    //  The AP browser does not maintain message-DB last-read
                    //  state per note, so advance the area's last-read pointer
                    //  to the current latest message before handing off; the
                    //  next newscan cycle will then only re-fire if more notes
                    //  arrive after this one.
                    if (currentArea.area.addressFlavor === 'activitypub') {
                        const targetMenu =
                            self.menuConfig.config.newScanActivityPubList ||
                            'newScanActivityPubList';
                        const Message = require('./message.js');
                        Message.findMessages(
                            {
                                areaTag: currentArea.areaTag,
                                resultType: 'id',
                                limit: 1,
                            },
                            (err, ids) => {
                                if (err || !ids || ids.length === 0) {
                                    return self.gotoMenu(targetMenu, nextModuleOpts);
                                }
                                msgArea.updateMessageAreaLastReadId(
                                    self.client.user.userId,
                                    currentArea.areaTag,
                                    ids[0],
                                    true /* allowOlder: noop, we always advance */,
                                    () => self.gotoMenu(targetMenu, nextModuleOpts)
                                );
                            }
                        );
                        return;
                    }

                    return self.gotoMenu(
                        self.menuConfig.config.newScanMessageList || 'newScanMessageList',
                        nextModuleOpts
                    );
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    newScanFileBase(cb) {
        //  :TODO: add in steps
        const omitFileAreaTags = valueAsArray(
            _.get(this, 'menuConfig.config.omitFileAreaTags', [])
        );
        const filterCriteria = {
            newerThanFileId: FileBaseFilters.getFileBaseLastViewedFileIdByUser(
                this.client.user
            ),
            areaTag: getAvailableFileAreaTags(this.client).filter(
                ft => !omitFileAreaTags.includes(ft)
            ),
            order: 'ascending', //  oldest first
        };

        FileEntry.findFiles(filterCriteria, (err, fileIds) => {
            if (err || 0 === fileIds.length) {
                return cb(err ? err : Errors.DoesNotExist('No more new files'));
            }

            FileBaseFilters.setFileBaseLastViewedFileIdForUser(
                this.client.user,
                fileIds[fileIds.length - 1]
            );

            const menuOpts = {
                extraArgs: {
                    fileList: fileIds,
                },
            };

            return this.gotoMenu(
                this.menuConfig.config.newScanFileBaseList || 'newScanFileBaseList',
                menuOpts
            );
        });
    }

    getSaveState() {
        return {
            currentStep: this.currentStep,
            currentScanAux: this.currentScanAux,
        };
    }

    restoreSavedState(savedState) {
        this.currentStep = savedState.currentStep;
        this.currentScanAux = savedState.currentScanAux;
    }

    performScanCurrentStep(cb) {
        switch (this.currentStep) {
            case Steps.MessageConfs:
                this.newScanMessageConference(() => {
                    this.currentStep = Steps.FileBase;
                    return this.performScanCurrentStep(cb);
                });
                break;

            case Steps.FileBase:
                this.newScanFileBase(() => {
                    this.currentStep = Steps.Finished;
                    return this.performScanCurrentStep(cb);
                });
                break;

            default:
                return cb(null);
        }
    }

    mciReady(mciData, cb) {
        if (this.newScanFullExit) {
            //  user has canceled the entire scan @ message list view
            return cb(null);
        }

        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            const self = this;
            const vc = (self.viewControllers.allViews = new ViewController({
                client: self.client,
            }));

            //  :TODO: display scan step/etc.

            async.series(
                [
                    function loadFromConfig(callback) {
                        const loadOpts = {
                            callingMenu: self,
                            mciMap: mciData.menu,
                            noInput: true,
                        };

                        vc.loadFromMenuConfig(loadOpts, callback);
                    },
                    function validateMci(callback) {
                        return self.validateMCIByViewIds(
                            'allViews',
                            [MciCodeIds.ScanStatusLabel],
                            callback
                        );
                    },
                    function performCurrentStepScan(callback) {
                        return self.performScanCurrentStep(callback);
                    },
                ],
                err => {
                    if (err) {
                        self.client.log.error(
                            { error: err.toString() },
                            'Error during new scan'
                        );
                    }
                    return cb(err);
                }
            );
        });
    }
};
