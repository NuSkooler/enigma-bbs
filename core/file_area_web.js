/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const FileDb = require('./database.js').dbs.file;
const getISOTimestampString = require('./database.js').getISOTimestampString;
const FileEntry = require('./file_entry.js');
const getServer = require('./listening_server.js').getServer;
const Errors = require('./enig_error.js').Errors;
const ErrNotEnabled = require('./enig_error.js').ErrorReasons.NotEnabled;
const StatLog = require('./stat_log.js');
const User = require('./user.js');
const Log = require('./logger.js').log;
const getConnectionByUserId = require('./client_connections.js').getConnectionByUserId;
const webServerPackageName = require('./servers/content/web.js').moduleInfo.packageName;
const Events = require('./events.js');
const UserProps = require('./user_property.js');
const SysProps = require('./system_menu_method.js');

//  deps
const hashids = require('hashids/cjs');
const moment = require('moment');
const paths = require('path');
const async = require('async');
const fs = require('graceful-fs');
const mimeTypes = require('mime-types');
const yazl = require('yazl');

function notEnabledError() {
    return Errors.General('Web server is not enabled', ErrNotEnabled);
}

class FileAreaWebAccess {
    constructor() {
        this.hashids = new hashids(Config().general.boardName);
        this.expireTimers = {}; //  hashId->timer
    }

    startup(cb) {
        const self = this;

        async.series(
            [
                function initFromDb(callback) {
                    return self.load(callback);
                },
                function addWebRoute(callback) {
                    self.webServer = getServer(webServerPackageName);
                    if (!self.webServer) {
                        return callback(
                            Errors.DoesNotExist(
                                `Server with package name "${webServerPackageName}" does not exist`
                            )
                        );
                    }

                    if (self.isEnabled()) {
                        const routeAdded = self.webServer.instance.addRoute({
                            method: 'GET',
                            path: Config().fileBase.web.routePath,
                            handler: self.routeWebRequest.bind(self),
                        });
                        return callback(
                            routeAdded ? null : Errors.General('Failed adding route')
                        );
                    } else {
                        return callback(null); //  not enabled, but no error
                    }
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    shutdown(cb) {
        return cb(null);
    }

    isEnabled() {
        return this.webServer.instance.isEnabled();
    }

    static getHashIdTypes() {
        return {
            SingleFile: 0,
            BatchArchive: 1,
        };
    }

    load(cb) {
        //
        //  Load entries, register expiration timers
        //
        FileDb.each(
            `SELECT hash_id, expire_timestamp
            FROM file_web_serve;`,
            (err, row) => {
                if (row) {
                    this.scheduleExpire(row.hash_id, moment(row.expire_timestamp));
                }
            },
            err => {
                return cb(err);
            }
        );
    }

    removeEntry(hashId) {
        //
        //  Delete record from DB, and our timer
        //
        FileDb.run(
            `DELETE FROM file_web_serve
            WHERE hash_id = ?;`,
            [hashId]
        );

        delete this.expireTimers[hashId];
    }

    scheduleExpire(hashId, expireTime) {
        //  remove any previous entry for this hashId
        const previous = this.expireTimers[hashId];
        if (previous) {
            clearTimeout(previous);
            delete this.expireTimers[hashId];
        }

        const timeoutMs = expireTime.diff(moment());

        if (timeoutMs <= 0) {
            setImmediate(() => {
                this.removeEntry(hashId);
            });
        } else {
            this.expireTimers[hashId] = setTimeout(() => {
                this.removeEntry(hashId);
            }, timeoutMs);
        }
    }

    loadServedHashId(hashId, cb) {
        FileDb.get(
            `SELECT expire_timestamp FROM
            file_web_serve
            WHERE hash_id = ?`,
            [hashId],
            (err, result) => {
                if (err || !result) {
                    return cb(
                        err ? err : Errors.DoesNotExist('Invalid or missing hash ID')
                    );
                }

                const decoded = this.hashids.decode(hashId);

                //  decode() should provide an array of [ userId, hashIdType, id, ... ]
                if (!Array.isArray(decoded) || decoded.length < 3) {
                    return cb(Errors.Invalid('Invalid or unknown hash ID'));
                }

                const servedItem = {
                    hashId: hashId,
                    userId: decoded[0],
                    hashIdType: decoded[1],
                    expireTimestamp: moment(result.expire_timestamp),
                };

                if (
                    FileAreaWebAccess.getHashIdTypes().SingleFile ===
                    servedItem.hashIdType
                ) {
                    servedItem.fileIds = decoded.slice(2);
                }

                return cb(null, servedItem);
            }
        );
    }

    getSingleFileHashId(client, fileEntry) {
        return this.getHashId(client, FileAreaWebAccess.getHashIdTypes().SingleFile, [
            fileEntry.fileId,
        ]);
    }

    getBatchArchiveHashId(client, batchId) {
        return this.getHashId(
            client,
            FileAreaWebAccess.getHashIdTypes().BatchArchive,
            batchId
        );
    }

    getHashId(client, hashIdType, identifier) {
        return this.hashids.encode(client.user.userId, hashIdType, identifier);
    }

    buildSingleFileTempDownloadLink(client, fileEntry, hashId) {
        hashId = hashId || this.getSingleFileHashId(client, fileEntry);

        return this.webServer.instance.buildUrl(`${Config().fileBase.web.path}${hashId}`);
    }

    buildBatchArchiveTempDownloadLink(client, hashId) {
        return this.webServer.instance.buildUrl(`${Config().fileBase.web.path}${hashId}`);
    }

    getExistingTempDownloadServeItem(client, fileEntry, cb) {
        if (!this.isEnabled()) {
            return cb(notEnabledError());
        }

        const hashId = this.getSingleFileHashId(client, fileEntry);
        this.loadServedHashId(hashId, (err, servedItem) => {
            if (err) {
                return cb(err);
            }

            servedItem.url = this.buildSingleFileTempDownloadLink(client, fileEntry);

            return cb(null, servedItem);
        });
    }

    _addOrUpdateHashIdRecord(dbOrTrans, hashId, expireTime, cb) {
        //  add/update rec with hash id and (latest) timestamp
        dbOrTrans.run(
            `REPLACE INTO file_web_serve (hash_id, expire_timestamp)
            VALUES (?, ?);`,
            [hashId, getISOTimestampString(expireTime)],
            err => {
                if (err) {
                    return cb(err);
                }

                this.scheduleExpire(hashId, expireTime);

                return cb(null);
            }
        );
    }

    createAndServeTempDownload(client, fileEntry, options, cb) {
        if (!this.isEnabled()) {
            return cb(notEnabledError());
        }

        const hashId = this.getSingleFileHashId(client, fileEntry);
        const url = this.buildSingleFileTempDownloadLink(client, fileEntry, hashId);
        options.expireTime = options.expireTime || moment().add(2, 'days');

        this._addOrUpdateHashIdRecord(FileDb, hashId, options.expireTime, err => {
            return cb(err, url);
        });
    }

    createAndServeTempBatchDownload(client, fileEntries, options, cb) {
        if (!this.isEnabled()) {
            return cb(notEnabledError());
        }

        const batchId = moment().utc().unix();
        const hashId = this.getBatchArchiveHashId(client, batchId);
        const url = this.buildBatchArchiveTempDownloadLink(client, hashId);
        options.expireTime = options.expireTime || moment().add(2, 'days');

        FileDb.beginTransaction((err, trans) => {
            if (err) {
                return cb(err);
            }

            this._addOrUpdateHashIdRecord(trans, hashId, options.expireTime, err => {
                if (err) {
                    return trans.rollback(() => {
                        return cb(err);
                    });
                }

                async.eachSeries(
                    fileEntries,
                    (entry, nextEntry) => {
                        trans.run(
                            `INSERT INTO file_web_serve_batch (hash_id, file_id)
                        VALUES (?, ?);`,
                            [hashId, entry.fileId],
                            err => {
                                return nextEntry(err);
                            }
                        );
                    },
                    err => {
                        trans[err ? 'rollback' : 'commit'](() => {
                            return cb(err, url);
                        });
                    }
                );
            });
        });
    }

    fileNotFound(resp) {
        return this.webServer.instance.fileNotFound(resp);
    }

    routeWebRequest(req, resp) {
        const hashId = paths.basename(req.url);

        Log.debug({ hashId: hashId, url: req.url }, 'File area web request');

        this.loadServedHashId(hashId, (err, servedItem) => {
            if (err) {
                return this.fileNotFound(resp);
            }

            const hashIdTypes = FileAreaWebAccess.getHashIdTypes();
            switch (servedItem.hashIdType) {
                case hashIdTypes.SingleFile:
                    return this.routeWebRequestForSingleFile(servedItem, req, resp);

                case hashIdTypes.BatchArchive:
                    return this.routeWebRequestForBatchArchive(servedItem, req, resp);

                default:
                    return this.fileNotFound(resp);
            }
        });
    }

    routeWebRequestForSingleFile(servedItem, req, resp) {
        Log.debug({ servedItem: servedItem }, 'Single file web request');

        const fileEntry = new FileEntry();

        servedItem.fileId = servedItem.fileIds[0];

        fileEntry.load(servedItem.fileId, err => {
            if (err) {
                return this.fileNotFound(resp);
            }

            const filePath = fileEntry.filePath;
            if (!filePath) {
                return this.fileNotFound(resp);
            }

            fs.stat(filePath, (err, stats) => {
                if (err) {
                    return this.fileNotFound(resp);
                }

                resp.on('close', () => {
                    //  connection closed *before* the response was fully sent
                    //  :TODO: Log and such
                });

                resp.on('finish', () => {
                    //  transfer completed fully
                    this.updateDownloadStatsForUserIdAndSystem(
                        servedItem.userId,
                        stats.size,
                        [fileEntry]
                    );
                });

                const headers = {
                    'Content-Type':
                        mimeTypes.contentType(filePath) || mimeTypes.contentType('.bin'),
                    'Content-Length': stats.size,
                    'Content-Disposition': `attachment; filename="${fileEntry.fileName}"`,
                };

                const readStream = fs.createReadStream(filePath);
                resp.writeHead(200, headers);
                return readStream.pipe(resp);
            });
        });
    }

    routeWebRequestForBatchArchive(servedItem, req, resp) {
        Log.debug({ servedItem: servedItem }, 'Batch file web request');

        //
        //  We are going to build an on-the-fly zip file stream of 1:n
        //  files in the batch.
        //
        //  First, collect all file IDs
        //
        const self = this;

        async.waterfall(
            [
                function fetchFileIds(callback) {
                    FileDb.all(
                        `SELECT file_id
                        FROM file_web_serve_batch
                        WHERE hash_id = ?;`,
                        [servedItem.hashId],
                        (err, fileIdRows) => {
                            if (
                                err ||
                                !Array.isArray(fileIdRows) ||
                                0 === fileIdRows.length
                            ) {
                                return callback(
                                    Errors.DoesNotExist(
                                        'Could not get file IDs for batch'
                                    )
                                );
                            }

                            return callback(
                                null,
                                fileIdRows.map(r => r.file_id)
                            );
                        }
                    );
                },
                function loadFileEntries(fileIds, callback) {
                    async.map(
                        fileIds,
                        (fileId, nextFileId) => {
                            const fileEntry = new FileEntry();
                            fileEntry.load(fileId, err => {
                                return nextFileId(err, fileEntry);
                            });
                        },
                        (err, fileEntries) => {
                            if (err) {
                                return callback(
                                    Errors.DoesNotExist(
                                        'Could not load file IDs for batch'
                                    )
                                );
                            }

                            return callback(null, fileEntries);
                        }
                    );
                },
                function createAndServeStream(fileEntries, callback) {
                    const filePaths = fileEntries.map(fe => fe.filePath);
                    Log.trace(
                        { filePaths: filePaths },
                        'Creating zip archive for batch web request'
                    );

                    const zipFile = new yazl.ZipFile();

                    zipFile.on('error', err => {
                        Log.warn(
                            { error: err.message },
                            'Error adding file to batch web request archive'
                        );
                    });

                    filePaths.forEach(fp => {
                        zipFile.addFile(
                            fp, //  path to physical file
                            paths.basename(fp), //  filename/path *stored in archive*
                            {
                                compress: false, //  :TODO: do this smartly - if ext is in set = false, else true via isArchive() or such... mimeDB has this for us.
                            }
                        );
                    });

                    zipFile.end(finalZipSize => {
                        if (-1 === finalZipSize) {
                            return callback(
                                Errors.UnexpectedState('Unable to acquire final zip size')
                            );
                        }

                        resp.on('close', () => {
                            //  connection closed *before* the response was fully sent
                            //  :TODO: Log and such
                        });

                        resp.on('finish', () => {
                            //  transfer completed fully
                            self.updateDownloadStatsForUserIdAndSystem(
                                servedItem.userId,
                                finalZipSize,
                                fileEntries
                            );
                        });

                        const batchFileName = `batch_${servedItem.hashId}.zip`;

                        const headers = {
                            'Content-Type':
                                mimeTypes.contentType(batchFileName) ||
                                mimeTypes.contentType('.bin'),
                            'Content-Length': finalZipSize,
                            'Content-Disposition': `attachment; filename="${batchFileName}"`,
                        };

                        resp.writeHead(200, headers);
                        return zipFile.outputStream.pipe(resp);
                    });
                },
            ],
            err => {
                if (err) {
                    //  :TODO: Log me!
                    return this.fileNotFound(resp);
                }

                //  ...otherwise, we would have called resp() already.
            }
        );
    }

    updateDownloadStatsForUserIdAndSystem(userId, dlBytes, fileEntries) {
        async.waterfall([
            function fetchActiveUser(callback) {
                const clientForUserId = getConnectionByUserId(userId);
                if (clientForUserId) {
                    return callback(null, clientForUserId.user);
                }

                //  not online now - look 'em up
                User.getUser(userId, (err, assocUser) => {
                    return callback(err, assocUser);
                });
            },
            function updateStats(user, callback) {
                StatLog.incrementUserStat(user, UserProps.FileDlTotalCount, 1);
                StatLog.incrementUserStat(user, UserProps.FileDlTotalBytes, dlBytes);

                StatLog.incrementSystemStat(SysProps.FileDlTotalCount, 1);
                StatLog.incrementSystemStat(SysProps.FileDlTotalBytes, dlBytes);

                StatLog.incrementNonPersistentSystemStat(SysProps.FileDlTodayCount, 1);
                StatLog.incrementNonPersistentSystemStat(
                    SysProps.FileDlTodayBytes,
                    dlBytes
                );

                return callback(null, user);
            },
            function sendEvent(user, callback) {
                Events.emit(Events.getSystemEvents().UserDownload, {
                    user: user,
                    files: fileEntries,
                });
                return callback(null);
            },
        ]);
    }
}

module.exports = new FileAreaWebAccess();
