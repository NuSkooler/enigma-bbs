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

//  deps
const async = require('async');
const _ = require('lodash');
const moment = require('moment');

exports.moduleInfo = {
    name: 'File Base Download Queue Manager',
    desc: 'Module for interacting with download queue/batch',
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

exports.getModule = class FileBaseDownloadQueueManager extends MenuModule {
    constructor(options) {
        super(options);

        this.dlQueue = new DownloadQueue(this.client);

        if (_.has(options, 'lastMenuResult.sentFileIds')) {
            this.sentFileIds = options.lastMenuResult.sentFileIds;
        }

        this.fallbackOnly = options.lastMenuResult ? true : false;

        this.menuMethods = {
            downloadAll: (formData, extraArgs, cb) => {
                const modOpts = {
                    extraArgs: {
                        sendQueue: this.dlQueue.items,
                        direction: 'send',
                    },
                };

                return this.gotoMenu(
                    this.menuConfig.config.fileTransferProtocolSelection ||
                        'fileTransferProtocolSelection',
                    modOpts,
                    cb
                );
            },
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
        };
    }

    initSequence() {
        if (0 === this.dlQueue.items.length) {
            if (this.sendFileIds) {
                //  we've finished everything up - just fall back
                return this.prevMenu();
            }

            //  Simply an empty D/L queue: Present a specialized "empty queue" page
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

    displayWebDownloadLinkForFileEntry(fileEntry) {
        FileAreaWeb.getExistingTempDownloadServeItem(
            this.client,
            fileEntry,
            (err, serveItem) => {
                if (serveItem && serveItem.url) {
                    const webDlExpireTimeFormat =
                        this.menuConfig.config.webDlExpireTimeFormat ||
                        'YYYY-MMM-DD @ h:mm';

                    fileEntry.webDlLink =
                        ansi.vtxHyperlink(this.client, serveItem.url) + serveItem.url;
                    fileEntry.webDlExpire = moment(serveItem.expireTimestamp).format(
                        webDlExpireTimeFormat
                    );
                } else {
                    fileEntry.webDlLink = '';
                    fileEntry.webDlExpire = '';
                }

                this.updateCustomViewTextsWithFilter(
                    'queueManager',
                    MciViewIds.queueManager.customRangeStart,
                    fileEntry,
                    { filter: ['{webDlLink}', '{webDlExpire}'] }
                );
            }
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
            this.displayWebDownloadLinkForFileEntry(fileEntry);
        });

        queueView.redraw();
        this.displayWebDownloadLinkForFileEntry(this.dlQueue.items[0]);

        return cb(null);
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
