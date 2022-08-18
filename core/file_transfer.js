/* jslint node: true */
'use strict';

//  enigma-bbs
const MenuModule = require('./menu_module.js').MenuModule;
const Config = require('./config.js').get;
const stringFormat = require('./string_format.js');
const Errors = require('./enig_error.js').Errors;
const DownloadQueue = require('./download_queue.js');
const StatLog = require('./stat_log.js');
const FileEntry = require('./file_entry.js');
const Log = require('./logger.js').log;
const Events = require('./events.js');
const UserProps = require('./user_property.js');
const SysProps = require('./system_property.js');

//  deps
const async = require('async');
const _ = require('lodash');
const pty = require('node-pty');
const temptmp = require('temptmp').createTrackedSession('transfer_file');
const paths = require('path');
const fs = require('graceful-fs');
const fse = require('fs-extra');

//  some consts
const SYSTEM_EOL = require('os').EOL;
const TEMP_SUFFIX = 'enigtf-'; //  temp CWD/etc.

/*
    Notes
    -----------------------------------------------------------------------------

    See core/config.js for external protocol configuration


    Resources
    -----------------------------------------------------------------------------

    ZModem
        * http://gallium.inria.fr/~doligez/zmodem/zmodem.txt
        * https://github.com/protomouse/synchronet/blob/master/src/sbbs3/zmodem.c

*/

exports.moduleInfo = {
    name: 'Transfer file',
    desc: 'Sends or receives a file(s)',
    author: 'NuSkooler',
};

exports.getModule = class TransferFileModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = this.menuConfig.config || {};

        //
        //  Most options can be set via extraArgs or config block
        //
        const config = Config();
        if (options.extraArgs) {
            if (options.extraArgs.protocol) {
                this.protocolConfig =
                    config.fileTransferProtocols[options.extraArgs.protocol];
            }

            if (options.extraArgs.direction) {
                this.direction = options.extraArgs.direction;
            }

            if (options.extraArgs.sendQueue) {
                this.sendQueue = options.extraArgs.sendQueue;
            }

            if (options.extraArgs.recvFileName) {
                this.recvFileName = options.extraArgs.recvFileName;
            }

            if (options.extraArgs.recvDirectory) {
                this.recvDirectory = options.extraArgs.recvDirectory;
            }
        } else {
            if (this.config.protocol) {
                this.protocolConfig = config.fileTransferProtocols[this.config.protocol];
            }

            if (this.config.direction) {
                this.direction = this.config.direction;
            }

            if (this.config.sendQueue) {
                this.sendQueue = this.config.sendQueue;
            }

            if (this.config.recvFileName) {
                this.recvFileName = this.config.recvFileName;
            }

            if (this.config.recvDirectory) {
                this.recvDirectory = this.config.recvDirectory;
            }
        }

        this.protocolConfig =
            this.protocolConfig || config.fileTransferProtocols.zmodem8kSz; //  try for *something*
        this.direction = this.direction || 'send';
        this.sendQueue = this.sendQueue || [];

        //  Ensure sendQueue is an array of objects that contain at least a 'path' member
        this.sendQueue = this.sendQueue.map(item => {
            if (_.isString(item)) {
                return { path: item };
            } else {
                return item;
            }
        });

        this.sentFileIds = [];
    }

    isSending() {
        return 'send' === this.direction;
    }

    restorePipeAfterExternalProc() {
        if (!this.pipeRestored) {
            this.pipeRestored = true;

            this.client.restoreDataHandler();
        }
    }

    sendFiles(cb) {
        //  assume *sending* can always batch
        //  :TODO: Look into this further
        const allFiles = this.sendQueue.map(f => f.path);
        this.executeExternalProtocolHandlerForSend(allFiles, err => {
            if (err) {
                this.client.log.warn(
                    { files: allFiles, error: err.message },
                    'Error sending file(s)'
                );
            } else {
                const sentFiles = [];
                this.sendQueue.forEach(f => {
                    f.sent = true;
                    sentFiles.push(f.path);
                });

                this.client.log.info(
                    { sentFiles: sentFiles },
                    `User "${this.client.user.username}" downloaded ${sentFiles.length} file(s)`
                );
            }
            return cb(err);
        });
    }

    /*
    sendFiles(cb) {
        //  :TODO: built in/native protocol support

        if(this.protocolConfig.external.supportsBatch) {
            const allFiles = this.sendQueue.map(f => f.path);
            this.executeExternalProtocolHandlerForSend(allFiles, err => {
                if(err) {
                    this.client.log.warn( { files : allFiles, error : err.message }, 'Error sending file(s)' );
                } else {
                    const sentFiles = [];
                    this.sendQueue.forEach(f => {
                        f.sent = true;
                        sentFiles.push(f.path);

                    });

                    this.client.log.info( { sentFiles : sentFiles }, `Successfully sent ${sentFiles.length} file(s)` );
                }
                return cb(err);
            });
        } else {
            //  :TODO: we need to prompt between entries such that users can prepare their clients
            async.eachSeries(this.sendQueue, (queueItem, next) => {
                this.executeExternalProtocolHandlerForSend(queueItem.path, err => {
                    if(err) {
                        this.client.log.warn( { file : queueItem.path, error : err.message }, 'Error sending file' );
                    } else {
                        queueItem.sent = true;

                        this.client.log.info( { sentFile : queueItem.path }, 'Successfully sent file' );
                    }
                    return next(err);
                });
            }, err => {
                return cb(err);
            });
        }
    }
    */

    moveFileWithCollisionHandling(src, dst, cb) {
        //
        //  Move |src| -> |dst| renaming to file(1).ext, file(2).ext, etc.
        //  in the case of collisions.
        //
        const dstPath = paths.dirname(dst);
        const dstFileExt = paths.extname(dst);
        const dstFileSuffix = paths.basename(dst, dstFileExt);

        let renameIndex = 0;
        let movedOk = false;
        let tryDstPath;

        async.until(
            callback => callback(null, movedOk), //  until moved OK
            cb => {
                if (0 === renameIndex) {
                    //  try originally supplied path first
                    tryDstPath = dst;
                } else {
                    tryDstPath = paths.join(
                        dstPath,
                        `${dstFileSuffix}(${renameIndex})${dstFileExt}`
                    );
                }

                fse.move(src, tryDstPath, err => {
                    if (err) {
                        if ('EEXIST' === err.code) {
                            renameIndex += 1;
                            return cb(null); //  keep trying
                        }

                        return cb(err);
                    }

                    movedOk = true;
                    return cb(null, tryDstPath);
                });
            },
            (err, finalPath) => {
                return cb(err, finalPath);
            }
        );
    }

    recvFiles(cb) {
        this.executeExternalProtocolHandlerForRecv(err => {
            if (err) {
                return cb(err);
            }

            this.recvFilePaths = [];

            if (this.recvFileName) {
                //
                //  file name specified - we expect a single file in |this.recvDirectory|
                //  by the name of |this.recvFileName|
                //
                const recvFullPath = paths.join(this.recvDirectory, this.recvFileName);
                fs.stat(recvFullPath, (err, stats) => {
                    if (err) {
                        return cb(err);
                    }

                    if (!stats.isFile()) {
                        return cb(
                            Errors.Invalid('Expected file entry in recv directory')
                        );
                    }

                    this.recvFilePaths.push(recvFullPath);
                    return cb(null);
                });
            } else {
                //
                //  Blind Upload (recv): files in |this.recvDirectory| should be named appropriately already
                //
                fs.readdir(this.recvDirectory, (err, files) => {
                    if (err) {
                        return cb(err);
                    }

                    //  stat each to grab files only
                    async.each(
                        files,
                        (fileName, nextFile) => {
                            const recvFullPath = paths.join(this.recvDirectory, fileName);

                            fs.stat(recvFullPath, (err, stats) => {
                                if (err) {
                                    this.client.log.warn('Failed to stat file', {
                                        path: recvFullPath,
                                    });
                                    return nextFile(null); //  just try the next one
                                }

                                if (stats.isFile()) {
                                    this.recvFilePaths.push(recvFullPath);
                                }

                                return nextFile(null);
                            });
                        },
                        () => {
                            return cb(null);
                        }
                    );
                });
            }
        });
    }

    pathWithTerminatingSeparator(path) {
        if (path && paths.sep !== path.charAt(path.length - 1)) {
            path = path + paths.sep;
        }
        return path;
    }

    prepAndBuildSendArgs(filePaths, cb) {
        const externalArgs = this.protocolConfig.external['sendArgs'];

        async.waterfall(
            [
                function getTempFileListPath(callback) {
                    const hasFileList = externalArgs.find(
                        ea => ea.indexOf('{fileListPath}') > -1
                    );
                    if (!hasFileList) {
                        return callback(null, null);
                    }

                    temptmp.open(
                        { prefix: TEMP_SUFFIX, suffix: '.txt' },
                        (err, tempFileInfo) => {
                            if (err) {
                                return callback(err); //  failed to create it
                            }

                            fs.write(tempFileInfo.fd, filePaths.join(SYSTEM_EOL), err => {
                                if (err) {
                                    return callback(err);
                                }
                                fs.close(tempFileInfo.fd, err => {
                                    return callback(err, tempFileInfo.path);
                                });
                            });
                        }
                    );
                },
                function createArgs(tempFileListPath, callback) {
                    //  initial args: ignore {filePaths} as we must break that into it's own sep array items
                    const args = externalArgs.map(arg => {
                        return '{filePaths}' === arg
                            ? arg
                            : stringFormat(arg, {
                                  fileListPath: tempFileListPath || '',
                              });
                    });

                    const filePathsPos = args.indexOf('{filePaths}');
                    if (filePathsPos > -1) {
                        //  replace {filePaths} with 0:n individual entries in |args|
                        args.splice.apply(args, [filePathsPos, 1].concat(filePaths));
                    }

                    return callback(null, args);
                },
            ],
            (err, args) => {
                return cb(err, args);
            }
        );
    }

    prepAndBuildRecvArgs(cb) {
        const argsKey = this.recvFileName ? 'recvArgsNonBatch' : 'recvArgs';
        const externalArgs = this.protocolConfig.external[argsKey];
        const args = externalArgs.map(arg =>
            stringFormat(arg, {
                uploadDir: this.recvDirectory,
                fileName: this.recvFileName || '',
            })
        );

        return cb(null, args);
    }

    executeExternalProtocolHandler(args, cb) {
        const external = this.protocolConfig.external;
        const cmd = external[`${this.direction}Cmd`];

        //  support for handlers that need IACs taken care of over Telnet/etc.
        const processIACs = external.processIACs || external.escapeTelnet; //  deprecated name

        //  :TODO: we should only do this when over Telnet (or derived, such as WebSockets)?

        const IAC = Buffer.from([255]);
        const EscapedIAC = Buffer.from([255, 255]);

        this.client.log.debug(
            {
                cmd: cmd,
                args: args,
                tempDir: this.recvDirectory,
                direction: this.direction,
            },
            'Executing external protocol'
        );

        const spawnOpts = {
            cols: this.client.term.termWidth,
            rows: this.client.term.termHeight,
            cwd: this.recvDirectory,
            encoding: null, //  don't bork our data!
        };

        const externalProc = pty.spawn(cmd, args, spawnOpts);

        let dataHits = 0;
        const updateActivity = () => {
            if (0 === dataHits++ % 4) {
                this.client.explicitActivityTimeUpdate();
            }
        };

        this.client.setTemporaryDirectDataHandler(data => {
            updateActivity();

            //  needed for things like sz/rz
            if (processIACs) {
                let iacPos = data.indexOf(EscapedIAC);
                if (-1 === iacPos) {
                    return externalProc.write(data);
                }

                //  at least one double (escaped) IAC
                let lastPos = 0;
                while (iacPos > -1) {
                    let rem = iacPos - lastPos;
                    if (rem >= 0) {
                        externalProc.write(data.slice(lastPos, iacPos + 1));
                    }
                    lastPos = iacPos + 2;
                    iacPos = data.indexOf(EscapedIAC, lastPos);
                }

                if (lastPos < data.length) {
                    externalProc.write(data.slice(lastPos));
                }
                // const tmp = data.toString('binary').replace(/\xff{2}/g, '\xff');    //  de-escape
                // externalProc.write(Buffer.from(tmp, 'binary'));
            } else {
                externalProc.write(data);
            }
        });

        externalProc.onData(data => {
            updateActivity();

            //  needed for things like sz/rz
            if (processIACs) {
                let iacPos = data.indexOf(IAC);
                if (-1 === iacPos) {
                    return this.client.term.rawWrite(data);
                }

                //  Has at least a single IAC
                let lastPos = 0;
                while (iacPos !== -1) {
                    if (iacPos - lastPos > 0) {
                        this.client.term.rawWrite(data.slice(lastPos, iacPos));
                    }
                    this.client.term.rawWrite(EscapedIAC);
                    lastPos = iacPos + 1;
                    iacPos = data.indexOf(IAC, lastPos);
                }

                if (lastPos < data.length) {
                    this.client.term.rawWrite(data.slice(lastPos));
                }
            } else {
                this.client.term.rawWrite(data);
            }
        });

        externalProc.once('close', () => {
            return this.restorePipeAfterExternalProc();
        });

        externalProc.once('exit', exitCode => {
            this.client.log.debug(
                { cmd: cmd, args: args, exitCode: exitCode },
                'Process exited'
            );

            this.restorePipeAfterExternalProc();
            externalProc.removeAllListeners();

            return cb(
                exitCode
                    ? Errors.ExternalProcess(
                          `Process exited with exit code ${exitCode}`,
                          'EBADEXIT'
                      )
                    : null
            );
        });
    }

    executeExternalProtocolHandlerForSend(filePaths, cb) {
        if (!Array.isArray(filePaths)) {
            filePaths = [filePaths];
        }

        this.prepAndBuildSendArgs(filePaths, (err, args) => {
            if (err) {
                return cb(err);
            }

            this.executeExternalProtocolHandler(args, err => {
                return cb(err);
            });
        });
    }

    executeExternalProtocolHandlerForRecv(cb) {
        this.prepAndBuildRecvArgs((err, args) => {
            if (err) {
                return cb(err);
            }

            this.executeExternalProtocolHandler(args, err => {
                return cb(err);
            });
        });
    }

    getMenuResult() {
        if (this.isSending()) {
            return { sentFileIds: this.sentFileIds };
        } else {
            return { recvFilePaths: this.recvFilePaths };
        }
    }

    updateSendStats(cb) {
        let downloadBytes = 0;
        let downloadCount = 0;
        let fileIds = [];

        async.each(
            this.sendQueue,
            (queueItem, next) => {
                if (!queueItem.sent) {
                    return next(null);
                }

                if (queueItem.fileId) {
                    fileIds.push(queueItem.fileId);
                }

                if (_.isNumber(queueItem.byteSize)) {
                    downloadCount += 1;
                    downloadBytes += queueItem.byteSize;
                    return next(null);
                }

                //  we just have a path - figure it out
                fs.stat(queueItem.path, (err, stats) => {
                    if (err) {
                        this.client.log.warn(
                            { error: err.message, path: queueItem.path },
                            'File stat failed'
                        );
                    } else {
                        downloadCount += 1;
                        downloadBytes += stats.size;
                    }

                    return next(null);
                });
            },
            () => {
                //  All stats/meta currently updated via fire & forget - if this is ever a issue, we can wait for callbacks
                StatLog.incrementUserStat(
                    this.client.user,
                    UserProps.FileDlTotalCount,
                    downloadCount
                );
                StatLog.incrementUserStat(
                    this.client.user,
                    UserProps.FileDlTotalBytes,
                    downloadBytes
                );

                StatLog.incrementSystemStat(SysProps.FileDlTotalCount, downloadCount);
                StatLog.incrementSystemStat(SysProps.FileDlTotalBytes, downloadBytes);

                fileIds.forEach(fileId => {
                    FileEntry.incrementAndPersistMetaValue(fileId, 'dl_count', 1);
                });

                return cb(null);
            }
        );
    }

    updateRecvStats(cb) {
        let uploadBytes = 0;
        let uploadCount = 0;

        async.each(
            this.recvFilePaths,
            (filePath, next) => {
                //  we just have a path - figure it out
                fs.stat(filePath, (err, stats) => {
                    if (err) {
                        this.client.log.warn(
                            { error: err.message, path: filePath },
                            'File stat failed'
                        );
                    } else {
                        uploadCount += 1;
                        uploadBytes += stats.size;
                    }

                    return next(null);
                });
            },
            () => {
                StatLog.incrementUserStat(
                    this.client.user,
                    UserProps.FileUlTotalCount,
                    uploadCount
                );
                StatLog.incrementUserStat(
                    this.client.user,
                    UserProps.FileUlTotalBytes,
                    uploadBytes
                );

                StatLog.incrementSystemStat(SysProps.FileUlTotalCount, uploadCount);
                StatLog.incrementSystemStat(SysProps.FileUlTotalBytes, uploadBytes);

                return cb(null);
            }
        );
    }

    initSequence() {
        const self = this;

        //  :TODO: break this up to send|recv

        async.series(
            [
                function validateConfig(callback) {
                    if (self.isSending()) {
                        if (!Array.isArray(self.sendQueue)) {
                            self.sendQueue = [self.sendQueue];
                        }
                    }

                    return callback(null);
                },
                function transferFiles(callback) {
                    if (self.isSending()) {
                        self.sendFiles(err => {
                            if (err) {
                                return callback(err);
                            }

                            const sentFileIds = [];
                            self.sendQueue.forEach(queueItem => {
                                if (queueItem.sent && queueItem.fileId) {
                                    sentFileIds.push(queueItem.fileId);
                                }
                            });

                            if (sentFileIds.length > 0) {
                                //  remove items we sent from the D/L queue
                                const dlQueue = new DownloadQueue(self.client);
                                const dlFileEntries = dlQueue.removeItems(sentFileIds);

                                //  fire event for downloaded entries
                                Events.emit(Events.getSystemEvents().UserDownload, {
                                    user: self.client.user,
                                    files: dlFileEntries,
                                });

                                self.sentFileIds = sentFileIds;
                            }

                            return callback(null);
                        });
                    } else {
                        self.recvFiles(err => {
                            return callback(err);
                        });
                    }
                },
                function cleanupTempFiles(callback) {
                    temptmp.cleanup(paths => {
                        Log.debug(
                            { paths: paths, sessionId: temptmp.sessionId },
                            'Temporary files cleaned up'
                        );
                    });

                    return callback(null);
                },
                function updateUserAndSystemStats(callback) {
                    if (self.isSending()) {
                        return self.updateSendStats(callback);
                    } else {
                        return self.updateRecvStats(callback);
                    }
                },
            ],
            err => {
                if (err) {
                    self.client.log.warn({ error: err.message }, 'File transfer error');
                }

                return self.prevMenu();
            }
        );
    }
};
