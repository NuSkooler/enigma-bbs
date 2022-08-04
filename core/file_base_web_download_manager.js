/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const ViewController = require('./view_controller.js').ViewController;
const DownloadQueue = require('./download_queue.js');
const theme = require('./theme.js');
const ansi = require('./ansi_term.js');
const Errors = require('./enig_error.js').Errors;
const FileAreaWeb = require('./file_area_web.js');
const ErrNotEnabled = require('./enig_error.js').ErrorReasons.NotEnabled;
const Config = require('./config.js').get;

//  deps
const async = require('async');
const _ = require('lodash');
const moment = require('moment');

exports.moduleInfo = {
    name: 'File Base Download Web Queue Manager',
    desc: 'Module for interacting with web backed download queue/batch',
    author: 'NuSkooler',
};

const FormIds = {
    queueManager: 0,
};

const MciViewIds = {
    queueManager: {
        queue: 1,
        navMenu: 2,

        customRangeStart: 10,
    },
};

exports.getModule = class FileBaseWebDownloadQueueManager extends MenuModule {
    constructor(options) {
        super(options);

        this.dlQueue = new DownloadQueue(this.client);

        this.menuMethods = {
            removeItem: (formData, extraArgs, cb) => {
                const selectedItem = this.dlQueue.items[formData.value.queueItem];
                if (!selectedItem) {
                    return cb(null);
                }

                this.dlQueue.removeItems(selectedItem.fileId);

                //  :TODO: broken: does not redraw menu properly - needs fixed!
                return this.removeItemsFromDownloadQueueView(
                    formData.value.queueItem,
                    cb
                );
            },
            clearQueue: (formData, extraArgs, cb) => {
                this.dlQueue.clear();

                //  :TODO: broken: does not redraw menu properly - needs fixed!
                return this.removeItemsFromDownloadQueueView('all', cb);
            },
            getBatchLink: (formData, extraArgs, cb) => {
                return this.generateAndDisplayBatchLink(cb);
            },
        };
    }

    initSequence() {
        if (0 === this.dlQueue.items.length) {
            return this.gotoMenu(
                this.menuConfig.config.emptyQueueMenu ||
                    'fileBaseDownloadManagerEmptyQueue'
            );
        }

        const self = this;

        async.series(
            [
                function beforeArt(callback) {
                    return self.beforeArt(callback);
                },
                function display(callback) {
                    return self.displayQueueManagerPage(false, callback);
                },
            ],
            () => {
                return self.finishedLoading();
            }
        );
    }

    removeItemsFromDownloadQueueView(itemIndex, cb) {
        const queueView = this.viewControllers.queueManager.getView(
            MciViewIds.queueManager.queue
        );
        if (!queueView) {
            return cb(Errors.DoesNotExist('Queue view does not exist'));
        }

        if ('all' === itemIndex) {
            queueView.setItems([]);
            queueView.setFocusItems([]);
        } else {
            queueView.removeItem(itemIndex);
        }

        queueView.redraw();
        return cb(null);
    }

    displayFileInfoForFileEntry(fileEntry) {
        this.updateCustomViewTextsWithFilter(
            'queueManager',
            MciViewIds.queueManager.customRangeStart,
            fileEntry,
            { filter: ['{webDlLink}', '{webDlExpire}', '{fileName}'] } //  :TODO: Others....
        );
    }

    updateDownloadQueueView(cb) {
        const queueView = this.viewControllers.queueManager.getView(
            MciViewIds.queueManager.queue
        );
        if (!queueView) {
            return cb(Errors.DoesNotExist('Queue view does not exist'));
        }

        queueView.setItems(this.dlQueue.items);

        queueView.on('index update', idx => {
            const fileEntry = this.dlQueue.items[idx];
            this.displayFileInfoForFileEntry(fileEntry);
        });

        queueView.redraw();
        this.displayFileInfoForFileEntry(this.dlQueue.items[0]);

        return cb(null);
    }

    generateAndDisplayBatchLink(cb) {
        const expireTime = moment().add(Config().fileBase.web.expireMinutes, 'minutes');

        FileAreaWeb.createAndServeTempBatchDownload(
            this.client,
            this.dlQueue.items,
            {
                expireTime: expireTime,
            },
            (err, webBatchDlLink) => {
                //  :TODO: handle not enabled -> display such
                if (err) {
                    return cb(err);
                }

                const webDlExpireTimeFormat =
                    this.menuConfig.config.webDlExpireTimeFormat || 'YYYY-MMM-DD @ h:mm';

                const formatObj = {
                    webBatchDlLink:
                        ansi.vtxHyperlink(this.client, webBatchDlLink) + webBatchDlLink,
                    webBatchDlExpire: expireTime.format(webDlExpireTimeFormat),
                };

                this.updateCustomViewTextsWithFilter(
                    'queueManager',
                    MciViewIds.queueManager.customRangeStart,
                    formatObj,
                    { filter: Object.keys(formatObj).map(k => '{' + k + '}') }
                );

                return cb(null);
            }
        );
    }

    displayQueueManagerPage(clearScreen, cb) {
        const self = this;

        async.series(
            [
                function prepArtAndViewController(callback) {
                    return self.displayArtAndPrepViewController(
                        'queueManager',
                        FormIds.queueManager,
                        { clearScreen: clearScreen },
                        callback
                    );
                },
                function prepareQueueDownloadLinks(callback) {
                    const webDlExpireTimeFormat =
                        self.menuConfig.config.webDlExpireTimeFormat ||
                        'YYYY-MMM-DD @ h:mm';

                    const config = Config();
                    async.each(
                        self.dlQueue.items,
                        (fileEntry, nextFileEntry) => {
                            FileAreaWeb.getExistingTempDownloadServeItem(
                                self.client,
                                fileEntry,
                                (err, serveItem) => {
                                    if (err) {
                                        if (ErrNotEnabled === err.reasonCode) {
                                            return nextFileEntry(err); //  we should have caught this prior
                                        }

                                        const expireTime = moment().add(
                                            config.fileBase.web.expireMinutes,
                                            'minutes'
                                        );

                                        FileAreaWeb.createAndServeTempDownload(
                                            self.client,
                                            fileEntry,
                                            { expireTime: expireTime },
                                            (err, url) => {
                                                if (err) {
                                                    return nextFileEntry(err);
                                                }

                                                fileEntry.webDlLinkRaw = url;
                                                fileEntry.webDlLink =
                                                    ansi.vtxHyperlink(self.client, url) +
                                                    url;
                                                fileEntry.webDlExpire =
                                                    expireTime.format(
                                                        webDlExpireTimeFormat
                                                    );

                                                return nextFileEntry(null);
                                            }
                                        );
                                    } else {
                                        fileEntry.webDlLinkRaw = serveItem.url;
                                        fileEntry.webDlLink =
                                            ansi.vtxHyperlink(
                                                self.client,
                                                serveItem.url
                                            ) + serveItem.url;
                                        fileEntry.webDlExpire = moment(
                                            serveItem.expireTimestamp
                                        ).format(webDlExpireTimeFormat);
                                        return nextFileEntry(null);
                                    }
                                }
                            );
                        },
                        err => {
                            return callback(err);
                        }
                    );
                },
                function populateViews(callback) {
                    return self.updateDownloadQueueView(callback);
                },
            ],
            err => {
                if (cb) {
                    return cb(err);
                }
            }
        );
    }
};
