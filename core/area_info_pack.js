/* jslint node: true */
'use strict';

//  ENiGMA½
const ConfigModule = require('./config.js');
const Config = (...args) => ConfigModule.get(...args);
const Log = () => require('./logger.js').log;
const Errors = require('./enig_error.js').Errors;
const StatLog = require('./stat_log.js');
const SysProps = require('./system_property.js');
const ArchiveUtil = require('./archive_util.js');
const { AreaListFormat, parseAreaList, describeFormat } = require('./area_import.js');
const autoAreaCreate = require('./auto_area_create.js');

//  deps
const fs = require('graceful-fs');
const fse = require('fs-extra');
const paths = require('path');
const async = require('async');
const temptmp = require('temptmp').createTrackedSession('ftn_info_pack');
const _ = require('lodash');

//
//  Info pack ingest: metadata enrichment for automatically created areas.
//
//  Networks distribute an "info pack" -- an archive carrying the area list,
//  nodelist and documentation -- through a file echo, so it arrives by TIC
//  like any other file.  Rather than being triggered by that arrival, ingest
//  *queries the file area*, the same way a FREQ resolves a TIC-fed nodelist.
//  That means there is no path to configure, packs that landed before the
//  feature existed still work, a pack placed by `oputil fb scan` or by hand
//  works, and a missed trigger is picked up on the next pass.
//
//  What it does with the list is narrow on purpose.  A pack lists what the
//  *network* carries, not what *we are linked to*: creating from it wholesale
//  produces hundreds of permanently empty areas.  So by default it only
//  replaces the placeholder name and description on areas we already carry,
//  and creating unlinked areas is opt-in.  Enrichment-only also means nothing
//  is ever created from untrusted input -- the worst a hostile pack achieves
//  is wrong descriptions.
//

//  Only these ever come out of a pack
const AllowedMemberExtensions = ['.na', '.txt'];
const MaxMemberBytes = 1024 * 1024;
const MaxTotalExtractedBytes = 4 * 1024 * 1024;
const MaxMemberCount = 8;

function log() {
    //  logger.log is undefined until Log.init(); tests stub it
    return Log() || { info() {}, warn() {}, error() {}, debug() {} };
}

//  "fsxnet*.zip" -> /^fsxnet.*\.zip$/i
function globToRegExp(glob) {
    const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

function getInfoPackShaMap() {
    const raw = StatLog.getSystemStat(SysProps.FtnInfoPackSha);
    if (!raw) {
        return {};
    }
    try {
        const parsed = _.isString(raw) ? JSON.parse(raw) : raw;
        return _.isObject(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function setInfoPackSha(networkName, sha) {
    const map = getInfoPackShaMap();
    map[networkName] = sha;
    StatLog.setSystemStat(SysProps.FtnInfoPackSha, JSON.stringify(map));
}

//
//  Newest file in |areaTag| whose name matches |match|.
//
function findInfoPackFile(areaTag, match, cb) {
    const FileEntry = require('./file_entry.js');
    const matchRe = match ? globToRegExp(match) : null;

    FileEntry.findFiles(
        { areaTag, sort: 'upload_timestamp', order: 'descending' },
        (err, fileIds) => {
            if (err || !fileIds || 0 === fileIds.length) {
                return cb(null, null);
            }

            let index = 0;
            const next = () => {
                if (index >= fileIds.length) {
                    return cb(null, null);
                }

                FileEntry.loadBasicEntry(fileIds[index++], {}, (loadErr, entry) => {
                    if (loadErr) {
                        return next();
                    }

                    if (matchRe && !matchRe.test(entry.fileName || '')) {
                        return next();
                    }

                    let filePath;
                    try {
                        filePath = new FileEntry(entry).filePath;
                    } catch (e) {
                        return next();
                    }

                    fs.stat(filePath, statErr => {
                        if (statErr) {
                            return next();
                        }
                        return cb(null, {
                            filePath,
                            fileName: entry.fileName,
                            fileSha256: entry.fileSha256,
                        });
                    });
                });
            };

            next();
        }
    );
}

//
//  Extract |wantedName| from |archivePath| and return its text.
//
//  An info pack arrives over FTN from a hub, so it is attacker adjacent and
//  everything here is bounded.  The manifest decides what is asked for, but
//  what actually lands on disk is what gets enforced: extractTo() silently
//  downgrades to a full decompress when the configured archiver has no
//  file-list extract verb, and listEntries() sizes are scraped from archiver
//  stdout with a regex.  Neither can be trusted, so extraction goes into an
//  empty temp directory and everything unwanted is deleted from it.
//
function extractAreaListFromPack(archivePath, wantedName, cb) {
    const archUtil = ArchiveUtil.getInstance();
    const wantedBase = paths.basename(String(wantedName)).toLowerCase();

    if (!AllowedMemberExtensions.includes(paths.extname(wantedBase))) {
        return cb(
            Errors.Invalid(
                `"${wantedName}" does not have an allowed extension (${AllowedMemberExtensions.join(
                    ', '
                )})`
            )
        );
    }

    const isSafeMemberName = name => {
        if (!_.isString(name) || 0 === name.length) {
            return false;
        }
        //  basename only: no paths from the archive are ever honoured
        if (/[/\\]/.test(name) || name.includes('..')) {
            return false;
        }
        return AllowedMemberExtensions.includes(paths.extname(name.toLowerCase()));
    };

    let tempDir;

    async.waterfall(
        [
            callback => archUtil.detectType(archivePath, callback),
            (archName, callback) => {
                if (undefined === archName) {
                    return callback(
                        Errors.Invalid(`Unknown archive type: ${archivePath}`)
                    );
                }
                archUtil.listEntries(archivePath, archName, (err, entries) =>
                    callback(err, archName, entries || [])
                );
            },
            (archName, entries, callback) => {
                const wanted = entries
                    .filter(
                        e =>
                            isSafeMemberName(e.fileName) &&
                            paths.basename(e.fileName).toLowerCase() === wantedBase &&
                            !(e.byteSize > MaxMemberBytes)
                    )
                    .slice(0, MaxMemberCount);

                if (0 === wanted.length) {
                    return callback(
                        Errors.DoesNotExist(
                            `"${wantedName}" is not in ${paths.basename(archivePath)}`
                        )
                    );
                }

                temptmp.mkdir({ prefix: 'eniginfopack-' }, (err, dir) => {
                    if (err) {
                        return callback(err);
                    }
                    tempDir = dir;
                    archUtil.extractTo(
                        archivePath,
                        tempDir,
                        archName,
                        wanted.map(e => e.fileName),
                        extractErr => callback(extractErr)
                    );
                });
            },
            callback => {
                //
                //  Enforce on what actually landed, not on what was asked for.
                //
                let totalBytes = 0;
                let found;

                fs.readdir(tempDir, (err, files) => {
                    if (err) {
                        return callback(err);
                    }

                    async.eachSeries(
                        files,
                        (fileName, nextFile) => {
                            const fullPath = paths.join(tempDir, fileName);
                            fs.lstat(fullPath, (statErr, stat) => {
                                if (statErr) {
                                    return nextFile(null);
                                }

                                const keep =
                                    stat.isFile() &&
                                    isSafeMemberName(fileName) &&
                                    stat.size <= MaxMemberBytes &&
                                    totalBytes + stat.size <= MaxTotalExtractedBytes &&
                                    fileName.toLowerCase() === wantedBase;

                                if (!keep) {
                                    return fse.remove(fullPath, () => nextFile(null));
                                }

                                totalBytes += stat.size;
                                found = fullPath;
                                return nextFile(null);
                            });
                        },
                        eachErr => callback(eachErr, found)
                    );
                });
            },
            (found, callback) => {
                if (!found) {
                    return callback(
                        Errors.DoesNotExist(
                            `"${wantedName}" was not produced by extraction`
                        )
                    );
                }
                fs.readFile(found, 'utf8', callback);
            },
        ],
        (err, data) => {
            if (tempDir) {
                fse.remove(tempDir, () => {});
            }
            return cb(err, data);
        }
    );
}

//
//  Ingest the info pack for one network, if there is a new one.
//
//  cb(err, { skipped, reason } | { enriched, created, format })
//
function ingestInfoPackForNetwork(networkName, cb) {
    const autoConfig = autoAreaCreate.getAutoAreasConfig(networkName);
    const infoPack = _.get(autoConfig, 'infoPack');

    if (!infoPack || true !== infoPack.enabled) {
        return cb(null, { skipped: true, reason: 'not enabled' });
    }

    if (!_.isString(infoPack.areaTag) || !_.isString(infoPack.areaFile)) {
        return cb(
            Errors.MissingConfig(
                `autoAreas.infoPack for "${networkName}" needs both "areaTag" and "areaFile"`
            )
        );
    }

    async.waterfall(
        [
            callback =>
                findInfoPackFile(infoPack.areaTag, infoPack.match, (err, found) =>
                    callback(err, found)
                ),
            (found, callback) => {
                if (!found) {
                    return callback(null, null);
                }

                //
                //  scanFile() populates fileSha256 during TIC import, so an
                //  unchanged pack is free to detect and costs one query.
                //
                if (
                    found.fileSha256 &&
                    getInfoPackShaMap()[networkName] === found.fileSha256
                ) {
                    return callback(null, null);
                }

                return callback(null, found);
            },
            (found, callback) => {
                if (!found) {
                    return callback(null, null, null);
                }

                extractAreaListFromPack(
                    found.filePath,
                    infoPack.areaFile,
                    (err, data) => {
                        if (err) {
                            return callback(err);
                        }
                        return callback(null, found, data);
                    }
                );
            },
            (found, data, callback) => {
                if (!found) {
                    return callback(null, { skipped: true, reason: 'unchanged' });
                }

                const parsed = parseAreaList(data);

                //
                //  Degrade to "no enrichment available" rather than guessing.
                //  Two of eight networks surveyed ship no machine readable
                //  list at all -- one uses reversed columns, one embeds its
                //  areas in English prose.
                //
                if (AreaListFormat.NA !== parsed.format || 0 === parsed.entries.length) {
                    log().warn(
                        {
                            networkName,
                            pack: found.fileName,
                            areaFile: infoPack.areaFile,
                            format: parsed.format,
                        },
                        `Info pack area list is a ${describeFormat(
                            parsed.format
                        )}; no descriptions were taken from it`
                    );

                    //  still record the sha: re-reading it will not help
                    if (found.fileSha256) {
                        setInfoPackSha(networkName, found.fileSha256);
                    }
                    return callback(null, {
                        skipped: true,
                        reason: 'unusable area list',
                        format: parsed.format,
                    });
                }

                autoAreaCreate.applyInfoPackEntries(
                    networkName,
                    parsed.entries,
                    { createUnlinked: true === infoPack.createUnlinked },
                    (err, result) => {
                        if (err) {
                            return callback(err);
                        }

                        if (found.fileSha256) {
                            setInfoPackSha(networkName, found.fileSha256);
                        }

                        log().info(
                            {
                                networkName,
                                pack: found.fileName,
                                entries: parsed.entries.length,
                                enriched: result.enriched.length,
                                created: result.created.length,
                            },
                            `Info pack ingested for "${networkName}"`
                        );

                        return callback(null, Object.assign({ skipped: false }, result));
                    }
                );
            },
        ],
        cb
    );
}

function infoPackNetworkNames() {
    return Object.keys(_.get(Config(), 'messageNetworks.ftn.networks', {})).filter(
        networkName => {
            const cfg = autoAreaCreate.getAutoAreasConfig(networkName);
            return cfg && true === _.get(cfg, 'infoPack.enabled');
        }
    );
}

function ingestInfoPacks(cb) {
    const networkNames = infoPackNetworkNames();
    if (0 === networkNames.length) {
        return cb(null);
    }

    async.eachSeries(
        networkNames,
        (networkName, nextNetwork) => {
            ingestInfoPackForNetwork(networkName, err => {
                if (err) {
                    log().warn(
                        { networkName, error: err.message },
                        'Info pack ingest failed'
                    );
                }
                return nextNetwork(null);
            });
        },
        () => cb(null)
    );
}

module.exports = {
    AllowedMemberExtensions,
    MaxMemberBytes,
    MaxTotalExtractedBytes,

    globToRegExp,
    findInfoPackFile,
    extractAreaListFromPack,
    ingestInfoPackForNetwork,
    infoPackNetworkNames,
    ingestInfoPacks,
};
