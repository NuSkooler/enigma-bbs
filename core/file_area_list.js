/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const ViewController = require('./view_controller.js').ViewController;
const ansi = require('./ansi_term.js');
const theme = require('./theme.js');
const FileEntry = require('./file_entry.js');
const stringFormat = require('./string_format.js');
const FileArea = require('./file_base_area.js');
const Errors = require('./enig_error.js').Errors;
const ErrNotEnabled = require('./enig_error.js').ErrorReasons.NotEnabled;
const ArchiveUtil = require('./archive_util.js');
const Config = require('./config.js').get;
const DownloadQueue = require('./download_queue.js');
const FileAreaWeb = require('./file_area_web.js');
const FileBaseFilters = require('./file_base_filter.js');
const resolveMimeType = require('./mime_util.js').resolveMimeType;
const isAnsi = require('./string_util.js').isAnsi;
const controlCodesToAnsi = require('./color_codes.js').controlCodesToAnsi;

//  deps
const async = require('async');
const _ = require('lodash');
const moment = require('moment');
const paths = require('path');

exports.moduleInfo = {
    name: 'File Area List',
    desc: 'Lists contents of file an file area',
    author: 'NuSkooler',
};

const FormIds = {
    browse: 0,
    details: 1,
    detailsGeneral: 2,
    detailsNfo: 3,
    detailsFileList: 4,
};

const MciViewIds = {
    browse: {
        desc: 1,
        navMenu: 2,

        customRangeStart: 10, //  10+ = customs
    },
    details: {
        navMenu: 1,
        infoXyTop: 2, //  %XY starting position for info area
        infoXyBottom: 3,

        customRangeStart: 10, //  10+ = customs
    },
    detailsGeneral: {
        customRangeStart: 10, //    10+ = customs
    },
    detailsNfo: {
        nfo: 1,

        customRangeStart: 10, //  10+ = customs
    },
    detailsFileList: {
        fileList: 1,

        customRangeStart: 10, //  10+ = customs
    },
};

exports.getModule = class FileAreaList extends MenuModule {
    constructor(options) {
        super(options);

        this.filterCriteria = _.get(options, 'extraArgs.filterCriteria');
        this.fileList = _.get(options, 'extraArgs.fileList');
        this.lastFileNextExit = _.get(options, 'extraArgs.lastFileNextExit', true);

        if (this.fileList) {
            //  we'll need to adjust position as well!
            this.fileListPosition = 0;
        }

        this.dlQueue = new DownloadQueue(this.client);

        if (!this.filterCriteria) {
            this.filterCriteria = FileBaseFilters.getActiveFilter(this.client);
        }

        if (_.isString(this.filterCriteria)) {
            this.filterCriteria = JSON.parse(this.filterCriteria);
        }

        if (_.has(options, 'lastMenuResult.value')) {
            this.lastMenuResultValue = options.lastMenuResult.value;
        }

        this.menuMethods = {
            nextFile: (formData, extraArgs, cb) => {
                if (this.fileListPosition + 1 < this.fileList.length) {
                    this.fileListPosition += 1;

                    return this.displayBrowsePage(true, cb); //  true=clerarScreen
                }

                if (this.lastFileNextExit) {
                    return this.prevMenu(cb);
                }

                return cb(null);
            },
            prevFile: (formData, extraArgs, cb) => {
                if (this.fileListPosition > 0) {
                    --this.fileListPosition;

                    return this.displayBrowsePage(true, cb); //  true=clearScreen
                }

                return cb(null);
            },
            viewDetails: (formData, extraArgs, cb) => {
                this.viewControllers.browse.setFocus(false);
                return this.displayDetailsPage(cb);
            },
            detailsQuit: (formData, extraArgs, cb) => {
                ['detailsNfo', 'detailsFileList', 'details'].forEach(n => {
                    const vc = this.viewControllers[n];
                    if (vc) {
                        vc.detachClientEvents();
                    }
                });

                return this.displayBrowsePage(true, cb); //  true=clearScreen
            },
            toggleQueue: (formData, extraArgs, cb) => {
                this.dlQueue.toggle(this.currentFileEntry);
                this.updateQueueIndicator();
                return cb(null);
            },
            showWebDownloadLink: (formData, extraArgs, cb) => {
                return this.fetchAndDisplayWebDownloadLink(cb);
            },
            displayHelp: (formData, extraArgs, cb) => {
                return this.displayHelpPage(cb);
            },
            movementKeyPressed: (formData, extraArgs, cb) => {
                return this._handleMovementKeyPress(_.get(formData, 'key.name'), cb);
            },
        };
    }

    enter() {
        super.enter();
    }

    leave() {
        super.leave();
    }

    getSaveState() {
        return {
            fileList: this.fileList,
            fileListPosition: this.fileListPosition,
        };
    }

    restoreSavedState(savedState) {
        if (savedState) {
            this.fileList = savedState.fileList;
            this.fileListPosition = savedState.fileListPosition;
        }
    }

    updateFileEntryWithMenuResult(cb) {
        if (!this.lastMenuResultValue) {
            return cb(null);
        }

        if (_.isNumber(this.lastMenuResultValue.rating)) {
            const fileId = this.fileList[this.fileListPosition];
            FileEntry.persistUserRating(
                fileId,
                this.client.user.userId,
                this.lastMenuResultValue.rating,
                err => {
                    if (err) {
                        this.client.log.warn(
                            { error: err.message, fileId: fileId },
                            'Failed to persist file rating'
                        );
                    }
                    return cb(null);
                }
            );
        } else {
            return cb(null);
        }
    }

    initSequence() {
        const self = this;

        async.series(
            [
                function preInit(callback) {
                    return self.updateFileEntryWithMenuResult(callback);
                },
                function beforeArt(callback) {
                    return self.beforeArt(callback);
                },
                function display(callback) {
                    return self.displayBrowsePage(false, err => {
                        if (err) {
                            self.gotoMenu(
                                self.menuConfig.config.noResultsMenu ||
                                    'fileBaseListEntriesNoResults'
                            );
                        }
                        return callback(err);
                    });
                },
            ],
            () => {
                self.finishedLoading();
            }
        );
    }

    populateCurrentEntryInfo(cb) {
        const config = this.menuConfig.config;
        const currEntry = this.currentFileEntry;

        const uploadTimestampFormat =
            config.uploadTimestampFormat ||
            this.client.currentTheme.helpers.getDateFormat('short');
        const area = FileArea.getFileAreaByTag(currEntry.areaTag);
        const hashTagsSep = config.hashTagsSep || ', ';
        const isQueuedIndicator = config.isQueuedIndicator || 'Y';
        const isNotQueuedIndicator = config.isNotQueuedIndicator || 'N';

        const entryInfo = (currEntry.entryInfo = {
            fileId: currEntry.fileId,
            areaTag: currEntry.areaTag,
            areaName: _.get(area, 'name') || 'N/A',
            areaDesc: _.get(area, 'desc') || 'N/A',
            fileSha256: currEntry.fileSha256,
            fileName: currEntry.fileName,
            desc: currEntry.desc || '',
            descLong: currEntry.descLong || '',
            userRating: currEntry.userRating,
            uploadTimestamp: moment(currEntry.uploadTimestamp).format(
                uploadTimestampFormat
            ),
            hashTags: Array.from(currEntry.hashTags).join(hashTagsSep),
            isQueued: this.dlQueue.isQueued(currEntry)
                ? isQueuedIndicator
                : isNotQueuedIndicator,
            webDlLink: '', //  :TODO: fetch web any existing web d/l link
            webDlExpire: '', //  :TODO: fetch web d/l link expire time
        });

        //
        //  We need the entry object to contain meta keys even if they are empty as
        //  consumers may very likely attempt to use them
        //
        const metaValues = FileEntry.WellKnownMetaValues;
        metaValues.forEach(name => {
            const value = !_.isUndefined(currEntry.meta[name])
                ? currEntry.meta[name]
                : 'N/A';
            entryInfo[_.camelCase(name)] = value;
        });

        if (entryInfo.archiveType) {
            const mimeType = resolveMimeType(entryInfo.archiveType);
            let desc;
            if (mimeType) {
                let fileType = _.get(Config(), ['fileTypes', mimeType]);

                if (Array.isArray(fileType)) {
                    //  further refine by extention
                    fileType = fileType.find(
                        ft => paths.extname(currEntry.fileName) === ft.ext
                    );
                }
                desc = fileType && fileType.desc;
            }
            entryInfo.archiveTypeDesc = desc || mimeType || entryInfo.archiveType;
        } else {
            entryInfo.archiveTypeDesc = 'N/A';
        }

        entryInfo.uploadByUsername = entryInfo.uploadByUserName =
            entryInfo.uploadByUsername || 'N/A'; //  may be imported
        entryInfo.hashTags = entryInfo.hashTags || '(none)';

        //  create a rating string, e.g. "**---"
        const userRatingTicked = config.userRatingTicked || '*';
        const userRatingUnticked = config.userRatingUnticked || '';
        entryInfo.userRating = ~~Math.round(entryInfo.userRating) || 0; //  be safe!
        entryInfo.userRatingString = userRatingTicked.repeat(entryInfo.userRating);
        if (entryInfo.userRating < 5) {
            entryInfo.userRatingString += userRatingUnticked.repeat(
                5 - entryInfo.userRating
            );
        }

        FileAreaWeb.getExistingTempDownloadServeItem(
            this.client,
            this.currentFileEntry,
            (err, serveItem) => {
                if (err) {
                    entryInfo.webDlExpire = '';
                    if (ErrNotEnabled === err.reasonCode) {
                        entryInfo.webDlExpire =
                            config.webDlLinkNoWebserver || 'Web server is not enabled';
                    } else {
                        entryInfo.webDlLink =
                            config.webDlLinkNeedsGenerated || 'Not yet generated';
                    }
                } else {
                    const webDlExpireTimeFormat =
                        config.webDlExpireTimeFormat ||
                        this.client.currentTheme.helpers.getDateTimeFormat('short');

                    entryInfo.webDlLink =
                        ansi.vtxHyperlink(this.client, serveItem.url) + serveItem.url;
                    entryInfo.webDlExpire = moment(serveItem.expireTimestamp).format(
                        webDlExpireTimeFormat
                    );
                }

                return cb(null);
            }
        );
    }

    populateCustomLabels(category, startId) {
        return this.updateCustomViewTextsWithFilter(
            category,
            startId,
            this.currentFileEntry.entryInfo
        );
    }

    displayArtAndPrepViewController(name, options, cb) {
        const self = this;
        const config = this.menuConfig.config;

        async.waterfall(
            [
                function readyAndDisplayArt(callback) {
                    if (options.clearScreen) {
                        self.client.term.rawWrite(ansi.resetScreen());
                    }

                    theme.displayThemedAsset(
                        config.art[name],
                        self.client,
                        { font: self.menuConfig.font, trailingLF: false },
                        (err, artData) => {
                            return callback(err, artData);
                        }
                    );
                },
                function prepeareViewController(artData, callback) {
                    if (_.isUndefined(self.viewControllers[name])) {
                        const vcOpts = {
                            client: self.client,
                            formId: FormIds[name],
                        };

                        if (!_.isUndefined(options.noInput)) {
                            vcOpts.noInput = options.noInput;
                        }

                        const vc = self.addViewController(
                            name,
                            new ViewController(vcOpts)
                        );

                        if ('details' === name) {
                            try {
                                self.detailsInfoArea = {
                                    top: artData.mciMap.XY2.position,
                                    bottom: artData.mciMap.XY3.position,
                                };
                            } catch (e) {
                                return callback(
                                    Errors.DoesNotExist(
                                        'Missing XY2 and XY3 position indicators!'
                                    )
                                );
                            }
                        }

                        const loadOpts = {
                            callingMenu: self,
                            mciMap: artData.mciMap,
                            formId: FormIds[name],
                        };

                        return vc.loadFromMenuConfig(loadOpts, callback);
                    }

                    self.viewControllers[name].setFocus(true);
                    return callback(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    displayBrowsePage(clearScreen, cb) {
        const self = this;

        async.series(
            [
                function fetchEntryData(callback) {
                    if (self.fileList) {
                        return callback(null);
                    }
                    return self.loadFileIds(false, callback); //  false=do not force
                },
                function checkEmptyResults(callback) {
                    if (0 === self.fileList.length) {
                        return callback(
                            Errors.General('No results for criteria', 'NORESULTS')
                        );
                    }
                    return callback(null);
                },
                function prepArtAndViewController(callback) {
                    return self.displayArtAndPrepViewController(
                        'browse',
                        { clearScreen: clearScreen },
                        callback
                    );
                },
                function loadCurrentFileInfo(callback) {
                    self.currentFileEntry = new FileEntry();

                    self.currentFileEntry.load(
                        self.fileList[self.fileListPosition],
                        err => {
                            if (err) {
                                return callback(err);
                            }

                            return self.populateCurrentEntryInfo(callback);
                        }
                    );
                },
                function populateDesc(callback) {
                    if (_.isString(self.currentFileEntry.desc)) {
                        const descView = self.viewControllers.browse.getView(
                            MciViewIds.browse.desc
                        );
                        if (descView) {
                            //
                            //  For descriptions we want to support as many color code systems
                            //  as we can for coverage of what is found in the while (e.g. Renegade
                            //  pipes, PCB @X##, etc.)
                            //
                            //  MLTEV doesn't support all of this, so convert. If we produced ANSI
                            //  esc sequences, we'll proceed with specialization, else just treat
                            //  it as text.
                            //
                            const desc = controlCodesToAnsi(self.currentFileEntry.desc);
                            if (
                                desc.length != self.currentFileEntry.desc.length ||
                                isAnsi(desc)
                            ) {
                                const opts = {
                                    prepped: false,
                                    forceLineTerm: true,
                                };

                                //
                                //  if SAUCE states a term width, honor it else we may see
                                //  display corruption
                                //
                                const sauceTermWidth = _.get(
                                    self.currentFileEntry.meta,
                                    'desc_sauce.Character.characterWidth'
                                );
                                if (_.isNumber(sauceTermWidth)) {
                                    opts.termWidth = sauceTermWidth;
                                }

                                descView.setAnsi(desc, opts, () => {
                                    return callback(null);
                                });
                            } else {
                                descView.setText(self.currentFileEntry.desc);
                                return callback(null);
                            }
                        }
                    } else {
                        return callback(null);
                    }
                },
                function populateAdditionalViews(callback) {
                    self.updateQueueIndicator();
                    self.populateCustomLabels(
                        'browse',
                        MciViewIds.browse.customRangeStart
                    );
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

    displayDetailsPage(cb) {
        const self = this;

        async.series(
            [
                function prepArtAndViewController(callback) {
                    return self.displayArtAndPrepViewController(
                        'details',
                        { clearScreen: true },
                        callback
                    );
                },
                function populateViews(callback) {
                    self.populateCustomLabels(
                        'details',
                        MciViewIds.details.customRangeStart
                    );
                    return callback(null);
                },
                function prepSection(callback) {
                    return self.displayDetailsSection('general', false, callback);
                },
                function listenNavChanges(callback) {
                    const navMenu = self.viewControllers.details.getView(
                        MciViewIds.details.navMenu
                    );
                    navMenu.setFocusItemIndex(0);

                    navMenu.on('index update', index => {
                        const sectionName = {
                            0: 'general',
                            1: 'nfo',
                            2: 'fileList',
                        }[index];

                        if (sectionName) {
                            self.displayDetailsSection(sectionName, true);
                        }
                    });

                    return callback(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    displayHelpPage(cb) {
        this.displayAsset(this.menuConfig.config.art.help, { clearScreen: true }, () => {
            this.client.waitForKeyPress(() => {
                return this.displayBrowsePage(true, cb);
            });
        });
    }

    _handleMovementKeyPress(keyName, cb) {
        const descView = this.viewControllers.browse.getView(MciViewIds.browse.desc);
        if (!descView) {
            return cb(null);
        }

        switch (keyName) {
            case 'down arrow':
                descView.scrollDocumentUp();
                break;
            case 'up arrow':
                descView.scrollDocumentDown();
                break;
            case 'page up':
                descView.keyPressPageUp();
                break;
            case 'page down':
                descView.keyPressPageDown();
                break;
        }

        this.viewControllers.browse.switchFocus(MciViewIds.browse.navMenu);
        return cb(null);
    }

    fetchAndDisplayWebDownloadLink(cb) {
        const self = this;

        async.series(
            [
                function generateLinkIfNeeded(callback) {
                    if (self.currentFileEntry.webDlExpireTime < moment()) {
                        return callback(null);
                    }

                    const expireTime = moment().add(
                        Config().fileBase.web.expireMinutes,
                        'minutes'
                    );

                    FileAreaWeb.createAndServeTempDownload(
                        self.client,
                        self.currentFileEntry,
                        { expireTime: expireTime },
                        (err, url) => {
                            if (err) {
                                return callback(err);
                            }

                            self.currentFileEntry.webDlExpireTime = expireTime;

                            const webDlExpireTimeFormat =
                                self.menuConfig.config.webDlExpireTimeFormat ||
                                'YYYY-MMM-DD @ h:mm';

                            self.currentFileEntry.entryInfo.webDlLink =
                                ansi.vtxHyperlink(self.client, url) + url;
                            self.currentFileEntry.entryInfo.webDlExpire =
                                expireTime.format(webDlExpireTimeFormat);

                            return callback(null);
                        }
                    );
                },
                function updateActiveViews(callback) {
                    self.updateCustomViewTextsWithFilter(
                        'browse',
                        MciViewIds.browse.customRangeStart,
                        self.currentFileEntry.entryInfo,
                        { filter: ['{webDlLink}', '{webDlExpire}'] }
                    );
                    return callback(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    updateQueueIndicator() {
        const isQueuedIndicator = this.menuConfig.config.isQueuedIndicator || 'Y';
        const isNotQueuedIndicator = this.menuConfig.config.isNotQueuedIndicator || 'N';

        this.currentFileEntry.entryInfo.isQueued = stringFormat(
            this.dlQueue.isQueued(this.currentFileEntry)
                ? isQueuedIndicator
                : isNotQueuedIndicator
        );

        this.updateCustomViewTextsWithFilter(
            'browse',
            MciViewIds.browse.customRangeStart,
            this.currentFileEntry.entryInfo,
            { filter: ['{isQueued}'] }
        );
    }

    cacheArchiveEntries(cb) {
        //  check cache
        if (this.currentFileEntry.archiveEntries) {
            return cb(null, 'cache');
        }

        const areaInfo = FileArea.getFileAreaByTag(this.currentFileEntry.areaTag);
        if (!areaInfo) {
            return cb(Errors.Invalid('Invalid area tag'));
        }

        const filePath = this.currentFileEntry.filePath;
        const archiveUtil = ArchiveUtil.getInstance();

        archiveUtil.listEntries(
            filePath,
            this.currentFileEntry.entryInfo.archiveType,
            (err, entries) => {
                if (err) {
                    return cb(err);
                }

                //  assign and add standard "text" member for itemFormat
                this.currentFileEntry.archiveEntries = entries.map(e =>
                    Object.assign(e, { text: `${e.fileName} (${e.byteSize})` })
                );
                return cb(null, 're-cached');
            }
        );
    }

    setFileListNoListing(text) {
        const fileListView = this.viewControllers.detailsFileList.getView(
            MciViewIds.detailsFileList.fileList
        );
        if (fileListView) {
            fileListView.complexItems = false;
            fileListView.setItems([text]);
            fileListView.redraw();
        }
    }

    populateFileListing() {
        const fileListView = this.viewControllers.detailsFileList.getView(
            MciViewIds.detailsFileList.fileList
        );

        if (this.currentFileEntry.entryInfo.archiveType) {
            this.cacheArchiveEntries((err, cacheStatus) => {
                if (err) {
                    return this.setFileListNoListing('Failed to get file listing');
                }

                if ('re-cached' === cacheStatus) {
                    fileListView.setItems(this.currentFileEntry.archiveEntries);
                    fileListView.redraw();
                }
            });
        } else {
            const notAnArchiveFileName = stringFormat(
                this.menuConfig.config.notAnArchiveFormat || 'Not an archive',
                { fileName: this.currentFileEntry.fileName }
            );
            this.setFileListNoListing(notAnArchiveFileName);
        }
    }

    displayDetailsSection(sectionName, clearArea, cb) {
        const self = this;
        const name = `details${_.upperFirst(sectionName)}`;

        async.series(
            [
                function detachPrevious(callback) {
                    if (self.lastDetailsViewController) {
                        self.lastDetailsViewController.detachClientEvents();
                    }
                    return callback(null);
                },
                function prepArtAndViewController(callback) {
                    function gotoTopPos() {
                        self.client.term.rawWrite(
                            ansi.goto(self.detailsInfoArea.top[0], 1)
                        );
                    }

                    gotoTopPos();

                    if (clearArea) {
                        self.client.term.rawWrite(ansi.reset());

                        let pos = self.detailsInfoArea.top[0];
                        const bottom = self.detailsInfoArea.bottom[0];

                        while (pos++ <= bottom) {
                            self.client.term.rawWrite(ansi.eraseLine() + ansi.down());
                        }

                        gotoTopPos();
                    }

                    return self.displayArtAndPrepViewController(
                        name,
                        { clearScreen: false, noInput: true },
                        callback
                    );
                },
                function populateViews(callback) {
                    self.lastDetailsViewController = self.viewControllers[name];

                    switch (sectionName) {
                        case 'nfo':
                            {
                                const nfoView = self.viewControllers.detailsNfo.getView(
                                    MciViewIds.detailsNfo.nfo
                                );
                                if (!nfoView) {
                                    return callback(null);
                                }

                                if (isAnsi(self.currentFileEntry.entryInfo.descLong)) {
                                    nfoView.setAnsi(
                                        self.currentFileEntry.entryInfo.descLong,
                                        {
                                            prepped: false,
                                            forceLineTerm: true,
                                        },
                                        () => {
                                            return callback(null);
                                        }
                                    );
                                } else {
                                    nfoView.setText(
                                        self.currentFileEntry.entryInfo.descLong
                                    );
                                    return callback(null);
                                }
                            }
                            break;

                        case 'fileList':
                            self.populateFileListing();
                            return callback(null);

                        default:
                            return callback(null);
                    }
                },
                function setLabels(callback) {
                    self.populateCustomLabels(name, MciViewIds[name].customRangeStart);
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

    loadFileIds(force, cb) {
        if (
            force ||
            _.isUndefined(this.fileList) ||
            _.isUndefined(this.fileListPosition)
        ) {
            this.fileListPosition = 0;

            const filterCriteria = Object.assign({}, this.filterCriteria);
            if (!filterCriteria.areaTag) {
                filterCriteria.areaTag = FileArea.getAvailableFileAreaTags(this.client);
            }

            FileEntry.findFiles(filterCriteria, (err, fileIds) => {
                this.fileList = fileIds || [];
                return cb(err);
            });
        }
    }
};
