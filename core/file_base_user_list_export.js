/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const FileEntry = require('./file_entry.js');
const FileArea = require('./file_base_area.js');
const { renderSubstr } = require('./string_util.js');
const { Errors } = require('./enig_error.js');
const DownloadQueue = require('./download_queue.js');
const { exportFileList } = require('./file_base_list_export.js');

//  deps
const _ = require('lodash');
const async = require('async');
const fs = require('graceful-fs');
const fse = require('fs-extra');
const paths = require('path');
const moment = require('moment');
const { v4: UUIDv4 } = require('uuid');
const yazl = require('yazl');

/*
    Module config block can contain the following:
    templateEncoding    - encoding of template files (utf8)
    tsFormat            - timestamp format (theme 'short')
    descWidth           - max desc width (45)
    progBarChar         - progress bar character (▒)
    compressThreshold   - threshold to kick in compression for lists (1.44 MiB)
    templates           - object containing:
        header          - filename of header template (misc/file_list_header.asc)
        entry           - filename of entry template (misc/file_list_entry.asc)

    Header template variables:
    nowTs, boardName, totalFileCount, totalFileSize,
    filterAreaTag, filterAreaName, filterAreaDesc,
    filterTerms, filterHashTags

    Entry template variables:
    fileId, areaName, areaDesc, userRating, fileName,
    fileSize, fileDesc, fileDescShort, fileSha256, fileCrc32,
    fileMd5, fileSha1, uploadBy, fileUploadTs, fileHashTags,
    currentFile, progress,
*/

exports.moduleInfo = {
    name: 'File Base List Export',
    desc: 'Exports file base listings for download',
    author: 'NuSkooler',
};

const FormIds = {
    main: 0,
};

const MciViewIds = {
    main: {
        status: 1,
        progressBar: 2,

        customRangeStart: 10,
    },
};

exports.getModule = class FileBaseListExport extends MenuModule {
    constructor(options) {
        super(options);
        this.config = Object.assign(
            {},
            _.get(options, 'menuConfig.config'),
            options.extraArgs
        );

        this.config.templateEncoding = this.config.templateEncoding || 'utf8';
        this.config.tsFormat =
            this.config.tsFormat ||
            this.client.currentTheme.helpers.getDateTimeFormat('short');
        this.config.descWidth = this.config.descWidth || 45; //  ie FILE_ID.DIZ
        this.config.progBarChar = renderSubstr(this.config.progBarChar || '▒', 0, 1);
        this.config.compressThreshold = this.config.compressThreshold || 1440000; //  >= 1.44M by default :)
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.series(
                [
                    callback =>
                        this.prepViewController(
                            'main',
                            FormIds.main,
                            mciData.menu,
                            callback
                        ),
                    callback => this.prepareList(callback),
                ],
                err => {
                    if (err) {
                        if ('NORESULTS' === err.reasonCode) {
                            return this.gotoMenu(
                                this.menuConfig.config.noResultsMenu ||
                                    'fileBaseExportListNoResults'
                            );
                        }

                        return this.prevMenu();
                    }
                    return cb(err);
                }
            );
        });
    }

    finishedLoading() {
        this.prevMenu();
    }

    prepareList(cb) {
        const self = this;

        const statusView = self.viewControllers.main.getView(MciViewIds.main.status);
        const updateStatus = status => {
            if (statusView) {
                statusView.setText(status);
            }
        };

        const progBarView = self.viewControllers.main.getView(
            MciViewIds.main.progressBar
        );
        const updateProgressBar = (curr, total) => {
            if (progBarView) {
                const prog = Math.floor((curr / total) * progBarView.dimens.width);
                progBarView.setText(self.config.progBarChar.repeat(prog));
            }
        };

        let cancel = false;

        const exportListProgress = (state, progNext) => {
            switch (state.step) {
                case 'preparing':
                case 'gathering':
                    updateStatus(state.status);
                    break;
                case 'file':
                    updateStatus(state.status);
                    updateProgressBar(state.current, state.total);
                    self.updateCustomViewTextsWithFilter(
                        'main',
                        MciViewIds.main.customRangeStart,
                        state.fileInfo
                    );
                    break;
                default:
                    break;
            }

            return progNext(cancel ? Errors.General('User canceled') : null);
        };

        const keyPressHandler = (ch, key) => {
            if ('escape' === key.name) {
                cancel = true;
                self.client.removeListener('key press', keyPressHandler);
            }
        };

        async.waterfall(
            [
                function buildList(callback) {
                    //  this may take quite a while; temp disable of idle monitor
                    self.client.stopIdleMonitor();

                    self.client.on('key press', keyPressHandler);

                    const filterCriteria = Object.assign({}, self.config.filterCriteria);
                    if (!filterCriteria.areaTag) {
                        filterCriteria.areaTag = FileArea.getAvailableFileAreaTags(
                            self.client
                        );
                    }

                    const opts = {
                        templateEncoding: self.config.templateEncoding,
                        headerTemplate: _.get(
                            self.config,
                            'templates.header',
                            'file_list_header.asc'
                        ),
                        entryTemplate: _.get(
                            self.config,
                            'templates.entry',
                            'file_list_entry.asc'
                        ),
                        tsFormat: self.config.tsFormat,
                        descWidth: self.config.descWidth,
                        progress: exportListProgress,
                    };

                    exportFileList(filterCriteria, opts, (err, listBody) => {
                        return callback(err, listBody);
                    });
                },
                function persistList(listBody, callback) {
                    updateStatus('Persisting list');

                    const sysTempDownloadArea = FileArea.getFileAreaByTag(
                        FileArea.WellKnownAreaTags.TempDownloads
                    );
                    const sysTempDownloadDir =
                        FileArea.getAreaDefaultStorageDirectory(sysTempDownloadArea);

                    fse.mkdirs(sysTempDownloadDir, err => {
                        if (err) {
                            return callback(err);
                        }

                        const outputFileName = paths.join(
                            sysTempDownloadDir,
                            `file_list_${UUIDv4().substr(-8)}_${moment().format(
                                'YYYY-MM-DD'
                            )}.txt`
                        );

                        fs.writeFile(outputFileName, listBody, 'utf8', err => {
                            if (err) {
                                return callback(err);
                            }

                            self.getSizeAndCompressIfMeetsSizeThreshold(
                                outputFileName,
                                (err, finalOutputFileName, fileSize) => {
                                    return callback(
                                        err,
                                        finalOutputFileName,
                                        fileSize,
                                        sysTempDownloadArea
                                    );
                                }
                            );
                        });
                    });
                },
                function persistFileEntry(
                    outputFileName,
                    fileSize,
                    sysTempDownloadArea,
                    callback
                ) {
                    const newEntry = new FileEntry({
                        areaTag: sysTempDownloadArea.areaTag,
                        fileName: paths.basename(outputFileName),
                        storageTag: sysTempDownloadArea.storageTags[0],
                        meta: {
                            upload_by_username: self.client.user.username,
                            upload_by_user_id: self.client.user.userId,
                            byte_size: fileSize,
                            session_temp_dl: 1, //  download is valid until session is over
                        },
                    });

                    newEntry.desc = 'File List Export';

                    newEntry.persist(err => {
                        if (!err) {
                            //  queue it!
                            DownloadQueue.get(self.client).addTemporaryDownload(newEntry);
                        }
                        return callback(err);
                    });
                },
                function done(callback) {
                    //  re-enable idle monitor
                    //  :TODO: this should probably be moved down below at the end of the full waterfall
                    self.client.startIdleMonitor();

                    updateStatus('Exported list has been added to your download queue');
                    return callback(null);
                },
            ],
            err => {
                self.client.removeListener('key press', keyPressHandler);
                return cb(err);
            }
        );
    }

    getSizeAndCompressIfMeetsSizeThreshold(filePath, cb) {
        fse.stat(filePath, (err, stats) => {
            if (err) {
                return cb(err);
            }

            if (stats.size < this.config.compressThreshold) {
                //  small enough, keep orig
                return cb(null, filePath, stats.size);
            }

            const zipFilePath = `${filePath}.zip`;

            const zipFile = new yazl.ZipFile();
            zipFile.addFile(filePath, paths.basename(filePath));
            zipFile.end(() => {
                const outZipFile = fs.createWriteStream(zipFilePath);
                zipFile.outputStream.pipe(outZipFile);
                zipFile.outputStream.on('finish', () => {
                    //  delete the original
                    fse.unlink(filePath, err => {
                        if (err) {
                            return cb(err);
                        }

                        //  finally stat the new output
                        fse.stat(zipFilePath, (err, stats) => {
                            return cb(err, zipFilePath, stats ? stats.size : 0);
                        });
                    });
                });
            });
        });
    }
};
