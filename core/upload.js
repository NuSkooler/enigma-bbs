/* jslint node: true */
'use strict';

//  enigma-bbs
const MenuModule = require('./menu_module.js').MenuModule;
const stringFormat = require('./string_format.js');
const getSortedAvailableFileAreas =
    require('./file_base_area.js').getSortedAvailableFileAreas;
const getAreaDefaultStorageDirectory =
    require('./file_base_area.js').getAreaDefaultStorageDirectory;
const scanFile = require('./file_base_area.js').scanFile;
const getFileAreaByTag = require('./file_base_area.js').getFileAreaByTag;
const getDescFromFileName = require('./file_base_area.js').getDescFromFileName;
const ansiGoto = require('./ansi_term.js').goto;
const moveFileWithCollisionHandling =
    require('./file_util.js').moveFileWithCollisionHandling;
const pathWithTerminatingSeparator =
    require('./file_util.js').pathWithTerminatingSeparator;
const Log = require('./logger.js').log;
const Errors = require('./enig_error.js').Errors;
const FileEntry = require('./file_entry.js');
const isAnsi = require('./string_util.js').isAnsi;
const Events = require('./events.js');

//  deps
const async = require('async');
const _ = require('lodash');
const temptmp = require('temptmp').createTrackedSession('upload');
const paths = require('path');
const sanatizeFilename = require('sanitize-filename');

exports.moduleInfo = {
    name: 'Upload',
    desc: 'Module for classic file uploads',
    author: 'NuSkooler',
};

const FormIds = {
    options: 0,
    processing: 1,
    fileDetails: 2,
    dupes: 3,
};

const MciViewIds = {
    options: {
        area: 1, //  area selection
        uploadType: 2, //  blind vs specify filename
        fileName: 3, //  for non-blind; not editable for blind
        navMenu: 4, //  next/cancel/etc.
        errMsg: 5, //  errors (e.g. filename cannot be blank)
    },

    processing: {
        calcHashIndicator: 1,
        archiveListIndicator: 2,
        descFileIndicator: 3,
        logStep: 4,
        customRangeStart: 10, //  10+ = customs
    },

    fileDetails: {
        desc: 1, //  defaults to 'desc' (e.g. from FILE_ID.DIZ)
        tags: 2, //  tag(s) for item
        estYear: 3,
        accept: 4, //  accept fields & continue
        customRangeStart: 10, //  10+ = customs
    },

    dupes: {
        dupeList: 1,
    },
};

exports.getModule = class UploadModule extends MenuModule {
    constructor(options) {
        super(options);

        this.interrupt = MenuModule.InterruptTypes.Never;

        if (_.has(options, 'lastMenuResult.recvFilePaths')) {
            this.recvFilePaths = options.lastMenuResult.recvFilePaths;
        }

        this.availAreas = getSortedAvailableFileAreas(this.client, { writeAcs: true });

        this.menuMethods = {
            optionsNavContinue: (formData, extraArgs, cb) => {
                return this.performUpload(cb);
            },

            fileDetailsContinue: (formData, extraArgs, cb) => {
                //  see displayFileDetailsPageForUploadEntry() for this hackery:
                cb(null);
                return this.fileDetailsCurrentEntrySubmitCallback(null, formData.value); //  move on to the next entry, if any
            },

            //  validation
            validateNonBlindFileName: (fileName, cb) => {
                if (0 === fileName.length) {
                    return cb(new Error('Filename cannot be empty'));
                }

                fileName = sanatizeFilename(fileName); //  remove unsafe chars, path info, etc.
                if (0 === fileName.length) {
                    //  sanatize nuked everything?
                    return cb(new Error('Invalid filename'));
                }

                //  At least SEXYZ doesn't like non-blind names that start with a number - it becomes confused ;-(
                if (/^[0-9].*$/.test(fileName)) {
                    return cb(new Error('Invalid filename'));
                }

                return cb(null);
            },
            viewValidationListener: (err, cb) => {
                const errView = this.viewControllers.options.getView(
                    MciViewIds.options.errMsg
                );
                if (errView) {
                    if (err) {
                        errView.setText(err.message);
                    } else {
                        errView.clearText();
                    }
                }

                return cb(null);
            },
        };
    }

    getSaveState() {
        //  if no areas, we're falling back due to lack of access/areas avail to upload to
        if (this.availAreas.length > 0) {
            return {
                uploadType: this.uploadType,
                tempRecvDirectory: this.tempRecvDirectory,
                areaInfo:
                    this.availAreas[
                        this.viewControllers.options
                            .getView(MciViewIds.options.area)
                            .getData()
                    ],
            };
        }
    }

    restoreSavedState(savedState) {
        if (savedState.areaInfo) {
            this.uploadType = savedState.uploadType;
            this.areaInfo = savedState.areaInfo;
            this.tempRecvDirectory = savedState.tempRecvDirectory;
        }
    }

    isBlindUpload() {
        return 'blind' === this.uploadType;
    }
    isFileTransferComplete() {
        return !_.isUndefined(this.recvFilePaths);
    }

    initSequence() {
        const self = this;

        if (0 === this.availAreas.length) {
            //
            return this.gotoMenu(
                this.menuConfig.config.noUploadAreasAvailMenu ||
                    'fileBaseNoUploadAreasAvail'
            );
        }

        async.series(
            [
                function before(callback) {
                    return self.beforeArt(callback);
                },
                function display(callback) {
                    if (self.isFileTransferComplete()) {
                        return self.displayProcessingPage(callback);
                    } else {
                        return self.displayOptionsPage(callback);
                    }
                },
            ],
            () => {
                return self.finishedLoading();
            }
        );
    }

    finishedLoading() {
        if (this.isFileTransferComplete()) {
            return this.processUploadedFiles();
        }
    }

    performUpload(cb) {
        temptmp.mkdir({ prefix: 'enigul-' }, (err, tempRecvDirectory) => {
            if (err) {
                return cb(err);
            }

            //  need a terminator for various external protocols
            this.tempRecvDirectory = pathWithTerminatingSeparator(tempRecvDirectory);

            const modOpts = {
                extraArgs: {
                    recvDirectory: this.tempRecvDirectory, //  we'll move files from here to their area container once processed/confirmed
                    direction: 'recv',
                },
            };

            if (!this.isBlindUpload()) {
                //  data has been sanatized at this point
                modOpts.extraArgs.recvFileName = this.viewControllers.options
                    .getView(MciViewIds.options.fileName)
                    .getData();
            }

            //
            //  Move along to protocol selection -> file transfer
            //  Upon completion, we'll re-enter the module with some file paths handed to us
            //
            return this.gotoMenu(
                this.menuConfig.config.fileTransferProtocolSelection ||
                    'fileTransferProtocolSelection',
                modOpts,
                cb
            );
        });
    }

    continueNonBlindUpload(cb) {
        return cb(null);
    }

    updateScanStepInfoViews(stepInfo) {
        //  :TODO: add some blinking (e.g. toggle items) indicators - see OBV.DOC

        const fmtObj = Object.assign({}, stepInfo);
        let stepIndicatorFmt = '';
        let logStepFmt;

        const fmtConfig = this.menuConfig.config;

        const indicatorStates = fmtConfig.indicatorStates || ['|', '/', '-', '\\'];
        const indicatorFinished = fmtConfig.indicatorFinished || '√';

        const indicator = {};
        const self = this;

        function updateIndicator(mci, isFinished) {
            indicator.mci = mci;

            if (isFinished) {
                indicator.text = indicatorFinished;
            } else {
                self.scanStatus.indicatorPos += 1;
                if (self.scanStatus.indicatorPos >= indicatorStates.length) {
                    self.scanStatus.indicatorPos = 0;
                }
                indicator.text = indicatorStates[self.scanStatus.indicatorPos];
            }
        }

        switch (stepInfo.step) {
            case 'start':
                logStepFmt = stepIndicatorFmt =
                    fmtConfig.scanningStartFormat || 'Scanning {fileName}';
                break;

            case 'hash_update':
                stepIndicatorFmt =
                    fmtConfig.calcHashFormat ||
                    'Calculating hash/checksums: {calcHashPercent}%';
                updateIndicator(MciViewIds.processing.calcHashIndicator);
                break;

            case 'hash_finish':
                stepIndicatorFmt =
                    fmtConfig.calcHashCompleteFormat ||
                    'Finished calculating hash/checksums';
                updateIndicator(MciViewIds.processing.calcHashIndicator, true);
                break;

            case 'archive_list_start':
                stepIndicatorFmt =
                    fmtConfig.extractArchiveListFormat || 'Extracting archive list';
                updateIndicator(MciViewIds.processing.archiveListIndicator);
                break;

            case 'archive_list_finish':
                fmtObj.archivedFileCount = stepInfo.archiveEntries.length;
                stepIndicatorFmt =
                    fmtConfig.extractArchiveListFinishFormat ||
                    'Archive list extracted ({archivedFileCount} files)';
                updateIndicator(MciViewIds.processing.archiveListIndicator, true);
                break;

            case 'archive_list_failed':
                stepIndicatorFmt =
                    fmtConfig.extractArchiveListFailedFormat ||
                    'Archive list extraction failed';
                break;

            case 'desc_files_start':
                stepIndicatorFmt =
                    fmtConfig.processingDescFilesFormat || 'Processing description files';
                updateIndicator(MciViewIds.processing.descFileIndicator);
                break;

            case 'desc_files_finish':
                stepIndicatorFmt =
                    fmtConfig.processingDescFilesFinishFormat ||
                    'Finished processing description files';
                updateIndicator(MciViewIds.processing.descFileIndicator, true);
                break;

            case 'finished':
                logStepFmt = stepIndicatorFmt =
                    fmtConfig.scanningStartFormat || 'Finished';
                break;
        }

        fmtObj.stepIndicatorText = stringFormat(stepIndicatorFmt, fmtObj);

        if (this.hasProcessingArt) {
            this.updateCustomViewTextsWithFilter(
                'processing',
                MciViewIds.processing.customRangeStart,
                fmtObj,
                { appendMultiLine: true }
            );

            if (indicator.mci && indicator.text) {
                this.setViewText('processing', indicator.mci, indicator.text);
            }

            if (logStepFmt) {
                this.setViewText(
                    'processing',
                    MciViewIds.processing.logStep,
                    stringFormat(logStepFmt, fmtObj),
                    { appendMultiLine: true }
                );
            }
        } else {
            this.client.term.pipeWrite(fmtObj.stepIndicatorText);
        }
    }

    scanFiles(cb) {
        const self = this;

        const results = {
            newEntries: [],
            dupes: [],
        };

        self.client.log.debug('Scanning upload(s)', { paths: this.recvFilePaths });

        let currentFileNum = 0;

        async.eachSeries(
            this.recvFilePaths,
            (filePath, nextFilePath) => {
                //  :TODO: virus scanning/etc. should occur around here

                currentFileNum += 1;

                self.scanStatus = {
                    indicatorPos: 0,
                };

                const scanOpts = {
                    areaTag: self.areaInfo.areaTag,
                    storageTag: self.areaInfo.storageTags[0],
                    hashTags: self.areaInfo.hashTags,
                };

                function handleScanStep(stepInfo, nextScanStep) {
                    stepInfo.totalFileNum = self.recvFilePaths.length;
                    stepInfo.currentFileNum = currentFileNum;

                    self.updateScanStepInfoViews(stepInfo);
                    return nextScanStep(null);
                }

                self.client.log.debug('Scanning file', { filePath: filePath });

                scanFile(
                    filePath,
                    scanOpts,
                    handleScanStep,
                    (err, fileEntry, dupeEntries) => {
                        if (err) {
                            return nextFilePath(err);
                        }

                        //  new or dupe?
                        if (dupeEntries.length > 0) {
                            //  1:n dupes found
                            self.client.log.debug('Duplicate file(s) found', {
                                dupeEntries: dupeEntries,
                            });

                            results.dupes = results.dupes.concat(dupeEntries);
                        } else {
                            //  new one
                            results.newEntries.push(fileEntry);
                        }

                        return nextFilePath(null);
                    }
                );
            },
            err => {
                return cb(err, results);
            }
        );
    }

    cleanupTempFiles() {
        temptmp.cleanup(paths => {
            Log.debug(
                { paths: paths, sessionId: temptmp.sessionId },
                'Temporary files cleaned up'
            );
        });
    }

    moveAndPersistUploadsToDatabase(newEntries) {
        const areaStorageDir = getAreaDefaultStorageDirectory(this.areaInfo);
        const self = this;

        async.eachSeries(
            newEntries,
            (newEntry, nextEntry) => {
                const src = paths.join(self.tempRecvDirectory, newEntry.fileName);
                const dst = paths.join(areaStorageDir, newEntry.fileName);

                moveFileWithCollisionHandling(src, dst, (err, finalPath) => {
                    if (err) {
                        self.client.log.error('Failed moving physical upload file', {
                            error: err.message,
                            fileName: newEntry.fileName,
                            source: src,
                            dest: dst,
                        });
                        return nextEntry(null); //  still try next file
                    } else if (dst !== finalPath) {
                        //  name changed; adjust before persist
                        newEntry.fileName = paths.basename(finalPath);
                    }

                    self.client.log.debug('Moved upload to area', { path: finalPath });

                    //  persist to DB
                    newEntry.persist(err => {
                        if (err) {
                            self.client.log.error(
                                'Failed persisting upload to database',
                                { path: finalPath, error: err.message }
                            );
                        }

                        return nextEntry(null); //  still try next file
                    });
                });
            },
            () => {
                //
                //  Finally, we can remove any temp files that we may have created
                //
                self.cleanupTempFiles();
            }
        );
    }

    prepDetailsForUpload(scanResults, cb) {
        async.eachSeries(
            scanResults.newEntries,
            (newEntry, nextEntry) => {
                newEntry.meta.upload_by_username = this.client.user.username;
                newEntry.meta.upload_by_user_id = this.client.user.userId;

                this.displayFileDetailsPageForUploadEntry(newEntry, (err, newValues) => {
                    if (err) {
                        return nextEntry(err);
                    }

                    if (!newEntry.descIsAnsi) {
                        newEntry.desc = _.trimEnd(newValues.shortDesc);
                    }

                    if (newValues.estYear.length > 0) {
                        newEntry.meta.est_release_year = newValues.estYear;
                    }

                    if (newValues.tags.length > 0) {
                        newEntry.setHashTags(newValues.tags);
                    }

                    return nextEntry(err);
                });
            },
            err => {
                delete this.fileDetailsCurrentEntrySubmitCallback;
                return cb(err, scanResults);
            }
        );
    }

    displayDupesPage(dupes, cb) {
        //
        //  If we have custom art to show, use it - else just dump basic info.
        //  Pause at the end in either case.
        //
        const self = this;

        async.waterfall(
            [
                function prepArtAndViewController(callback) {
                    self.prepViewControllerWithArt(
                        'dupes',
                        FormIds.dupes,
                        { clearScreen: true, trailingLF: false },
                        err => {
                            if (err) {
                                self.client.term.pipeWrite(
                                    '|00|07Duplicate upload(s) found:\n'
                                );
                                return callback(null, null);
                            }

                            const dupeListView = self.viewControllers.dupes.getView(
                                MciViewIds.dupes.dupeList
                            );
                            return callback(null, dupeListView);
                        }
                    );
                },
                function prepDupeObjects(dupeListView, callback) {
                    //  update dupe objects with additional info that can be used for formatString() and the like
                    async.each(
                        dupes,
                        (dupe, nextDupe) => {
                            FileEntry.loadBasicEntry(dupe.fileId, dupe, err => {
                                if (err) {
                                    return nextDupe(err);
                                }

                                const areaInfo = getFileAreaByTag(dupe.areaTag);
                                if (areaInfo) {
                                    dupe.areaName = areaInfo.name;
                                    dupe.areaDesc = areaInfo.desc;
                                }
                                return nextDupe(null);
                            });
                        },
                        err => {
                            return callback(err, dupeListView);
                        }
                    );
                },
                function populateDupeInfo(dupeListView, callback) {
                    const dupeInfoFormat =
                        self.menuConfig.config.dupeInfoFormat ||
                        '{fileName} @ {areaName}';

                    if (dupeListView) {
                        dupeListView.setItems(
                            dupes.map(dupe => stringFormat(dupeInfoFormat, dupe))
                        );
                        dupeListView.redraw();
                    } else {
                        dupes.forEach(dupe => {
                            self.client.term.pipeWrite(
                                `${stringFormat(dupeInfoFormat, dupe)}\n`
                            );
                        });
                    }

                    return callback(null);
                },
                function pause(callback) {
                    return self.pausePrompt(
                        { row: self.client.term.termHeight },
                        callback
                    );
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    processUploadedFiles() {
        //
        //  For each file uploaded, we need to process & gather information
        //
        const self = this;

        async.waterfall(
            [
                function prepNonBlind(callback) {
                    if (self.isBlindUpload()) {
                        return callback(null);
                    }

                    //
                    //  For non-blind uploads, batch is not supported, we expect a single file
                    //  in |recvFilePaths|. If not, it's an error (we don't want to process the wrong thing)
                    //
                    if (self.recvFilePaths.length > 1) {
                        self.client.log.warn(
                            { recvFilePaths: self.recvFilePaths },
                            'Non-blind upload received 2:n files'
                        );
                        return callback(
                            Errors.UnexpectedState(
                                `Non-blind upload expected single file but got received ${self.recvFilePaths.length}`
                            )
                        );
                    }

                    return callback(null);
                },
                function scan(callback) {
                    return self.scanFiles(callback);
                },
                function pause(scanResults, callback) {
                    if (self.hasProcessingArt) {
                        self.client.term.rawWrite(
                            ansiGoto(self.client.term.termHeight, 1)
                        );
                    } else {
                        self.client.term.write('\n');
                    }

                    self.pausePrompt(() => {
                        return callback(null, scanResults);
                    });
                },
                function displayDupes(scanResults, callback) {
                    if (0 === scanResults.dupes.length) {
                        return callback(null, scanResults);
                    }

                    return self.displayDupesPage(scanResults.dupes, () => {
                        return callback(null, scanResults);
                    });
                },
                function prepDetails(scanResults, callback) {
                    return self.prepDetailsForUpload(scanResults, callback);
                },
                function startMovingAndPersistingToDatabase(scanResults, callback) {
                    //
                    //  *Start* the process of moving files from their current |tempRecvDirectory|
                    //  locations -> their final area destinations. Don't make the user wait
                    //  here as I/O can take quite a bit of time. Log any failures.
                    //
                    self.moveAndPersistUploadsToDatabase(scanResults.newEntries);
                    return callback(null, scanResults.newEntries);
                },
                function sendEvent(uploadedEntries, callback) {
                    Events.emit(Events.getSystemEvents().UserUpload, {
                        user: self.client.user,
                        files: uploadedEntries,
                    });
                    return callback(null);
                },
            ],
            err => {
                if (err) {
                    self.client.log.warn('File upload error encountered', {
                        error: err.message,
                    });
                    self.cleanupTempFiles(); //  normally called after moveAndPersistUploadsToDatabase() is completed.
                }

                return self.prevMenu();
            }
        );
    }

    displayOptionsPage(cb) {
        const self = this;

        async.series(
            [
                function prepArtAndViewController(callback) {
                    return self.prepViewControllerWithArt(
                        'options',
                        FormIds.options,
                        { clearScreen: true, trailingLF: false },
                        callback
                    );
                },
                function populateViews(callback) {
                    const areaSelectView = self.viewControllers.options.getView(
                        MciViewIds.options.area
                    );
                    areaSelectView.setItems(
                        self.availAreas.map(areaInfo => areaInfo.name)
                    );

                    const uploadTypeView = self.viewControllers.options.getView(
                        MciViewIds.options.uploadType
                    );
                    const fileNameView = self.viewControllers.options.getView(
                        MciViewIds.options.fileName
                    );

                    const blindFileNameText =
                        self.menuConfig.config.blindFileNameText ||
                        '(blind - filename ignored)';

                    uploadTypeView.on('index update', idx => {
                        self.uploadType = 0 === idx ? 'blind' : 'non-blind';

                        if (self.isBlindUpload()) {
                            fileNameView.setText(blindFileNameText);
                            fileNameView.acceptsFocus = false;
                        } else {
                            fileNameView.clearText();
                            fileNameView.acceptsFocus = true;
                        }
                    });

                    //  sanatize filename for display when leaving the view
                    self.viewControllers.options.on('leave', prevView => {
                        if (prevView.id === MciViewIds.options.fileName) {
                            fileNameView.setText(
                                sanatizeFilename(fileNameView.getData())
                            );
                        }
                    });

                    self.uploadType = 'blind';
                    uploadTypeView.setFocusItemIndex(0); //  default to blind
                    fileNameView.setText(blindFileNameText);
                    areaSelectView.redraw();

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

    displayProcessingPage(cb) {
        return this.prepViewControllerWithArt(
            'processing',
            FormIds.processing,
            { clearScreen: true, trailingLF: false },
            err => {
                //  note: this art is not required
                this.hasProcessingArt = !err;

                return cb(null);
            }
        );
    }

    fileEntryHasDetectedDesc(fileEntry) {
        return fileEntry.desc && fileEntry.desc.length > 0;
    }

    displayFileDetailsPageForUploadEntry(fileEntry, cb) {
        const self = this;

        async.waterfall(
            [
                function prepArtAndViewController(callback) {
                    return self.prepViewControllerWithArt(
                        'fileDetails',
                        FormIds.fileDetails,
                        { clearScreen: true, trailingLF: false },
                        err => {
                            return callback(err);
                        }
                    );
                },
                function populateViews(callback) {
                    const descView = self.viewControllers.fileDetails.getView(
                        MciViewIds.fileDetails.desc
                    );
                    const tagsView = self.viewControllers.fileDetails.getView(
                        MciViewIds.fileDetails.tags
                    );
                    const yearView = self.viewControllers.fileDetails.getView(
                        MciViewIds.fileDetails.estYear
                    );

                    self.updateCustomViewTextsWithFilter(
                        'fileDetails',
                        MciViewIds.fileDetails.customRangeStart,
                        fileEntry
                    );

                    tagsView.setText(Array.from(fileEntry.hashTags).join(',')); //  :TODO: optional 'hashTagsSep' like file list/browse
                    yearView.setText(fileEntry.meta.est_release_year || '');

                    if (isAnsi(fileEntry.desc)) {
                        fileEntry.descIsAnsi = true;

                        return descView.setAnsi(
                            fileEntry.desc,
                            {
                                prepped: false,
                                forceLineTerm: true,
                            },
                            () => {
                                return callback(
                                    null,
                                    descView,
                                    'preview',
                                    MciViewIds.fileDetails.tags
                                );
                            }
                        );
                    } else {
                        const hasDesc = self.fileEntryHasDetectedDesc(fileEntry);
                        descView.setText(
                            hasDesc
                                ? fileEntry.desc
                                : getDescFromFileName(fileEntry.fileName),
                            { scrollMode: 'top' } //  override scroll mode; we want to be @ top
                        );
                        return callback(
                            null,
                            descView,
                            'edit',
                            hasDesc
                                ? MciViewIds.fileDetails.tags
                                : MciViewIds.fileDetails.desc
                        );
                    }
                },
                function finalizeViews(descView, descViewMode, focusId, callback) {
                    descView.setPropertyValue('mode', descViewMode);
                    descView.acceptsFocus = 'preview' === descViewMode ? false : true;
                    self.viewControllers.fileDetails.switchFocus(focusId);
                    return callback(null);
                },
            ],
            err => {
                //
                //  we only call |cb| here if there is an error
                //  else, wait for the current from to be submit - then call -
                //  this way we'll move on to the next file entry when ready
                //
                if (err) {
                    return cb(err);
                }

                self.fileDetailsCurrentEntrySubmitCallback = cb; //  stash for moduleMethods.fileDetailsContinue
            }
        );
    }
};
