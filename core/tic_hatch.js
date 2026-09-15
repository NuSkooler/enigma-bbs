/* jslint node: true */
'use strict';

//  ENiGMA½
const Address = require('./ftn_address.js');
const configModule = require('./config.js');
//  Look up configModule.get on each call rather than capturing it at load
//  time -- it is rebound when the Config bootstrapper runs, and swapped by
//  tests. Same reasoning as ftn_bso.js.
const Config = (...args) => configModule.get(...args);
const Errors = require('./enig_error.js').Errors;
const FileEntry = require('./file_entry.js');
const Log = require('./logger.js').log;
const TicFileInfo = require('./tic_file_info.js');
const ticForward = require('./tic_forward.js');
const {
    getAreaStorageDirectoryByTag,
    getFileAreaByTag,
    isValidStorageTag,
    scanFile,
} = require('./file_base_area.js');
const { copyFileWithCollisionHandling, safeCopyFile } = require('./file_util.js');

//  deps
const _ = require('lodash');
const async = require('async');
const fs = require('graceful-fs');
const paths = require('path');

//
//  Hatching: originating a file into a file echo we carry, rather than passing
//  on one an uplink sent us.
//
//  * FTS-5006.001 @ http://ftsc.org/docs/fts-5006.001
//  * FSC-0087.001 @ http://ftsc.org/docs/fsc-0087.001
//
//  This is the difference between relaying a file echo and running one. A hub
//  that cannot hatch cannot ship its own nodelist, its own infopack, or
//  anything else it produces -- it can only repeat what it is told.
//
//  Deliberately thin. #743 left the forwarding machinery shaped for this and
//  nothing here re-implements any of it: the per-downlink TIC generation, the
//  loop guard, the unique 8.3 naming, the payload-then-TIC append and the
//  Replaces dequeue are all reached through ftn_bso's announceTicToDownlinks().
//  What this module adds is the half that has no inbound TIC to start from --
//  building one out of local metadata, and putting the payload into the file
//  base so there is something for the announcement to refer to.
//
//  The TIC is rendered as text and read back through TicFileInfo's own parser
//  rather than assembled as an object. That costs a parse we could have skipped
//  and buys the property that matters: a hatched TIC reaches TicFileWriter in
//  exactly the shape a forwarded one does, so there is one way a TIC gets
//  written and no second path to keep in step.
//

//
//  Keywords a hatch originates. Everything else in the outgoing TIC -- From,
//  To, Pw, Crc, Path, Seenby, Created -- is regenerated per downlink by
//  TicFileWriter and must not appear here; see its regeneratedKeywords.
//
//  Origin is the exception that proves the rule. It is *not* regenerated: it
//  names the system that put the file into the echo and stays constant for
//  every hop thereafter, which is what makes "Replaces" resolvable downstream.
//  For a hatch that system is us.
//
const HatchedKeywords = [
    'Area',
    'Areadesc',
    'Origin',
    'File',
    'Lfile',
    'Size',
    'Date',
    'Desc',
    'Ldesc',
    'Replaces',
];

//
//  A DOS 8.3 name for |fileName|, which is what FTS-5006's "File" keyword is.
//
//  FTS-5006: "File [filename] The name of the file, in 8.3 format." The long
//  name travels separately in "Lfile", and TicFileWriter emits both. Getting
//  this wrong is not cosmetic -- htick resolves a payload strictly by the "File"
//  name with no size or CRC fallback, so a downlink that cannot match the two
//  is left holding an orphan (which is exactly what #759 was about).
//
//  Uppercased because that is the DOS form and because our own import stores
//  |short_file_name| uppercase, and "Replaces" is matched against it.
//
function dosFileName(fileName) {
    const base = paths.basename(String(fileName || ''));
    const ext = paths.extname(base);
    const stem = base.slice(0, base.length - ext.length);

    //  Strip what a DOS name cannot hold, rather than passing it through and
    //  letting a peer reject the TIC. Spaces included: a value is delimited by
    //  whitespace, so a space in "File" makes the rest of the name vanish.
    const clean = s => s.replace(/[^A-Za-z0-9_!#$%&'()@^`{}~-]/g, '');

    const stem83 = clean(stem).slice(0, 8) || 'FILE';
    const ext83 = clean(ext.replace(/^\./, '')).slice(0, 3);

    return (ext83 ? `${stem83}.${ext83}` : stem83).toUpperCase();
}

//
//  The TIC text for a hatch, before any per-downlink regeneration.
//
//  Pure: everything comes in by argument so this can be read and tested on its
//  own. Values are sanitized the way TicFileWriter sanitizes the ones it
//  generates -- an operator's --desc arrives from a shell and a CR in it would
//  otherwise append whatever followed as its own keyword line, which is the
//  same injection the reader closes by treating a bare CR as a terminator.
//
function buildHatchTic(opts) {
    const lines = [];

    const emit = (keyword, value) => {
        if (undefined === value || null === value || '' === String(value)) {
            return;
        }
        // eslint-disable-next-line no-control-regex
        const clean = String(value)
            .replace(/[\u0000-\u001f]+/g, ' ')
            .trim();
        if (clean) {
            lines.push(`${keyword} ${clean}`);
        }
    };

    emit('Area', String(opts.areaTag || '').toUpperCase());
    emit('Areadesc', opts.areaDesc);
    emit(
        'Origin',
        opts.origin instanceof Address ? opts.origin.toString('4D') : opts.origin
    );
    emit('File', opts.fileName);

    //  Only when it says something the 8.3 name does not. FTS-5006 recommends
    //  writing Lfile rather than Fullname; a link that cannot cope turns it off
    //  per node and TicFileWriter drops it.
    if (opts.longFileName && opts.longFileName !== opts.fileName) {
        emit('Lfile', opts.longFileName);
    }

    emit('Size', opts.size);

    //
    //  FTS-5006's "Date" is a unix timestamp. Decimal, like Path -- FSC-0087
    //  calls TimeDateStamps hexadecimal but FTS-5006's own example is decimal
    //  and so is every implementation in the field.
    //
    if (_.isNumber(opts.date)) {
        emit('Date', Math.floor(opts.date));
    }

    emit('Desc', opts.desc);

    //
    //  Ldesc is repeatable and explicitly multi-line: "This Keyword may occur
    //  more than once. [...] Together they form a long description." One line
    //  per line, blanks included -- they are vertical spacing in ANSI art
    //  descriptions, and closing the gap mangles the art.
    //
    (opts.ldesc || []).forEach(line => {
        // eslint-disable-next-line no-control-regex
        lines.push(`Ldesc ${String(line).replace(/[\u0000-\u001f]+/g, ' ')}`.trimEnd());
    });

    emit('Replaces', opts.replaces);

    //  FTS-5006 2.2: "Application must only write files with a CR,LF pair."
    return lines.join('\r\n') + '\r\n';
}

//
//  The ticAreas entry for |externalAreaTag|, matched the way ftn_bso matches it.
//
function ticAreaConfigFor(externalAreaTag) {
    const ticAreas = _.get(Config(), 'scannerTossers.ftn_bso.ticAreas', {});
    const wanted = String(externalAreaTag).toLowerCase();
    const key = Object.keys(ticAreas).find(k => k.toLowerCase() === wanted);
    return key ? { key, config: ticAreas[key] } : undefined;
}

//
//  Which echo we are hatching into, and who is downstream of it.
//
//  Pure configuration: the ticAreas entry, its downlinks, and the local area
//  tag it names. Kept apart from resolveHatchStorage() below because this half
//  reads only scannerTossers.ftn_bso and that half reads only fileBase, so each
//  can be exercised without standing up the other's world.
//
function resolveEchoTarget(externalAreaTag) {
    const area = ticAreaConfigFor(externalAreaTag);
    if (!area) {
        return {
            error: Errors.DoesNotExist(
                `No ticAreas entry for "${externalAreaTag}". Hatching announces a file into an echo we carry; add the echo first.`
            ),
        };
    }

    const downlinks = ticForward.downlinksOf(area.config);
    if (0 === downlinks.length) {
        return {
            error: Errors.Invalid(
                `TIC area "${area.key}" names no "downlinks", so a hatch would announce the file to nobody.`
            ),
        };
    }

    //
    //  A local file area is still required. store() hard-fails without one and
    //  passthrough areas (#753) are not built yet, so say which knob is missing
    //  rather than failing later with a tag nobody configured.
    //
    const localAreaTag = area.config.areaTag;
    if (!localAreaTag) {
        return {
            error: Errors.Invalid(
                `TIC area "${area.key}" has no "areaTag", so there is no file base area to hatch into.`
            ),
        };
    }

    return {
        externalAreaTag: area.key,
        ticAreaConfig: area.config,
        downlinks,
        localAreaTag,
    };
}

//
//  Where the payload will live: the file base area behind the echo, and which
//  of its storage locations to use.
//
//  |storageTagOverride| is --storage-tag or the ticAreas entry's own
//  |storageTag|; otherwise the area's first, which is what the import path
//  picks.
//
function resolveHatchStorage(localAreaTag, storageTagOverride) {
    const areaInfo = getFileAreaByTag(localAreaTag);
    if (!areaInfo) {
        return {
            error: Errors.DoesNotExist(
                `File base area "${localAreaTag}" does not exist.`
            ),
        };
    }

    const storageTag = storageTagOverride || areaInfo.storageTags[0];
    if (!isValidStorageTag(storageTag)) {
        return { error: Errors.Invalid(`Invalid storage tag: ${storageTag}`) };
    }

    const storageDir = getAreaStorageDirectoryByTag(storageTag);
    if (!storageDir) {
        return {
            error: Errors.DoesNotExist(`No storage directory for tag "${storageTag}".`),
        };
    }

    return { areaInfo, storageTag, storageDir };
}

//
//  Our address for this echo's network, which signs the hatch.
//
//  Resolved the same way ftn_bso resolves it for a forward, and for the same
//  reason: the address on the From line and the outbound directory the file is
//  filed under have to agree. An area carried on more than one network cannot
//  be expressed yet (#757); until it can, "network" on the ticAreas entry is
//  how an operator says which one.
//
function originAddressFor(ticAreaConfig, ftnBso, downlinks) {
    const networkName =
        ticAreaConfig.network ||
        ftnBso.getNetworkNameForTicArea(
            { externalAreaTag: ticAreaConfig.areaTag },
            downlinks
        );

    const network = networkName ? ftnBso.getNetworkConfig(networkName) : undefined;
    const addr = network && Address.fromString(network.localAddress);

    if (!addr || !addr.isValid()) {
        return {
            error: Errors.Invalid(
                'No usable local address for this area\'s network; set "network" on the ticAreas entry.'
            ),
        };
    }

    return { networkName, origin: addr };
}

//
//  The entry a "Replaces" pattern supersedes, if there is exactly one.
//
//  Matched on the same two pieces of metadata the import path matches on --
//  |short_file_name| against the pattern and |tic_origin| against ourselves --
//  and scoped to the area. Same rule, deliberately: a file hatched here and one
//  received from an uplink have to be findable the same way, or a downlink's
//  "Replaces" chain breaks at whichever hop we are.
//
//  0 or 1 only. More than one match is refused rather than guessed at: picking
//  wrong deletes the local file *and* pulls the real one out of every
//  downlink's queue.
//
function findReplacedEntry(replaces, { localAreaTag, origin }, cb) {
    if (!replaces) {
        return cb(null, null);
    }

    const metaPairs = [
        {
            name: 'short_file_name',
            value: String(replaces).toUpperCase(),
            wildcards: true,
        },
        { name: 'tic_origin', value: origin.toString('4D') },
    ];

    FileEntry.findFiles({ metaPairs, areaTag: localAreaTag }, (err, fileIds) => {
        if (err) {
            return cb(err);
        }

        if (0 === fileIds.length) {
            //  Not an error. The first hatch of a weekly nodelist passes
            //  "--replaces NODELIST.*" and there is nothing there yet.
            return cb(null, null);
        }

        if (fileIds.length > 1) {
            return cb(
                Errors.General(
                    `"${replaces}" matches ${fileIds.length} files in ${localAreaTag}; be more specific.`
                )
            );
        }

        FileEntry.loadBasicEntry(fileIds[0], {}, (err, info) => {
            if (err || !info) {
                return cb(null, null);
            }

            const dir = getAreaStorageDirectoryByTag(info.storageTag);
            return cb(null, {
                fileId: fileIds[0],
                fileName: info.fileName,
                storageTag: info.storageTag,
                path: dir ? paths.join(dir, info.fileName) : undefined,
            });
        });
    });
}

//
//  Hatch |filePath| into the echo |externalAreaTag|.
//
//  |opts|:
//    externalAreaTag  string   the FTN area tag, i.e. a ticAreas key (required)
//    filePath         string   the file to hatch (required)
//    ftnBso           object   an FTNMessageScanTossModule instance (required)
//    desc             string   short description -> Desc
//    ldesc            string[] long description  -> Ldesc, one line each
//    replaces         string   8.3 pattern superseded by this file
//    hashTags         Set|[]   file base hashtags
//    storageTag       string   storage location, else the area's first
//    dryRun           bool     resolve and report, write nothing
//
//  Calls back (err, result) where |result| describes what happened, so the
//  caller can report it without re-deriving any of it.
//
function hatch(opts, cb) {
    const { externalAreaTag, filePath, ftnBso } = opts;

    //  Both halves before anything is written, so a misconfiguration is
    //  reported rather than leaving a half-copied file behind.
    const target = resolveEchoTarget(externalAreaTag);
    if (target.error) {
        return cb(target.error);
    }

    const storage = resolveHatchStorage(
        target.localAreaTag,
        opts.storageTag || target.ticAreaConfig.storageTag
    );
    if (storage.error) {
        return cb(storage.error);
    }

    Object.assign(target, storage);

    const originInfo = originAddressFor(target.ticAreaConfig, ftnBso, target.downlinks);
    if (originInfo.error) {
        return cb(originInfo.error);
    }

    const { origin, networkName } = originInfo;

    async.waterfall(
        [
            function statSource(callback) {
                fs.stat(filePath, (err, stats) => {
                    if (err) {
                        return callback(
                            Errors.DoesNotExist(
                                `Cannot hatch ${filePath}: ${err.message}`
                            )
                        );
                    }
                    if (!stats.isFile()) {
                        return callback(
                            Errors.Invalid(`${filePath} is not a regular file`)
                        );
                    }
                    return callback(null, stats);
                });
            },
            function findReplaced(stats, callback) {
                findReplacedEntry(
                    opts.replaces,
                    { localAreaTag: target.localAreaTag, origin },
                    (err, replaced) => callback(err, stats, replaced)
                );
            },
            function describe(stats, replaced, callback) {
                const longName = paths.basename(filePath);
                const info = {
                    externalAreaTag: target.externalAreaTag,
                    localAreaTag: target.localAreaTag,
                    storageTag: target.storageTag,
                    networkName,
                    origin,
                    downlinks: target.downlinks,
                    longFileName: longName,
                    fileName: dosFileName(longName),
                    size: stats.size,
                    date: Math.floor(stats.mtimeMs / 1000),
                    replaced,
                };

                if (opts.dryRun) {
                    //  Everything above is a read. Stop before the first write.
                    return callback(null, info, null);
                }

                return callback(null, info, true);
            },
            function storeInFileBase(info, proceed, callback) {
                if (!proceed) {
                    return callback(null, info, null);
                }

                //
                //  An update keeps the name it had, so the downlink's Replaces
                //  chain and our own storage agree. A new file must land under
                //  the name we are about to announce, so a collision is refused
                //  rather than renamed around: forwarding already refuses to
                //  announce a collision-renamed file, because announcing one
                //  name while shipping another leaves the downlink an orphan it
                //  can never pair up.
                //
                const dst = paths.join(target.storageDir, info.longFileName);
                const isUpdate = !!info.replaced;

                const collided = () =>
                    Errors.General(
                        `${info.longFileName} already exists in ${target.localAreaTag}. Use --replaces to supersede it, or hatch it under another name.`
                    );

                const copied = (err, finalPath) => {
                    if (err) {
                        return callback(err);
                    }

                    if (finalPath !== dst) {
                        //
                        //  Take the renamed copy back out. We are refusing this
                        //  hatch, and leaving it would put a file in the area's
                        //  storage directory that no database row and no TIC
                        //  names -- an orphan the operator finds by hand, if at
                        //  all. Collision handling is still what does the
                        //  detecting: a bare stat would leave a window for the
                        //  file to appear between the check and the copy.
                        //
                        return fs.unlink(finalPath, () => callback(collided()));
                    }

                    info.newPath = finalPath;
                    return callback(null, info, finalPath);
                };

                if (isUpdate) {
                    return safeCopyFile(filePath, dst, { overwrite: true }, err =>
                        copied(err, dst)
                    );
                }
                return copyFileWithCollisionHandling(filePath, dst, copied);
            },
            function scanAndPersist(info, newPath, callback) {
                if (!newPath) {
                    return callback(null, info);
                }

                const scanOpts = {
                    areaTag: target.localAreaTag,
                    storageTag: target.storageTag,
                    hashTags: opts.hashTags,
                    meta: {
                        //  Upper, as the import path stores it: "Replaces" is
                        //  matched against this and against nothing else.
                        short_file_name: info.fileName,
                        //  Ourselves. A later hatch's "Replaces" is scoped by
                        //  origin, so a file we hatched must record us as its
                        //  origin exactly as an imported one records its
                        //  uplink's.
                        tic_origin: origin.toString('4D'),
                    },
                };

                if (opts.desc) {
                    scanOpts.meta.tic_desc = opts.desc;
                }

                scanFile(newPath, scanOpts, (err, fileEntry) => {
                    if (err) {
                        return callback(err);
                    }

                    fileEntry.areaTag = target.localAreaTag;
                    fileEntry.storageTag = target.storageTag;
                    fileEntry.fileName = info.longFileName;

                    if (opts.desc) {
                        fileEntry.desc = opts.desc;
                    }
                    if (opts.ldesc && opts.ldesc.length) {
                        fileEntry.descLong = opts.ldesc.join('\n');
                    }

                    if (info.replaced) {
                        fileEntry.fileId = info.replaced.fileId;
                    }

                    info.crc32 = _.get(fileEntry, 'meta.file_crc32');
                    info.fileEntry = fileEntry;

                    fileEntry.persist(!!info.replaced, err => callback(err, info));
                });
            },
            function announce(info, callback) {
                info.ticData = buildHatchTic({
                    areaTag: info.externalAreaTag,
                    areaDesc: target.ticAreaConfig.areaDesc,
                    origin,
                    fileName: info.fileName,
                    longFileName: info.longFileName,
                    size: info.size,
                    date: info.date,
                    desc: opts.desc,
                    ldesc: opts.ldesc,
                    replaces: opts.replaces,
                });

                if (opts.dryRun) {
                    return callback(null, info);
                }

                //  |path| is the source directory so resolveFilePath() has
                //  somewhere sane to look; nothing on the announce path reads
                //  it, since the payload we ship is the file base copy.
                const ticFileInfo = TicFileInfo.createFromString(
                    info.ticData,
                    paths.join(paths.dirname(filePath), info.fileName)
                );

                //
                //  The shape announceTicToDownlinks() expects. |newPath| is the
                //  file base copy -- what actually gets queued -- and the
                //  replaced entry's old path is what gets dequeued from any
                //  downlink that has not collected it yet.
                //
                const localInfo = {
                    externalAreaTag: info.externalAreaTag,
                    areaTag: info.localAreaTag,
                    newPath: info.newPath,
                    crc32: info.crc32,
                    fileEntry: info.fileEntry,
                    existingFileId: info.replaced ? info.replaced.fileId : undefined,
                    oldPath: info.replaced ? info.replaced.path : undefined,
                };

                ftnBso.announceTicToDownlinks(
                    ticFileInfo,
                    localInfo,
                    target.ticAreaConfig,
                    target.downlinks,
                    () => callback(null, info)
                );
            },
            function removeSupersededFile(info, callback) {
                //
                //  The old physical file, once the downlinks that still wanted
                //  it have been dequeued. Only when the name changed: a
                //  same-name hatch overwrote it in place, and unlinking then
                //  deletes what we just wrote.
                //
                if (opts.dryRun || !info.replaced || !info.replaced.path) {
                    return callback(null, info);
                }
                if (info.replaced.path === info.newPath) {
                    return callback(null, info);
                }

                fs.unlink(info.replaced.path, err => {
                    if (err && 'ENOENT' !== err.code) {
                        Log.warn(
                            { error: err.message, path: info.replaced.path },
                            'Failed removing superseded physical file during hatch'
                        );
                    }
                    return callback(null, info);
                });
            },
        ],
        (err, info) => {
            if (err) {
                return cb(err);
            }

            if (!opts.dryRun) {
                Log.info(
                    {
                        area: info.externalAreaTag,
                        file: info.fileName,
                        downlinks: info.downlinks.length,
                        replaced: info.replaced ? info.replaced.fileName : undefined,
                    },
                    'Hatched file into echo'
                );
            }

            return cb(null, info);
        }
    );
}

module.exports = {
    HatchedKeywords,
    dosFileName,
    buildHatchTic,
    resolveEchoTarget,
    resolveHatchStorage,
    findReplacedEntry,
    hatch,
};
