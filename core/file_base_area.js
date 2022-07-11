/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const Errors = require('./enig_error.js').Errors;
const sortAreasOrConfs = require('./conf_area_util.js').sortAreasOrConfs;
const FileEntry = require('./file_entry.js');
const FileDb = require('./database.js').dbs.file;
const ArchiveUtil = require('./archive_util.js');
const CRC32 = require('./crc.js').CRC32;
const Log = require('./logger.js').log;
const resolveMimeType = require('./mime_util.js').resolveMimeType;
const stringFormat = require('./string_format.js');
const wordWrapText = require('./word_wrap.js').wordWrapText;
const StatLog = require('./stat_log.js');
const UserProps = require('./user_property.js');
const SysProps = require('./system_property.js');
const SAUCE = require('./sauce.js');
const { wildcardMatch } = require('./string_util');

//  deps
const _ = require('lodash');
const async = require('async');
const fs = require('graceful-fs');
const crypto = require('crypto');
const paths = require('path');
const temptmp = require('temptmp').createTrackedSession('file_area');
const iconv = require('iconv-lite');
const execFile = require('child_process').execFile;
const moment = require('moment');

exports.startup = startup;
exports.isInternalArea = isInternalArea;
exports.getAvailableFileAreas = getAvailableFileAreas;
exports.getAvailableFileAreaTags = getAvailableFileAreaTags;
exports.getSortedAvailableFileAreas = getSortedAvailableFileAreas;
exports.isValidStorageTag = isValidStorageTag;
exports.getAreaStorageDirectoryByTag = getAreaStorageDirectoryByTag;
exports.getAreaDefaultStorageDirectory = getAreaDefaultStorageDirectory;
exports.getAreaStorageLocations = getAreaStorageLocations;
exports.getDefaultFileAreaTag = getDefaultFileAreaTag;
exports.getFileAreaByTag = getFileAreaByTag;
exports.getFileAreasByTagWildcardRule = getFileAreasByTagWildcardRule;
exports.getFileEntryPath = getFileEntryPath;
exports.changeFileAreaWithOptions = changeFileAreaWithOptions;
exports.scanFile = scanFile;
//exports.scanFileAreaForChanges          = scanFileAreaForChanges;
exports.getDescFromFileName = getDescFromFileName;
exports.getAreaStats = getAreaStats;
exports.cleanUpTempSessionItems = cleanUpTempSessionItems;

//  for scheduler:
exports.updateAreaStatsScheduledEvent = updateAreaStatsScheduledEvent;

const WellKnownAreaTags = (exports.WellKnownAreaTags = {
    Invalid: '',
    MessageAreaAttach: 'system_message_attachment',
    TempDownloads: 'system_temporary_download',
});

function startup(cb) {
    async.series(
        [
            callback => {
                return cleanUpTempSessionItems(callback);
            },
            callback => {
                getAreaStats((err, stats) => {
                    if (!err) {
                        StatLog.setNonPersistentSystemStat(
                            SysProps.FileBaseAreaStats,
                            stats
                        );
                    }

                    return callback(null);
                });
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function isInternalArea(areaTag) {
    return [
        WellKnownAreaTags.MessageAreaAttach,
        WellKnownAreaTags.TempDownloads,
    ].includes(areaTag);
}

function getAvailableFileAreas(client, options) {
    options = options || {};

    //  perform ACS check per conf & omit internal if desired
    const allAreas = _.map(Config().fileBase.areas, (areaInfo, areaTag) =>
        Object.assign(areaInfo, { areaTag: areaTag })
    );

    return _.omitBy(allAreas, areaInfo => {
        if (!options.includeSystemInternal && isInternalArea(areaInfo.areaTag)) {
            return true;
        }

        if (options.skipAcsCheck) {
            return false; //  no ACS checks (below)
        }

        if (options.writeAcs && !client.acs.hasFileAreaWrite(areaInfo)) {
            return true; //  omit
        }

        return !client.acs.hasFileAreaRead(areaInfo);
    });
}

function getAvailableFileAreaTags(client, options) {
    return _.map(getAvailableFileAreas(client, options), area => area.areaTag);
}

function getSortedAvailableFileAreas(client, options) {
    const areas = _.map(getAvailableFileAreas(client, options), v => v);
    sortAreasOrConfs(areas);
    return areas;
}

function getDefaultFileAreaTag(client, disableAcsCheck) {
    const config = Config();
    let defaultArea = _.findKey(config.fileBase, o => o.default);
    if (defaultArea) {
        const area = config.fileBase.areas[defaultArea];
        if (true === disableAcsCheck || client.acs.hasFileAreaRead(area)) {
            return defaultArea;
        }
    }

    //  just use anything we can
    defaultArea = _.findKey(config.fileBase.areas, (area, areaTag) => {
        return (
            WellKnownAreaTags.MessageAreaAttach !== areaTag &&
            (true === disableAcsCheck || client.acs.hasFileAreaRead(area))
        );
    });

    return defaultArea;
}

function getFileAreaByTag(areaTag) {
    const areaInfo = Config().fileBase.areas[areaTag];
    if (areaInfo) {
        //  normalize |hashTags|
        if (_.isString(areaInfo.hashTags)) {
            areaInfo.hashTags = areaInfo.hashTags.trim().split(',');
        }
        if (Array.isArray(areaInfo.hashTags)) {
            areaInfo.hashTags = new Set(areaInfo.hashTags.map(t => t.trim()));
        }
        areaInfo.areaTag = areaTag; //  convenience!
        areaInfo.storage = getAreaStorageLocations(areaInfo);
        return areaInfo;
    }
}

function getFileAreasByTagWildcardRule(rule) {
    const areaTags = Object.keys(Config().fileBase.areas).filter(areaTag => {
        return !isInternalArea(areaTag) && wildcardMatch(areaTag, rule);
    });

    return areaTags.map(areaTag => getFileAreaByTag(areaTag));
}

function changeFileAreaWithOptions(client, areaTag, options, cb) {
    async.waterfall(
        [
            function getArea(callback) {
                const area = getFileAreaByTag(areaTag);
                return callback(
                    area ? null : Errors.Invalid('Invalid file areaTag'),
                    area
                );
            },
            function validateAccess(area, callback) {
                if (!client.acs.hasFileAreaRead(area)) {
                    return callback(Errors.AccessDenied('No access to this area'));
                }
            },
            function changeArea(area, callback) {
                if (true === options.persist) {
                    client.user.persistProperty(UserProps.FileAreaTag, areaTag, err => {
                        return callback(err, area);
                    });
                } else {
                    client.user.properties[UserProps.FileAreaTag] = areaTag;
                    return callback(null, area);
                }
            },
        ],
        (err, area) => {
            if (!err) {
                client.log.info(
                    { areaTag: areaTag, area: area },
                    'Current file area changed'
                );
            } else {
                client.log.warn(
                    { areaTag: areaTag, area: area, error: err.message },
                    'Could not change file area'
                );
            }

            return cb(err);
        }
    );
}

function isValidStorageTag(storageTag) {
    return storageTag in Config().fileBase.storageTags;
}

function getAreaStorageDirectoryByTag(storageTag) {
    const config = Config();
    const storageLocation = storageTag && config.fileBase.storageTags[storageTag];

    return paths.resolve(config.fileBase.areaStoragePrefix, storageLocation || '');
}

function getAreaDefaultStorageDirectory(areaInfo) {
    return getAreaStorageDirectoryByTag(areaInfo.storageTags[0]);
}

function getAreaStorageLocations(areaInfo) {
    const storageTags = Array.isArray(areaInfo.storageTags)
        ? areaInfo.storageTags
        : [areaInfo.storageTags || ''];

    const avail = Config().fileBase.storageTags;

    return _.compact(
        storageTags.map(storageTag => {
            if (avail[storageTag]) {
                return {
                    storageTag: storageTag,
                    dir: getAreaStorageDirectoryByTag(storageTag),
                };
            }
        })
    );
}

function getFileEntryPath(fileEntry) {
    const areaInfo = getFileAreaByTag(fileEntry.areaTag);
    if (areaInfo) {
        return paths.join(areaInfo.storageDirectory, fileEntry.fileName);
    }
}

function getExistingFileEntriesBySha256(sha256, cb) {
    const entries = [];

    FileDb.each(
        `SELECT file_id, area_tag
        FROM file
        WHERE file_sha256=?;`,
        [sha256],
        (err, fileRow) => {
            if (fileRow) {
                entries.push({
                    fileId: fileRow.file_id,
                    areaTag: fileRow.area_tag,
                });
            }
        },
        err => {
            return cb(err, entries);
        }
    );
}

//  :TODO: This is basically sliceAtEOF() from art.js .... DRY!
function sliceAtSauceMarker(data) {
    let eof = data.length;
    const stopPos = Math.max(data.length - 256, 0); //  256 = 2 * sizeof(SAUCE)

    for (let i = eof - 1; i > stopPos; i--) {
        if (0x1a === data[i]) {
            eof = i;
            break;
        }
    }
    return data.slice(0, eof);
}

function attemptSetEstimatedReleaseDate(fileEntry) {
    //  :TODO: yearEstPatterns RegExp's should be cached - we can do this @ Config (re)load time
    const patterns = Config().fileBase.yearEstPatterns.map(p => new RegExp(p, 'gmi'));

    function getMatch(input) {
        if (input) {
            let m;
            for (let i = 0; i < patterns.length; ++i) {
                m = patterns[i].exec(input);
                if (m) {
                    return m;
                }
            }
        }
    }

    //
    //  We attempt detection in short -> long order
    //
    //  Throw out anything that is current_year + 2 (we give some leway)
    //  with the assumption that must be wrong.
    //
    const maxYear = moment().add(2, 'year').year();
    const match = getMatch(fileEntry.desc) || getMatch(fileEntry.descLong);

    if (match && match[1]) {
        let year;
        if (2 === match[1].length) {
            year = parseInt(match[1]);
            if (year) {
                if (year > 70) {
                    year += 1900;
                } else {
                    year += 2000;
                }
            }
        } else {
            year = parseInt(match[1]);
        }

        if (year && year <= maxYear) {
            fileEntry.meta.est_release_year = year;
        }
    }
}

//  a simple log proxy for when we call from oputil.js
const maybeLog = (obj, msg, level) => {
    if (Log) {
        Log[level](obj, msg);
    } else if ('error' === level) {
        console.error(`${msg}: ${JSON.stringify(obj)}`); //  eslint-disable-line no-console
    }
};

const logDebug = (obj, msg) => maybeLog(obj, msg, 'debug');
const logTrace = (obj, msg) => maybeLog(obj, msg, 'trace');
const logError = (obj, msg) => maybeLog(obj, msg, 'error');

function extractAndProcessDescFiles(fileEntry, filePath, archiveEntries, cb) {
    async.waterfall(
        [
            function extractDescFiles(callback) {
                //  :TODO: would be nice if these RegExp's were cached
                //  :TODO: this is long winded...
                const config = Config();
                const extractList = [];

                const shortDescFile = archiveEntries.find(e => {
                    return config.fileBase.fileNamePatterns.desc.find(pat =>
                        new RegExp(pat, 'i').test(e.fileName)
                    );
                });

                if (shortDescFile) {
                    extractList.push(shortDescFile.fileName);
                }

                const longDescFile = archiveEntries.find(e => {
                    return config.fileBase.fileNamePatterns.descLong.find(pat =>
                        new RegExp(pat, 'i').test(e.fileName)
                    );
                });

                if (longDescFile) {
                    extractList.push(longDescFile.fileName);
                }

                if (0 === extractList.length) {
                    return callback(null, []);
                }

                temptmp.mkdir({ prefix: 'enigextract-' }, (err, tempDir) => {
                    if (err) {
                        return callback(err);
                    }

                    const archiveUtil = ArchiveUtil.getInstance();
                    archiveUtil.extractTo(
                        filePath,
                        tempDir,
                        fileEntry.meta.archive_type,
                        extractList,
                        err => {
                            if (err) {
                                return callback(err);
                            }

                            const descFiles = {
                                desc: shortDescFile
                                    ? paths.join(
                                          tempDir,
                                          paths.basename(shortDescFile.fileName)
                                      )
                                    : null,
                                descLong: longDescFile
                                    ? paths.join(
                                          tempDir,
                                          paths.basename(longDescFile.fileName)
                                      )
                                    : null,
                            };

                            return callback(null, descFiles);
                        }
                    );
                });
            },
            function readDescFiles(descFiles, callback) {
                const config = Config();
                async.each(
                    Object.keys(descFiles),
                    (descType, next) => {
                        const path = descFiles[descType];
                        if (!path) {
                            return next(null);
                        }

                        fs.stat(path, (err, stats) => {
                            if (err) {
                                return next(null);
                            }

                            //  skip entries that are too large
                            const maxFileSizeKey = `max${_.upperFirst(
                                descType
                            )}FileByteSize`;
                            if (
                                config.fileBase[maxFileSizeKey] &&
                                stats.size > config.fileBase[maxFileSizeKey]
                            ) {
                                logDebug(
                                    {
                                        byteSize: stats.size,
                                        maxByteSize: config.fileBase[maxFileSizeKey],
                                    },
                                    `Skipping "${descType}"; Too large`
                                );
                                return next(null);
                            }

                            fs.readFile(path, (err, data) => {
                                if (err || !data) {
                                    return next(null);
                                }

                                SAUCE.readSAUCE(data, (err, sauce) => {
                                    if (sauce) {
                                        //  if we have SAUCE, this information will be kept as well,
                                        //  but separate/pre-parsed.
                                        const metaKey = `desc${
                                            'descLong' === descType ? '_long' : ''
                                        }_sauce`;
                                        fileEntry.meta[metaKey] = JSON.stringify(sauce);
                                    }

                                    //
                                    //  Assume FILE_ID.DIZ, NFO files, etc. are CP437; we need
                                    //  to decode to a native format for storage
                                    //
                                    //  :TODO: This isn't really always the case - how to handle this? We could do a quick detection...
                                    const decodedData = iconv.decode(data, 'cp437');
                                    fileEntry[descType] = sliceAtSauceMarker(decodedData);
                                    fileEntry[`${descType}Src`] = 'descFile';
                                    return next(null);
                                });
                            });
                        });
                    },
                    () => {
                        //  cleanup but don't wait
                        temptmp.cleanup(paths => {
                            //  note: don't use client logger here - may not be avail
                            logTrace(
                                { paths: paths, sessionId: temptmp.sessionId },
                                'Cleaned up temporary files'
                            );
                        });
                        return callback(null);
                    }
                );
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function extractAndProcessSingleArchiveEntry(fileEntry, filePath, archiveEntries, cb) {
    async.waterfall(
        [
            function extractToTemp(callback) {
                //  :TODO: we may want to skip this if the compressed file is too large...
                temptmp.mkdir({ prefix: 'enigextract-' }, (err, tempDir) => {
                    if (err) {
                        return callback(err);
                    }

                    const archiveUtil = ArchiveUtil.getInstance();

                    //  ensure we only extract one - there should only be one anyway -- we also just need the fileName
                    const extractList = archiveEntries
                        .slice(0, 1)
                        .map(entry => entry.fileName);

                    archiveUtil.extractTo(
                        filePath,
                        tempDir,
                        fileEntry.meta.archive_type,
                        extractList,
                        err => {
                            if (err) {
                                return callback(err);
                            }

                            return callback(null, paths.join(tempDir, extractList[0]));
                        }
                    );
                });
            },
            function processSingleExtractedFile(extractedFile, callback) {
                populateFileEntryInfoFromFile(fileEntry, extractedFile, err => {
                    if (!fileEntry.desc) {
                        fileEntry.desc = getDescFromFileName(filePath);
                        fileEntry.descSrc = 'fileName';
                    }
                    return callback(err);
                });
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function populateFileEntryWithArchive(fileEntry, filePath, stepInfo, iterator, cb) {
    const archiveUtil = ArchiveUtil.getInstance();
    const archiveType = fileEntry.meta.archive_type; //  we set this previous to populateFileEntryWithArchive()

    async.waterfall(
        [
            function getArchiveFileList(callback) {
                stepInfo.step = 'archive_list_start';

                iterator(err => {
                    if (err) {
                        return callback(err);
                    }

                    archiveUtil.listEntries(filePath, archiveType, (err, entries) => {
                        if (err) {
                            stepInfo.step = 'archive_list_failed';
                        } else {
                            stepInfo.step = 'archive_list_finish';
                            stepInfo.archiveEntries = entries || [];
                        }

                        iterator(iterErr => {
                            return callback(iterErr, entries || []); //  ignore original |err| here
                        });
                    });
                });
            },
            function processDescFilesStart(entries, callback) {
                stepInfo.step = 'desc_files_start';
                iterator(err => {
                    return callback(err, entries);
                });
            },
            function extractDescFromArchive(entries, callback) {
                //
                //  If we have a -single- entry in the archive, extract that file
                //  and try retrieving info in the non-archive manor. This should
                //  work for things like zipped up .pdf files.
                //
                //  Otherwise, try to find particular desc files such as FILE_ID.DIZ
                //  and README.1ST
                //
                const archDescHandler =
                    1 === entries.length
                        ? extractAndProcessSingleArchiveEntry
                        : extractAndProcessDescFiles;
                archDescHandler(fileEntry, filePath, entries, err => {
                    return callback(err);
                });
            },
            function attemptReleaseYearEstimation(callback) {
                attemptSetEstimatedReleaseDate(fileEntry);
                return callback(null);
            },
            function processDescFilesFinish(callback) {
                stepInfo.step = 'desc_files_finish';
                return iterator(callback);
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function getInfoExtractUtilForDesc(mimeType, filePath, descType) {
    const config = Config();
    let fileType = _.get(config, ['fileTypes', mimeType]);

    if (Array.isArray(fileType)) {
        //  further refine by extention
        fileType = fileType.find(ft => paths.extname(filePath) === ft.ext);
    }

    if (!_.isObject(fileType)) {
        return;
    }

    let util = _.get(fileType, `${descType}DescUtil`);
    if (!_.isString(util)) {
        return;
    }

    util = _.get(config, ['infoExtractUtils', util]);
    if (!util || !_.isString(util.cmd)) {
        return;
    }

    return util;
}

function populateFileEntryInfoFromFile(fileEntry, filePath, cb) {
    const mimeType = resolveMimeType(filePath);
    if (!mimeType) {
        return cb(null);
    }

    async.eachSeries(
        ['short', 'long'],
        (descType, nextDesc) => {
            const util = getInfoExtractUtilForDesc(mimeType, filePath, descType);
            if (!util) {
                return nextDesc(null);
            }

            const args = (util.args || ['{filePath}']).map(arg =>
                stringFormat(arg, { filePath: filePath })
            );

            execFile(util.cmd, args, { timeout: 1000 * 30 }, (err, stdout) => {
                if (err || !stdout) {
                    const reason = err ? err.message : 'No description produced';
                    logDebug(
                        { reason: reason, cmd: util.cmd, args: args },
                        `${_.upperFirst(descType)} description command failed`
                    );
                } else {
                    stdout = stdout.trim();
                    if (stdout.length > 0) {
                        const key = 'short' === descType ? 'desc' : 'descLong';
                        if ('desc' === key) {
                            //
                            //  Word wrap short descriptions to FILE_ID.DIZ spec
                            //
                            //  "...no more than 45 characters long"
                            //
                            //  See http://www.textfiles.com/computers/fileid.txt
                            //
                            stdout = (
                                wordWrapText(stdout, { width: 45 }).wrapped || []
                            ).join('\n');
                        }

                        fileEntry[key] = stdout;
                        fileEntry[`${key}Src`] = 'infoTool';
                    }
                }

                return nextDesc(null);
            });
        },
        () => {
            return cb(null);
        }
    );
}

function populateFileEntryNonArchive(fileEntry, filePath, stepInfo, iterator, cb) {
    async.series(
        [
            function processDescFilesStart(callback) {
                stepInfo.step = 'desc_files_start';
                return iterator(callback);
            },
            function getDescriptions(callback) {
                populateFileEntryInfoFromFile(fileEntry, filePath, err => {
                    if (!fileEntry.desc) {
                        fileEntry.desc = getDescFromFileName(filePath);
                        fileEntry.descSrc = 'fileName';
                    }
                    return callback(err);
                });
            },
            function processDescFilesFinish(callback) {
                stepInfo.step = 'desc_files_finish';
                return iterator(callback);
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function addNewFileEntry(fileEntry, filePath, cb) {
    //  :TODO: Use detectTypeWithBuf() once avail - we *just* read some file data

    async.series(
        [
            function addNewDbRecord(callback) {
                return fileEntry.persist(callback);
            },
        ],
        err => {
            return cb(err);
        }
    );
}

const HASH_NAMES = ['sha1', 'sha256', 'md5', 'crc32'];

function scanFile(filePath, options, iterator, cb) {
    if (3 === arguments.length && _.isFunction(iterator)) {
        cb = iterator;
        iterator = null;
    } else if (2 === arguments.length && _.isFunction(options)) {
        cb = options;
        iterator = null;
        options = {};
    }

    const fileEntry = new FileEntry({
        areaTag: options.areaTag,
        meta: options.meta,
        hashTags: options.hashTags, //  Set() or Array
        fileName: paths.basename(filePath),
        storageTag: options.storageTag,
        fileSha256: options.sha256, //  caller may know this already
    });

    const stepInfo = {
        filePath: filePath,
        fileName: paths.basename(filePath),
    };

    const callIter = next => {
        return iterator ? iterator(stepInfo, next) : next(null);
    };

    const readErrorCallIter = (origError, next) => {
        stepInfo.step = 'read_error';
        stepInfo.error = origError.message;

        callIter(() => {
            return next(origError);
        });
    };

    let lastCalcHashPercent;

    //  don't re-calc hashes for any we already have in |options|
    const hashesToCalc = HASH_NAMES.filter(hn => {
        if ('sha256' === hn && fileEntry.fileSha256) {
            return false;
        }

        if (`file_${hn}` in fileEntry.meta) {
            return false;
        }

        return true;
    });

    async.waterfall(
        [
            function startScan(callback) {
                fs.stat(filePath, (err, stats) => {
                    if (err) {
                        return readErrorCallIter(err, callback);
                    }

                    stepInfo.step = 'start';
                    stepInfo.byteSize = fileEntry.meta.byte_size = stats.size;

                    return callIter(callback);
                });
            },
            function processPhysicalFileGeneric(callback) {
                stepInfo.bytesProcessed = 0;

                const hashes = {};
                hashesToCalc.forEach(hashName => {
                    if ('crc32' === hashName) {
                        hashes.crc32 = new CRC32();
                    } else {
                        hashes[hashName] = crypto.createHash(hashName);
                    }
                });

                const updateHashes = data => {
                    for (let i = 0; i < hashesToCalc.length; ++i) {
                        hashes[hashesToCalc[i]].update(data);
                    }
                };

                //
                //  Note that we are not using fs.createReadStream() here:
                //  While convenient, it is quite a bit slower -- which adds
                //  up to many seconds in time for larger files.
                //
                const chunkSize = 1024 * 64;
                const buffer = Buffer.allocUnsafe(chunkSize);

                fs.open(filePath, 'r', (err, fd) => {
                    if (err) {
                        return readErrorCallIter(err, callback);
                    }

                    const nextChunk = () => {
                        fs.read(fd, buffer, 0, chunkSize, null, (err, bytesRead) => {
                            if (err) {
                                return fs.close(fd, closeErr => {
                                    if (closeErr) {
                                        logError(
                                            { filePath, error: err.message },
                                            'Failed to close file'
                                        );
                                    }
                                    return readErrorCallIter(err, callback);
                                });
                            }

                            if (0 === bytesRead) {
                                //  done - finalize
                                fileEntry.meta.byte_size = stepInfo.bytesProcessed;

                                for (let i = 0; i < hashesToCalc.length; ++i) {
                                    const hashName = hashesToCalc[i];
                                    if ('sha256' === hashName) {
                                        stepInfo.sha256 = fileEntry.fileSha256 =
                                            hashes.sha256.digest('hex');
                                    } else if (
                                        'sha1' === hashName ||
                                        'md5' === hashName
                                    ) {
                                        stepInfo[hashName] = fileEntry.meta[
                                            `file_${hashName}`
                                        ] = hashes[hashName].digest('hex');
                                    } else if ('crc32' === hashName) {
                                        stepInfo.crc32 = fileEntry.meta.file_crc32 =
                                            hashes.crc32.finalize().toString(16);
                                    }
                                }

                                stepInfo.step = 'hash_finish';
                                return fs.close(fd, closeErr => {
                                    if (closeErr) {
                                        logError(
                                            { filePath, error: err.message },
                                            'Failed to close file'
                                        );
                                    }
                                    return callIter(callback);
                                });
                            }

                            stepInfo.bytesProcessed += bytesRead;
                            stepInfo.calcHashPercent = Math.round(
                                (stepInfo.bytesProcessed / stepInfo.byteSize) * 100
                            );

                            //
                            //  Only send 'hash_update' step update if we have a noticeable percentage change in progress
                            //
                            const data =
                                bytesRead < chunkSize
                                    ? buffer.slice(0, bytesRead)
                                    : buffer;
                            if (
                                !iterator ||
                                stepInfo.calcHashPercent === lastCalcHashPercent
                            ) {
                                updateHashes(data);
                                return nextChunk();
                            } else {
                                lastCalcHashPercent = stepInfo.calcHashPercent;
                                stepInfo.step = 'hash_update';

                                callIter(err => {
                                    if (err) {
                                        return callback(err);
                                    }

                                    updateHashes(data);
                                    return nextChunk();
                                });
                            }
                        });
                    };

                    nextChunk();
                });
            },
            function processPhysicalFileByType(callback) {
                const archiveUtil = ArchiveUtil.getInstance();

                archiveUtil.detectType(filePath, (err, archiveType) => {
                    if (archiveType) {
                        //  save this off
                        fileEntry.meta.archive_type = archiveType;

                        populateFileEntryWithArchive(
                            fileEntry,
                            filePath,
                            stepInfo,
                            callIter,
                            err => {
                                if (err) {
                                    populateFileEntryNonArchive(
                                        fileEntry,
                                        filePath,
                                        stepInfo,
                                        callIter,
                                        err => {
                                            if (err) {
                                                logDebug(
                                                    { error: err.message },
                                                    'Non-archive file entry population failed'
                                                );
                                            }
                                            return callback(null); //  ignore err
                                        }
                                    );
                                } else {
                                    return callback(null);
                                }
                            }
                        );
                    } else {
                        populateFileEntryNonArchive(
                            fileEntry,
                            filePath,
                            stepInfo,
                            callIter,
                            err => {
                                if (err) {
                                    logDebug(
                                        { error: err.message },
                                        'Non-archive file entry population failed'
                                    );
                                }
                                return callback(null); //  ignore err
                            }
                        );
                    }
                });
            },
            function fetchExistingEntry(callback) {
                getExistingFileEntriesBySha256(
                    fileEntry.fileSha256,
                    (err, dupeEntries) => {
                        return callback(err, dupeEntries);
                    }
                );
            },
            function finished(dupeEntries, callback) {
                stepInfo.step = 'finished';
                callIter(() => {
                    return callback(null, dupeEntries);
                });
            },
        ],
        (err, dupeEntries) => {
            if (err) {
                return cb(err);
            }

            return cb(null, fileEntry, dupeEntries);
        }
    );
}

//  :TODO: this stuff needs cleaned up
// function scanFileAreaForChanges(areaInfo, options, iterator, cb) {
//     if(3 === arguments.length && _.isFunction(iterator)) {
//         cb          = iterator;
//         iterator    = null;
//     } else if(2 === arguments.length && _.isFunction(options)) {
//         cb          = options;
//         iterator    = null;
//         options     = {};
//     }

//     const storageLocations = getAreaStorageLocations(areaInfo);

//     async.eachSeries(storageLocations, (storageLoc, nextLocation) => {
//         async.series(
//             [
//                 function scanPhysFiles(callback) {
//                     const physDir = storageLoc.dir;

//                     fs.readdir(physDir, (err, files) => {
//                         if(err) {
//                             return callback(err);
//                         }

//                         async.eachSeries(files, (fileName, nextFile) => {
//                             const fullPath = paths.join(physDir, fileName);

//                             fs.stat(fullPath, (err, stats) => {
//                                 if(err) {
//                                     //  :TODO: Log me!
//                                     return nextFile(null);  //  always try next file
//                                 }

//                                 if(!stats.isFile()) {
//                                     return nextFile(null);
//                                 }

//                                 scanFile(
//                                     fullPath,
//                                     {
//                                         areaTag     : areaInfo.areaTag,
//                                         storageTag  : storageLoc.storageTag
//                                     },
//                                     iterator,
//                                     (err, fileEntry, dupeEntries) => {
//                                         if(err) {
//                                             //  :TODO: Log me!!!
//                                             return nextFile(null);  //  try next anyway
//                                         }

//                                         if(dupeEntries.length > 0) {
//                                             //  :TODO: Handle duplicates -- what to do here???
//                                         } else {
//                                             if(Array.isArray(options.tags)) {
//                                                 options.tags.forEach(tag => {
//                                                     fileEntry.hashTags.add(tag);
//                                                 });
//                                             }
//                                             addNewFileEntry(fileEntry, fullPath, err => {
//                                                 //  pass along error; we failed to insert a record in our DB or something else bad
//                                                 return nextFile(err);
//                                             });
//                                         }
//                                     }
//                                 );
//                             });
//                         }, err => {
//                             return callback(err);
//                         });
//                     });
//                 },
//                 function scanDbEntries(callback) {
//                     //  :TODO: Look @ db entries for area that were *not* processed above
//                     return callback(null);
//                 }
//             ],
//             err => {
//                 return nextLocation(err);
//             }
//         );
//     },
//     err => {
//         return cb(err);
//     });
// }

function getDescFromFileName(fileName) {
    //
    //  Example filenames:
    //
    //  input                                                               desired output
    //  -----------------------------------------------------------------------------------------
    //  Nintendo_Power_Issue_011_March-April_1990.cbr                       Nintendo Power Issue 011 March-April 1990
    //  Atari User Issue 3 (July 1985).pdf                                  Atari User Issue 3 (July 1985)
    //  Out_Of_The_Shadows_010__1953_.cbz                                   Out Of The Shadows 010 1953
    //  ABC A Basic Compiler 1.03 [pro].atr                                 ABC A Basic Compiler 1.03 [pro]
    //  221B Baker Street v1.0 (1987)(Datasoft)(Side B)[cr The Bounty].zip  221B Baker Street v1.0 (1987)(Datasoft)(Side B)[cr the Bounty]
    //
    //  See also:
    //  * https://scenerules.org/
    //

    const ext = paths.extname(fileName);
    const name = paths.basename(fileName, ext);
    const asIsRe =
        /([vV]?(?:[0-9]{1,4})(?:\.[0-9]{1,4})+[-+]?(?:[a-z]{1,4})?)|(Incl\.)|(READ\.NFO)/g;

    const normalize = s => {
        return _.upperFirst(s.replace(/[-_.+]/g, ' ').replace(/\s+/g, ' '));
    };

    let out = '';
    let m;
    let pos;
    do {
        pos = asIsRe.lastIndex;
        m = asIsRe.exec(name);
        if (m) {
            if (m.index > pos) {
                out += normalize(name.slice(pos, m.index));
            }
            out += m[0]; //  as-is
        }
    } while (0 != asIsRe.lastIndex);

    if (pos < name.length) {
        out += normalize(name.slice(pos));
    }

    return out;
}

//
//  Return an object of stats about an area(s)
//
//  {
//
//      totalFiles : <totalFileCount>,
//      totalBytes : <totalByteSize>,
//      areas : {
//          <areaTag> : {
//              files : <fileCount>,
//              bytes : <byteSize>
//          }
//      }
//  }
//
function getAreaStats(cb) {
    FileDb.all(
        `SELECT DISTINCT f.area_tag, COUNT(f.file_id) AS total_files, SUM(m.meta_value) AS total_byte_size
        FROM file f, file_meta m
        WHERE f.file_id = m.file_id AND m.meta_name='byte_size'
        GROUP BY f.area_tag;`,
        (err, statRows) => {
            if (err) {
                return cb(err);
            }

            if (!statRows || 0 === statRows.length) {
                return cb(Errors.DoesNotExist('No file areas to acquire stats from'));
            }

            return cb(
                null,
                statRows.reduce((stats, v) => {
                    stats.totalFiles = (stats.totalFiles || 0) + v.total_files;
                    stats.totalBytes = (stats.totalBytes || 0) + v.total_byte_size;

                    stats.areas = stats.areas || {};

                    stats.areas[v.area_tag] = {
                        files: v.total_files,
                        bytes: v.total_byte_size,
                    };
                    return stats;
                }, {})
            );
        }
    );
}

//  method exposed for event scheduler
function updateAreaStatsScheduledEvent(args, cb) {
    getAreaStats((err, stats) => {
        if (!err) {
            StatLog.setNonPersistentSystemStat(SysProps.FileBaseAreaStats, stats);
        }

        return cb(err);
    });
}

function cleanUpTempSessionItems(cb) {
    //  find (old) temporary session items and nuke 'em
    const filter = {
        areaTag: WellKnownAreaTags.TempDownloads,
        metaPairs: [
            {
                name: 'session_temp_dl',
                value: 1,
            },
        ],
    };

    FileEntry.findFiles(filter, (err, fileIds) => {
        if (err) {
            return cb(err);
        }

        async.each(
            fileIds,
            (fileId, nextFileId) => {
                const fileEntry = new FileEntry();
                fileEntry.load(fileId, err => {
                    if (err) {
                        Log.warn(
                            { fileId },
                            'Failed loading temporary session download item for cleanup'
                        );
                        return nextFileId(null);
                    }

                    FileEntry.removeEntry(fileEntry, { removePhysFile: true }, err => {
                        if (err) {
                            Log.warn(
                                {
                                    fileId: fileEntry.fileId,
                                    filePath: fileEntry.filePath,
                                },
                                'Failed to clean up temporary session download item'
                            );
                        }
                        return nextFileId(null);
                    });
                });
            },
            () => {
                return cb(null);
            }
        );
    });
}
