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
            const getAvailOpts = { includeSystemInternal: true }; //  find new private messages, bulletins, etc.

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
            //  Sort conferences by name, other than 'system_internal' which should
            //  always come first such that we display private mails/etc. before
            //  other conferences & areas
            //
            this.sortedMessageConfs.sort((a, b) => {
                if ('system_internal' === a.confTag) {
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

    newScanMessageArea(conf, cb) {
        //  :TODO: it would be nice to cache this - must be done by conf!
        const omitMessageAreaTags = valueAsArray(
            _.get(this, 'menuConfig.config.omitMessageAreaTags', [])
        );
        const sortedAreas = msgArea
            .getSortedAvailMessageAreasByConfTag(conf.confTag, { client: this.client })
            .filter(area => {
                return !omitMessageAreaTags.includes(area.areaTag);
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
                    msgArea.getNewMessageCountInAreaForUser(
                        self.client.user.userId,
                        currentArea.areaTag,
                        (err, newMessageCount) => {
                            callback(err, newMessageCount);
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
