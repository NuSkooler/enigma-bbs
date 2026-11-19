/* jslint node: true */
'use strict';

//
//  The file scanning quarantine (#291, PR 4): listing what is in it,
//  releasing a file into a file base area, and deleting one. oputil's
//  "fb quarantine" commands are the only callers.
//
//  What is in the quarantine directory came from outside. The quarantined
//  files certainly did, and so did much of each sidecar: the original name,
//  the area, the descriptions -- an uploader or a TIC chose them. Nothing
//  read from a sidecar is trusted:
//
//    - a release goes only by a file's actual bytes: its SHA-256 must be the
//      one the sidecar recorded when it was quarantined (worked out by core,
//      never claimed by the sender), and the entry it becomes is checked
//      against it once more after the move;
//    - the name it is restored to must already be a plain, safe file name
//      (no directory part, no "..", no Windows device names, ':' or
//      trailing dots); nothing is "cleaned up" into one. A name that fails
//      needs --name;
//    - the area must be a configured, normal (not internal) area with a
//      storage location;
//    - descriptions, uploader and tags are bounded and stripped of control
//      characters again on the way out;
//    - a sidecar is matched to its file by name and content, and a .json
//      file that is itself a quarantined file (it has a sidecar of its own)
//      is never taken for another file's sidecar.
//
//  The move into the area never replaces a file (see file_util.js); a name
//  that is taken becomes NAME(1).EXT and so on.
//

//  ENiGMA½
const FileScanner = require('./file_scanner.js');
const Allowlist = require('./file_scan_allowlist.js');
const { Errors } = require('./enig_error.js');
const { moveFileWithCollisionHandling, isWindowsDeviceName } = require('./file_util.js');

//  Read through config.js; see core/user_time.js.
const configModule = require('./config.js');
const Config = () => configModule.get();

//  deps
const _ = require('lodash');
const fs = require('graceful-fs');
const paths = require('path');
const crypto = require('crypto');

exports.listQuarantine = listQuarantine;
exports.findQuarantined = findQuarantined;
exports.releaseNameProblem = releaseNameProblem;
exports.resolveReleaseArea = resolveReleaseArea;
exports.releaseQuarantined = releaseQuarantined;
exports.deleteQuarantined = deleteQuarantined;

//  A sidecar is a few KB; anything much bigger is not one.
const MAX_SIDECAR_BYTES = 1024 * 1024;
//  Longest name a release restores, in bytes; as for quarantine names.
const MAX_RELEASE_NAME_BYTES = 200;

//  oputil runs without the logger until it has initialized it.
function log(level, obj, msg) {
    const Log = require('./logger.js').log;
    if (Log && _.isFunction(Log[level])) {
        return Log[level](obj, msg);
    }
}

//  The sidecar names writeSidecar() gives |quarantineName|: NAME.json, then
//  NAME.1.json, NAME.2.json, ... when that is taken.
function isSidecarNameFor(sidecarName, quarantineName) {
    if (sidecarName === `${quarantineName}.json`) {
        return true;
    }
    if (!sidecarName.startsWith(`${quarantineName}.`) || !sidecarName.endsWith('.json')) {
        return false;
    }
    const middle = sidecarName.slice(quarantineName.length + 1, -'.json'.length);
    return /^[1-9][0-9]{0,2}$/.test(middle);
}

function readSidecar(sidecarPath, cb) {
    fs.readFile(sidecarPath, 'utf8', (err, text) => {
        if (err) {
            return cb(err);
        }
        try {
            const data = JSON.parse(text);
            return cb(null, _.isPlainObject(data) ? data : null);
        } catch (e) {
            return cb(null, null);
        }
    });
}

//
//  Calls back (err, items), sorted by name. Each item:
//  {
//      quarantineName, path,
//      exists:         the quarantined file is there (false: only a sidecar
//                      is left)
//      byteSize, mtime:    of the file, when it exists
//      sidecar:        the parsed sidecar, or null
//      sidecarPath:    its path, when there is exactly one
//      sidecarProblem: why there is no sidecar: 'missing' or 'ambiguous'
//                      (more than one claims the file)
//  }
//
//  A quarantine directory that does not exist is an empty list. Anything in
//  it that is not a regular file (a directory, a symbolic link) is left out.
//
function listQuarantine(cb) {
    const dir = FileScanner.getQuarantinePath();

    fs.readdir(dir, (err, names) => {
        if (err) {
            return 'ENOENT' === err.code ? cb(null, []) : cb(err);
        }

        const files = new Map(); //  name -> stats, regular files only
        let pending = names.length;
        if (0 === pending) {
            return cb(null, []);
        }

        names.forEach(name => {
            fs.lstat(paths.join(dir, name), (err, stats) => {
                if (!err && stats.isFile()) {
                    files.set(name, stats);
                }
                if (0 === --pending) {
                    return parseSidecars(dir, files, cb);
                }
            });
        });
    });
}

function parseSidecars(dir, files, cb) {
    const jsonNames = Array.from(files.keys()).filter(
        n => n.endsWith('.json') && files.get(n).size <= MAX_SIDECAR_BYTES
    );

    //  sidecar name -> the quarantine name it claims
    const claims = new Map();
    const parsed = new Map();
    let pending = jsonNames.length;

    const done = () => {
        //
        //  A .json file that a sidecar claims is a quarantined file, so it
        //  is not itself a sidecar, whatever it says: an uploader can send
        //  "EVIL.json" with sidecar-looking content.
        //
        const claimed = new Set(claims.values());
        const byFile = new Map(); //  quarantine name -> [ sidecar names ]
        claims.forEach((quarantineName, sidecarName) => {
            if (claimed.has(sidecarName)) {
                return;
            }
            if (!byFile.has(quarantineName)) {
                byFile.set(quarantineName, []);
            }
            byFile.get(quarantineName).push(sidecarName);
        });

        const sidecarNames = new Set(_.flatten(Array.from(byFile.values())));
        const items = [];

        const itemFor = (quarantineName, stats) => {
            const candidates = byFile.get(quarantineName) || [];
            const item = {
                quarantineName,
                path: paths.join(dir, quarantineName),
                exists: !!stats,
                byteSize: stats ? stats.size : undefined,
                mtime: stats ? stats.mtime : undefined,
                sidecar: null,
            };
            if (1 === candidates.length) {
                item.sidecarPath = paths.join(dir, candidates[0]);
                item.sidecar = parsed.get(candidates[0]);
            } else {
                item.sidecarProblem = 0 === candidates.length ? 'missing' : 'ambiguous';
            }
            return item;
        };

        files.forEach((stats, name) => {
            if (!sidecarNames.has(name)) {
                items.push(itemFor(name, stats));
            }
        });

        //  sidecars whose file is gone
        byFile.forEach((candidates, quarantineName) => {
            if (!files.has(quarantineName)) {
                items.push(itemFor(quarantineName, null));
            }
        });

        items.sort((a, b) => a.quarantineName.localeCompare(b.quarantineName));
        return cb(null, items);
    };

    if (0 === pending) {
        return done();
    }

    jsonNames.forEach(name => {
        readSidecar(paths.join(dir, name), (err, data) => {
            const quarantineName = data && data.quarantineName;
            if (
                !err &&
                _.isString(quarantineName) &&
                quarantineName &&
                quarantineName === paths.basename(quarantineName) &&
                isSidecarNameFor(name, quarantineName)
            ) {
                claims.set(name, quarantineName);
                parsed.set(name, data);
            }
            if (0 === --pending) {
                return done();
            }
        });
    });
}

//  The quarantine item named |name| exactly, or null. Calls back (err, item).
function findQuarantined(name, cb) {
    if (
        !_.isString(name) ||
        !name ||
        name !== paths.basename(name) ||
        /[\\/]/.test(name)
    ) {
        return cb(
            Errors.Invalid(
                'Give the quarantined file\'s name, as "fb quarantine list" shows it'
            )
        );
    }
    listQuarantine((err, items) => {
        if (err) {
            return cb(err);
        }
        return cb(
            null,
            items.find(i => i.quarantineName === name)
        );
    });
}

//
//  Why |name| cannot be what a released file is called, or null if it can.
//  Nothing is fixed up: a name that came from outside either is a plain,
//  safe file name as it stands or is refused.
//
function releaseNameProblem(name) {
    if (!_.isString(name) || !name) {
        return 'there is no name';
    }
    if (/[\\/]/.test(name)) {
        return 'it has a directory part';
    }
    if ('.' === name || '..' === name) {
        return 'it is not a file name';
    }
    if (name.startsWith('.')) {
        return 'it starts with a dot';
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
        return 'it has control characters';
    }
    if (/[<>:"|?*]/.test(name)) {
        return 'it has characters Windows does not allow (< > : " | ? *)';
    }
    if (/[. ]$/.test(name)) {
        return 'it ends with a dot or a space';
    }
    if (isWindowsDeviceName(name)) {
        return 'it is a name Windows reserves for a device';
    }
    if (Buffer.byteLength(name) > MAX_RELEASE_NAME_BYTES) {
        return `it is longer than ${MAX_RELEASE_NAME_BYTES} bytes`;
    }
    return null;
}

//
//  The area a file is released into: a configured, normal file base area
//  (not an internal one) with a storage location. |preferStorageTag| is
//  used if it is one of the area's own. Calls back (err, { areaInfo,
//  storageTag, storageDir }).
//
function resolveReleaseArea(areaTag, preferStorageTag, cb) {
    const FileArea = require('./file_base_area.js');
    const areas = _.get(Config(), 'fileBase.areas') || {};

    //  own properties only: "__proto__" or "constructor" from a sidecar must
    //  not find (or touch) anything
    if (
        !_.isString(areaTag) ||
        !areaTag ||
        !Object.prototype.hasOwnProperty.call(areas, areaTag) ||
        !_.isPlainObject(areas[areaTag])
    ) {
        return cb(Errors.DoesNotExist(`No file base area "${areaTag}"`));
    }
    if (FileArea.isInternalArea(areaTag)) {
        return cb(Errors.Invalid(`"${areaTag}" is an internal area`));
    }

    const areaInfo = FileArea.getFileAreaByTag(areaTag);
    const storageTags = (
        Array.isArray(areaInfo.storageTags)
            ? areaInfo.storageTags
            : [areaInfo.storageTags]
    ).filter(t => _.isString(t) && FileArea.isValidStorageTag(t));

    if (0 === storageTags.length) {
        return cb(Errors.MissingConfig(`Area "${areaTag}" has no valid storage tag`));
    }

    const storageTag = storageTags.includes(preferStorageTag)
        ? preferStorageTag
        : storageTags[0];

    return cb(null, {
        areaInfo,
        storageTag,
        storageDir: FileArea.getAreaStorageDirectoryByTag(storageTag),
    });
}

//  Not following a final symbolic link.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

//  SHA-256 of the regular file at |filePath|, read without following a link.
function hashRegularFile(filePath, cb) {
    fs.open(filePath, OPEN_FLAGS, (err, fd) => {
        if (err) {
            return cb(err);
        }
        const close = (err, result) => fs.close(fd, () => cb(err, result));
        fs.fstat(fd, (err, stats) => {
            if (err) {
                return close(err);
            }
            if (!stats.isFile()) {
                return close(Errors.Invalid('Not a regular file'));
            }
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(null, { fd, autoClose: false, start: 0 });
            stream.on('data', chunk => hash.update(chunk));
            stream.on('error', err => close(err));
            stream.on('end', () => close(null, hash.digest('hex')));
        });
    });
}

//
//  The details a sidecar kept, made safe again (the sidecar may have been
//  edited): what the entry gets.
//
function releaseDetails(sidecar) {
    const own = (obj, name) =>
        _.isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, name)
            ? obj[name]
            : undefined;

    //  an upload's uploader and a passthrough TIC's details come from the
    //  fields sidecars have always had; |meta| (newer sidecars) wins
    const user = sidecar.user;
    const tic = sidecar.ticInfo;
    const shortFileName = own(tic, 'shortFileName');
    const fallback = {
        upload_by_username: own(user, 'name'),
        upload_by_user_id: own(user, 'id'),
        tic_origin: own(tic, 'origin'),
        tic_desc: own(tic, 'desc'),
        tic_ldesc: own(tic, 'ldesc'),
        short_file_name: _.isString(shortFileName)
            ? shortFileName.toUpperCase()
            : undefined,
    };
    const entryMeta = {};
    Object.keys(fallback).forEach(name => {
        const v = own(sidecar.meta, name);
        entryMeta[name] = _.isNil(v) || '' === v ? fallback[name] : v;
    });

    const details = FileScanner.sanitizeSidecarDetails({
        desc: sidecar.desc,
        storageTag: sidecar.storageTag,
        hashTags: sidecar.hashTags,
        entryMeta,
    });

    const meta = details.meta || {};
    if (meta.upload_by_user_id && !/^[0-9]{1,10}$/.test(meta.upload_by_user_id)) {
        delete meta.upload_by_user_id;
    }

    return {
        desc: details.desc,
        hashTags: details.hashTags,
        storageTag: details.storageTag,
        meta,
    };
}

function moveBack(filePath, quarantineName, cb) {
    const back = paths.join(FileScanner.getQuarantinePath(), quarantineName);
    moveFileWithCollisionHandling(filePath, back, (err, movedTo) => {
        if (err) {
            log(
                'error',
                { path: filePath, error: err.message },
                'Could not move a file being released back into quarantine'
            );
        }
        return cb(err, movedTo);
    });
}

//
//  Releases quarantined file |name| into a file base area.
//
//  options: {
//      operator:   who is releasing it (logged, and recorded with --allow)
//      areaTag:    the area; default: the one in the sidecar
//      fileName:   the name it gets; default: its original name
//      allow:      also add its SHA-256 to the allowlist
//      note:       the allowlist note
//  }
//
//  Calls back (err, { fileEntry, path, sha256, allowlisted, allowlistAdded }).
//  On an error nothing has changed -- except that, with |allow|, the hash
//  stays on the allowlist once it was added (it is the operator's decision
//  about those bytes, not about this release).
//
function releaseQuarantined(name, options, cb) {
    options = options || {};
    const operator = options.operator || 'unknown';
    const state = {};

    const fail = err => cb(err);

    findQuarantined(name, (err, item) => {
        if (err) {
            return fail(err);
        }
        if (!item || !item.exists) {
            return fail(Errors.DoesNotExist(`No quarantined file named "${name}"`));
        }
        if (!item.sidecar) {
            return fail(
                Errors.Invalid(
                    'ambiguous' === item.sidecarProblem
                        ? `More than one sidecar claims "${name}"; release it by hand`
                        : `"${name}" has no sidecar, so there is nothing to check it against; release it by hand`
                )
            );
        }

        const sidecar = item.sidecar;
        const sha256 = Allowlist.normalizeSha256(sidecar.sha256);
        if (!sha256) {
            return fail(Errors.Invalid(`The sidecar of "${name}" has no valid SHA-256`));
        }

        const fileName = _.isUndefined(options.fileName)
            ? sidecar.originalName
            : options.fileName;
        const nameProblem = releaseNameProblem(fileName);
        if (nameProblem) {
            return fail(
                Errors.Invalid(
                    _.isUndefined(options.fileName)
                        ? `Its original name cannot be used: ${nameProblem}. Give one with --name`
                        : `--name cannot be used: ${nameProblem}`
                )
            );
        }

        const areaTag = _.isUndefined(options.areaTag)
            ? sidecar.areaTag
            : options.areaTag;
        if (_.isNil(areaTag) || '' === areaTag) {
            return fail(
                Errors.MissingParam(
                    'The sidecar names no area (a passthrough TIC, say); give one with --area'
                )
            );
        }

        const details = releaseDetails(sidecar);

        resolveReleaseArea(areaTag, details.storageTag, (err, area) => {
            if (err) {
                return fail(err);
            }

            hashRegularFile(item.path, (err, actual) => {
                if (err) {
                    return fail(err);
                }
                if (actual !== sha256) {
                    return fail(
                        Errors.Invalid(
                            `"${name}" is not the file that was quarantined: its SHA-256 is ${actual}, the sidecar says ${sha256}`
                        )
                    );
                }

                Allowlist.getFileIdsBySha256(sha256, (err, existing) => {
                    if (err) {
                        return fail(err);
                    }
                    if (existing.length > 0) {
                        return fail(
                            Errors.Duplicate(
                                `The file base already has this file (file ID ${existing.join(', ')}). Delete the quarantined copy with "fb quarantine delete", and mark the entry safe with "fb mark-safe" if it was a false positive`
                            )
                        );
                    }

                    state.item = item;
                    state.sidecar = sidecar;
                    state.sha256 = sha256;
                    state.fileName = fileName;
                    state.area = area;
                    state.details = details;
                    return allowThenImport(state, options, operator, cb);
                });
            });
        });
    });
}

function allowThenImport(state, options, operator, cb) {
    if (!options.allow) {
        return importReleased(state, options, operator, cb);
    }

    Allowlist.add(
        {
            sha256: state.sha256,
            addedBy: operator,
            note: options.note,
            originalName: state.sidecar.originalName,
            signature: state.sidecar.signature,
        },
        (err, res) => {
            if (err) {
                return cb(err);
            }
            state.allowlistAdded = res.added;
            return importReleased(state, options, operator, cb);
        }
    );
}

function importReleased(state, options, operator, cb) {
    const FileArea = require('./file_base_area.js');
    const { item, area, details, sha256 } = state;

    const destPath = paths.join(area.storageDir, state.fileName);
    const storageDir = paths.resolve(area.storageDir);
    if (!paths.resolve(destPath).startsWith(storageDir + paths.sep)) {
        return cb(Errors.Invalid('The release path is outside the storage directory'));
    }

    moveFileWithCollisionHandling(item.path, destPath, (err, finalPath) => {
        if (err) {
            return cb(err);
        }

        const undo = err => moveBack(finalPath, item.quarantineName, () => cb(err));

        //  an ordinary file again: quarantine left it 0600. Never executable.
        //  Best effort (Windows has no such bits).
        fs.chmod(finalPath, 0o666 & ~process.umask(), () => {
            //  no scanSource: it is not virus scanned again (the allowlist, if
            //  asked for, already covers it for any later scan)
            FileArea.scanFile(
                finalPath,
                {
                    areaTag: area.areaInfo.areaTag,
                    storageTag: area.storageTag,
                    hashTags: details.hashTags
                        ? new Set(details.hashTags)
                        : area.areaInfo.hashTags,
                },
                (err, fileEntry) => {
                    if (err) {
                        return undo(err);
                    }
                    if (fileEntry.fileSha256 !== sha256) {
                        return undo(
                            Errors.Invalid(
                                'The file changed while it was being released; it is back in quarantine'
                            )
                        );
                    }

                    const now = new Date().toISOString();
                    fileEntry.areaTag = area.areaInfo.areaTag;
                    fileEntry.storageTag = area.storageTag;
                    fileEntry.fileName = paths.basename(finalPath);

                    const meta = details.meta;
                    if (details.desc) {
                        fileEntry.desc = details.desc;
                    } else if (!fileEntry.desc || 'fileName' === fileEntry.descSrc) {
                        fileEntry.desc =
                            meta.tic_ldesc || meta.tic_desc || fileEntry.desc;
                    }

                    Object.assign(fileEntry.meta, meta, {
                        quarantine_released_at: now,
                        quarantine_released_by: operator,
                    });
                    if (options.allow) {
                        Object.assign(fileEntry.meta, {
                            scan_result: FileScanner.Verdicts.Clean,
                            scanner: Allowlist.ScannerName,
                            scanned_at: now,
                        });
                    }

                    fileEntry.persist(err => {
                        if (err) {
                            return undo(err);
                        }

                        fs.unlink(item.sidecarPath, unlinkErr => {
                            if (unlinkErr) {
                                log(
                                    'warn',
                                    { path: item.sidecarPath, error: unlinkErr.message },
                                    'Released a quarantined file but could not remove its sidecar'
                                );
                            }

                            log(
                                'info',
                                {
                                    operator,
                                    quarantineName: item.quarantineName,
                                    fileId: fileEntry.fileId,
                                    areaTag: fileEntry.areaTag,
                                    fileName: fileEntry.fileName,
                                    sha256,
                                    allowlisted: !!options.allow,
                                },
                                'Released a file from quarantine'
                            );

                            return cb(null, {
                                fileEntry,
                                path: finalPath,
                                sha256,
                                allowlisted: !!options.allow,
                                allowlistAdded: !!state.allowlistAdded,
                                sidecarError: unlinkErr ? unlinkErr.message : undefined,
                            });
                        });
                    });
                }
            );
        });
    });
}

//
//  Deletes quarantined file |name| and its sidecar; either may already be
//  gone. Calls back (err, { removed: [ paths ] }).
//
function deleteQuarantined(name, operator, cb) {
    findQuarantined(name, (err, item) => {
        if (err) {
            return cb(err);
        }
        if (!item) {
            return cb(Errors.DoesNotExist(`No quarantined file named "${name}"`));
        }

        const targets = [item.exists ? item.path : null, item.sidecarPath].filter(
            Boolean
        );
        const removed = [];
        const next = i => {
            if (i >= targets.length) {
                log(
                    'info',
                    {
                        operator: operator || 'unknown',
                        quarantineName: item.quarantineName,
                        sha256: _.get(item, 'sidecar.sha256'),
                        removed,
                    },
                    'Deleted a file from quarantine'
                );
                return cb(null, { removed, item });
            }
            fs.unlink(targets[i], err => {
                if (err && 'ENOENT' !== err.code) {
                    return cb(err);
                }
                removed.push(targets[i]);
                return next(i + 1);
            });
        };
        return next(0);
    });
}
