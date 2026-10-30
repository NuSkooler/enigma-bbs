/* jslint node: true */
'use strict';

//  enigma-bbs
const MenuModule = require('./menu_module.js').MenuModule;
//  Late bound as in dropfile.js and message_area.js: configModule.get is
//  replaced by the Config bootstrapper, so capturing it here would freeze
//  whichever getter was installed at require time.
const configModule = require('./config.js');
const Config = (...args) => configModule.get(...args);
const stringFormat = require('./string_format.js');
const Errors = require('./enig_error.js').Errors;
const DownloadQueue = require('./download_queue.js');
const StatLog = require('./stat_log.js');
const FileEntry = require('./file_entry.js');
const { moveFileWithCollisionHandling } = require('./file_util.js');
const Log = require('./logger.js').log;
const Events = require('./events.js');
const UserProps = require('./user_property.js');
const UserTime = require('./user_time.js');
const SysProps = require('./system_property.js');
const { TelnetSocket } = require('telnet-socket');
const {
    isTelnetBasedClient,
    escapeIacs,
    createIacDeEscaper,
    applyTransportFlags,
} = require('./telnet_iac.js');
const {
    hasControlChar,
    parseDszLog,
    receivedFilesFromEntries,
    confirmReceivedFiles,
    buildProtocolEnv,
} = require('./dszlog.js');

//  deps
const async = require('async');
const _ = require('lodash');
const pty = require('node-pty');
const TempTmp = require('temptmp');
const paths = require('path');
const fs = require('graceful-fs');
const crypto = require('crypto');

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
        //  Most options can be set via extraArgs or the config block. Each key
        //  is resolved on its own: extraArgs wins when it defines that key,
        //  otherwise the config block applies. (extraArgs are routinely
        //  unrelated -- e.g. { command: 'D' } from a menu prompt -- or partial.)
        //
        const config = Config();
        const extraArgs = options.extraArgs || {};
        const pick = key => (_.isNil(extraArgs[key]) ? this.config[key] : extraArgs[key]);

        const protocol = pick('protocol');
        if (protocol) {
            this.protocolConfig = config.fileTransferProtocols[protocol];
        }

        this.direction = pick('direction');
        this.sendQueue = pick('sendQueue');
        this.recvFileName = pick('recvFileName');
        this.recvDirectory = pick('recvDirectory');

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

        //
        //  This transfer's own temp files. temptmp tracks paths by session
        //  ID, and cleanup() removes every path under that ID -- so a shared
        //  ID would have whichever transfer finishes first delete the others'
        //  temp files while they are still in use.
        //
        this.temptmp = TempTmp.createTrackedSession(
            `transfer_file_${crypto.randomUUID()}`
        );
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
        //  Delegate to the shared util — same collision-rename semantics,
        //  but routes through safeMoveFile so CIFS/SMB targets that fail
        //  utimens with EPERM still get the file delivered via stream copy.
        return moveFileWithCollisionHandling(src, dst, cb);
    }

    recvFiles(cb) {
        this.executeExternalProtocolHandlerForRecv((err, exitInfo, dszLogText) => {
            if (err) {
                return this.salvageReceivedFiles(err, exitInfo, dszLogText, cb);
            }

            if (_.isString(dszLogText)) {
                this.client.log.debug(
                    { dszLog: parseDszLog(dszLogText) },
                    'Protocol DSZLOG after a clean exit'
                );
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

    //
    //  The protocol program exited non-zero. That covers the whole session,
    //  not each file: a sender that botches the end of a batch -- VTX's YModem
    //  sends CAN where the end-of-batch block belongs (#914) -- fails the run
    //  after every file has been received and saved. If the protocol wrote a
    //  DSZLOG, keep the files it confirms, and only those: anything else in
    //  |recvDirectory| may be a partial file. See core/dszlog.js.
    //
    //  The names in the log are the sender's, written unescaped, so a name
    //  with a newline in it can forge a line. Nothing is kept from a log with
    //  a line that does not parse, or from a receive directory holding a name
    //  with a control character in it.
    //
    salvageReceivedFiles(err, exitInfo, dszLogText, cb) {
        if (!_.isString(dszLogText) || 'EBADEXIT' !== err.reasonCode) {
            return cb(err);
        }

        const logInfo = {
            cmd: exitInfo && exitInfo.cmd,
            exitCode: exitInfo && exitInfo.exitCode,
        };

        const { entries, malformed } = parseDszLog(dszLogText);
        if (malformed.length > 0) {
            this.client.log.warn(
                Object.assign(logInfo, { malformed }),
                'Protocol failed and its DSZLOG has lines that do not parse; not trusting it'
            );
            return cb(err);
        }

        fs.readdir(this.recvDirectory, (readErr, dirNames) => {
            if (readErr) {
                this.client.log.warn(
                    Object.assign(logInfo, { error: readErr.message }),
                    'Protocol failed and its receive directory cannot be read'
                );
                return cb(err);
            }

            const suspectNames = dirNames.filter(hasControlChar);
            if (suspectNames.length > 0) {
                this.client.log.warn(
                    Object.assign(logInfo, { suspectNames }),
                    'Protocol failed and a received file name has control characters; not trusting its DSZLOG'
                );
                return cb(err);
            }

            const { received, rejected } = receivedFilesFromEntries(
                entries,
                this.recvDirectory
            );

            //  non-batch: the one file we asked for, or nothing
            let candidates = received;
            if (this.recvFileName) {
                const expectedPath = paths.resolve(this.recvDirectory, this.recvFileName);
                candidates = received.filter(c => c.path === expectedPath);
            }

            confirmReceivedFiles(candidates, (_err, result) => {
                logInfo.notConfirmed = rejected.concat(result.rejected);

                if (0 === result.confirmed.length) {
                    this.client.log.warn(
                        Object.assign(logInfo, { dszLog: entries }),
                        'Protocol failed and its DSZLOG confirms no received files'
                    );
                    return cb(err);
                }

                this.recvFilePaths = result.confirmed;

                this.client.log.warn(
                    Object.assign(logInfo, { files: result.confirmed }),
                    `Protocol exited with code ${logInfo.exitCode}, but its DSZLOG confirms ${result.confirmed.length} file(s) received; keeping them`
                );
                return cb(null);
            });
        });
    }

    //
    //  A per-transfer DSZLOG for protocols that declare |dszLog|. Its own
    //  tracked temptmp session, so it is removed as soon as it has been read.
    //  Calls back (null, { path, session }), or (null, null) if there is to
    //  be no log; failing to make one only costs the salvage, so it never
    //  fails the transfer.
    //
    createDszLog(cb) {
        if (!this.protocolConfig.external.dszLog) {
            return cb(null, null);
        }

        const session = TempTmp.createTrackedSession(
            `transfer_file_dszlog_${crypto.randomUUID()}`
        );
        session.open({ prefix: TEMP_SUFFIX, suffix: '.dszlog' }, (err, tempFileInfo) => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Failed to create DSZLOG; continuing without it'
                );
                session.cleanup();
                return cb(null, null);
            }

            fs.close(tempFileInfo.fd, () => {
                return cb(null, { path: tempFileInfo.path, session });
            });
        });
    }

    //  Read and remove a DSZLOG. Calls back with its text, or null.
    consumeDszLog(dszLog, cb) {
        if (!dszLog) {
            return cb(null);
        }

        fs.readFile(dszLog.path, 'utf8', (err, text) => {
            if (err) {
                this.client.log.warn(
                    { path: dszLog.path, error: err.message },
                    'Failed to read DSZLOG'
                );
            }

            dszLog.session.cleanup();
            return cb(err ? null : text);
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
        const temptmp = this.temptmp;

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

    //
    //  |options.env|: the environment for the protocol program; node-pty's
    //  default (process.env) if absent.
    //
    //  Calls back (err, { cmd, exitCode, signal }).
    //
    executeExternalProtocolHandler(args, options, cb) {
        if (!cb && 'function' === typeof options) {
            cb = options;
            options = {};
        }

        const external = this.protocolConfig.external;
        const cmd = external[`${this.direction}Cmd`];

        //  support for handlers that need IACs taken care of over Telnet/etc.
        const configProcessIACs = external.processIACs || external.escapeTelnet; //  deprecated name

        if (!this.client || typeof this.client !== 'object') {
            Log.warn('Invalid client object in file transfer');
            return cb(new Error('Invalid client object'));
        }

        //
        //  Only Telnet-based transports (Telnet, WebSocket) escape IACs; over SSH
        //  0xFF is ordinary data and touching it corrupts the stream. The transforms
        //  themselves live in telnet_iac.js so they can be unit tested -- nothing
        //  here is reachable from a test, since this method spawns a pty.
        //
        const isTelnetBased = isTelnetBasedClient(this.client);
        //  coerced: the SEXYZ protocols configure neither flag, and an undefined
        //  here drops the field out of the diagnostic log entirely rather than
        //  recording it as false
        const processIACs = !!(configProcessIACs && isTelnetBased);

        //
        //  Stateful by necessity: an escaped pair can straddle two chunks, and the
        //  de-escaper holds the undecided byte until the next one arrives. The
        //  previous inline version searched each chunk on its own and let split
        //  pairs through doubled, which is what broke large transfers.
        //
        const iacDeEscaper = processIACs ? createIacDeEscaper() : null;

        //
        //  Handlers that do their own Telnet framing -- sexyz -- take the
        //  transport from their arguments, and the shipped lists say `-telnet`
        //  for everyone. Correct it to match how this caller actually connected,
        //  or an SSH transfer never starts. See telnet_iac.js.
        //
        const originalArgs = args;
        args = applyTransportFlags(args, isTelnetBased);
        if (args !== originalArgs) {
            this.client.log.debug(
                { from: originalArgs, to: args, isTelnetBased },
                'Adjusted transfer protocol transport flag'
            );
        }

        this.client.log.debug(
            {
                cmd: cmd,
                args: args,
                tempDir: this.recvDirectory,
                direction: this.direction,
                processIACs: processIACs,
                isTelnetBased: isTelnetBased,
                clientType: this.client.constructor.name,
                hasTelnetSocket: this.client.socket instanceof TelnetSocket,
                hasBannerMethod: typeof this.client.banner === 'function',
            },
            'Executing external protocol'
        );

        const spawnOpts = {
            cols: this.client.term.termWidth,
            rows: this.client.term.termHeight,
            cwd: this.recvDirectory,
            encoding: null, //  don't bork our data!
        };

        if (options.env) {
            spawnOpts.env = options.env;
        }

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
            if (iacDeEscaper) {
                const deEscaped = iacDeEscaper.transform(data);
                if (deEscaped.length) {
                    externalProc.write(deEscaped);
                }
            } else {
                externalProc.write(data);
            }
        });

        externalProc.onData(data => {
            updateActivity();

            //  needed for things like sz/rz
            this.client.term.rawWrite(processIACs ? escapeIacs(data) : data);
        });

        externalProc.onExit(exitEvent => {
            const { exitCode, signal } = exitEvent;

            //
            //  A still-pending IAC means the client's stream ended mid-sequence: a
            //  lone 0xFF is either half of an escaped pair or the start of a
            //  command, so it is never a complete message on its own. The byte is
            //  of no use to a process that has already exited, but it is worth
            //  recording -- it points at a truncated transfer rather than a clean one.
            //
            if (iacDeEscaper && iacDeEscaper.hasPendingIac) {
                iacDeEscaper.flush();
                this.client.log.debug(
                    { cmd: cmd },
                    'Transfer stream ended on an incomplete IAC sequence'
                );
            }

            this.client.log.debug(
                { cmd: cmd, args: args, exitCode, signal },
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
                    : null,
                { cmd, exitCode, signal }
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

    //
    //  Calls back (err, exitInfo, dszLogText); |dszLogText| is null unless the
    //  protocol declares |dszLog| and its log could be read.
    //
    executeExternalProtocolHandlerForRecv(cb) {
        this.prepAndBuildRecvArgs((err, args) => {
            if (err) {
                return cb(err);
            }

            this.createDszLog((err, dszLog) => {
                const options = dszLog
                    ? { env: buildProtocolEnv(process.env, dszLog.path) }
                    : {};

                //
                //  A protocol program that cannot be spawned at all throws
                //  (node-pty). We are inside an async callback here, so a
                //  rethrow would skip the caller's try/catch -- and with it the
                //  free time release -- and land in the process-level handler.
                //  Hand it back as an ordinary transfer error instead, without
                //  the log left behind.
                //
                try {
                    this.executeExternalProtocolHandler(
                        args,
                        options,
                        (err, exitInfo) => {
                            this.consumeDszLog(dszLog, dszLogText => {
                                return cb(err, exitInfo, dszLogText);
                            });
                        }
                    );
                } catch (e) {
                    if (dszLog) {
                        dszLog.session.cleanup();
                    }
                    return cb(e);
                }
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

    //
    //  An upload costs the caller nothing from their daily time budget.
    //
    //  Every package in the prior art survey either makes uploads free or
    //  credits them back while charging downloads; Synchronet inverts its own
    //  flag name so that free is the default. The caller is doing the board a
    //  favour, and charging them for it is the one thing nobody does.
    //
    //  The depth is released on the error path too: leaving it raised would
    //  make the rest of the session free.
    //
    recvFilesFreeOfCharge(cb) {
        this.client.beginFreeTime();

        //
        //  Released exactly once, however recvFiles() ends -- including if it
        //  throws before it ever calls back, which it can:
        //  prepAndBuildRecvArgs() maps over protocolConfig.external.recvArgs
        //  or recvArgsNonBatch, and a protocol defines only the one it is
        //  capable of. The protocol *selector* filters on exactly that, so
        //  the normal upload path cannot pair them wrongly; a menu that sets
        //  |protocol| or |recvFileName| in config, bypassing the selector,
        //  can.
        //
        //  Cheap either way, and the consequence of getting it wrong is not:
        //  a depth left raised bills the rest of the session nothing.
        //
        //  Once, because a protocol handler that called back twice would
        //  otherwise release a free-time depth belonging to whatever wrapped
        //  this.
        //
        let released = false;
        const release = () => {
            if (!released) {
                released = true;
                this.client.endFreeTime();
            }
        };

        try {
            this.recvFiles(err => {
                release();
                return cb(err);
            });
        } catch (e) {
            release();
            throw e;
        }
    }

    //
    //  Total bytes queued for sending. Items from the download queue carry
    //  |byteSize|; anything else is a path we have to stat, the same
    //  fallback updateSendStats() uses.
    //
    sendQueueByteSize(cb) {
        let totalBytes = 0;

        async.each(
            this.sendQueue,
            (queueItem, next) => {
                if (_.isNumber(queueItem.byteSize)) {
                    totalBytes += queueItem.byteSize;
                    return next(null);
                }

                fs.stat(queueItem.path, (err, stats) => {
                    if (!err) {
                        totalBytes += stats.size;
                    }
                    return next(null);
                });
            },
            () => {
                return cb(totalBytes);
            }
        );
    }

    //
    //  Refuse a download the caller cannot finish in the time they have
    //  left today. Calls back with Errors.AccessDenied to abort, or null to
    //  proceed.
    //
    //  Forgiving by construction: an unlimited or exempt user is never
    //  checked, the assumed rate is optimistic so the estimate under-states
    //  the time, and a queue we cannot size at all goes through.
    //
    checkSendTimeRemaining(cb) {
        const timeLeft = UserTime.getTimeLeftMinutes(this.client);
        if (null === timeLeft) {
            return cb(null); //  nothing is metered for this user
        }

        const cps = parseInt(_.get(Config(), 'fileBase.estimatedTransferCps'), 10);
        if (isNaN(cps) || cps <= 0) {
            return cb(null); //  check disabled
        }

        this.sendQueueByteSize(totalBytes => {
            //  a queue we could not size at all comes back as 0 bytes, which
            //  costs 0 minutes and is therefore allowed -- deliberately
            const needMinutes = Math.ceil(totalBytes / cps / 60);
            if (needMinutes <= timeLeft) {
                return cb(null);
            }

            this.client.log.info(
                { totalBytes, needMinutes, timeLeft },
                'Not enough time remaining to start download'
            );

            this.client.term.write(
                `\nThis download needs about ${needMinutes} minute(s) and you have ${timeLeft}.\n` +
                    `Try again tomorrow, or download fewer files.\n`
            );

            return this.pausePrompt(() => {
                return cb(Errors.AccessDenied('Not enough time remaining to download'));
            });
        });
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

                StatLog.updateUserUlDlRatio(this.client.user);

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

                StatLog.updateUserUlDlRatio(this.client.user);

                StatLog.incrementSystemStat(SysProps.FileUlTotalCount, uploadCount);
                StatLog.incrementSystemStat(SysProps.FileUlTotalBytes, uploadBytes);

                return cb(null);
            }
        );
    }

    cleanupTempFiles() {
        this.temptmp.cleanup(paths => {
            Log.debug(
                { paths: paths, sessionId: this.temptmp.sessionId },
                'Temporary files cleaned up'
            );
        });
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
                function validateTimeRemaining(callback) {
                    //
                    //  Refuse to *start* a download the caller has no time to
                    //  finish, rather than letting the time-up kick sever it
                    //  mid-flight and leave them a partial file and nothing to
                    //  show for the minutes. PCBoard and Maximus both do this;
                    //  Wildcat!, which does not, documents the complaints.
                    //
                    //  Uploads are never checked: they do not cost time.
                    //
                    if (!self.isSending()) {
                        return callback(null);
                    }

                    return self.checkSendTimeRemaining(callback);
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
                        self.recvFilesFreeOfCharge(err => {
                            return callback(err);
                        });
                    }
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

                //  even when the transfer failed, so nothing is left behind
                self.cleanupTempFiles();

                return self.prevMenu();
            }
        );
    }
};
