/* jslint node: true */
'use strict';

//  ENiGMA½
const EnigAssert = require('./enigma_assert.js');
const Logger = require('./logger.js');
const { Errors } = require('./enig_error.js');

//  deps
const fs = require('graceful-fs');
const fse = require('fs-extra');
const paths = require('path');
const async = require('async');

exports.moveFileWithCollisionHandling = moveFileWithCollisionHandling;
exports.copyFileWithCollisionHandling = copyFileWithCollisionHandling;
exports.safeCopyFile = safeCopyFile;
exports.safeMoveFile = safeMoveFile;
exports.pathWithTerminatingSeparator = pathWithTerminatingSeparator;
exports.endWriteStream = endWriteStream;
exports.isWindowsDeviceName = isWindowsDeviceName;

//
//  Is |fileName| one of the names Windows reserves for a device -- CON, PRN,
//  AUX, NUL, COM0-9, LPT0-9 (and the superscript-digit forms) -- with or
//  without an extension, in any case? "NUL.ZIP" and "con .txt" open the
//  device, not a file, so such a name must never reach a path on Windows.
//
const WINDOWS_DEVICE_NAME_RE =
    /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

function isWindowsDeviceName(fileName) {
    const base = String(fileName || '')
        .replace(/[. ]+$/, '') //  dropped by Windows
        .split('.')[0]
        .replace(/ +$/, '');
    return WINDOWS_DEVICE_NAME_RE.test(base);
}

//
//  fs.copyFile / fs-extra.copy both invoke utimensat() on the destination to
//  preserve the source mtime. Some filesystems — notably CIFS/SMB mounts
//  without the WRITE_ATTRIBUTES ACL — reject utimensat with EPERM even when
//  the data write itself succeeds; Node then rolls back the partial copy and
//  surfaces EPERM. safeCopyFile / safeMoveFile retry with a stream-based copy
//  on EPERM, which skips metadata preservation entirely. Source mtime is
//  lost on the destination, but the file is correctly delivered.
//
function safeCopyFile(src, dst, options, cb) {
    if (typeof options === 'function') {
        cb = options;
        options = {};
    }
    options = options || {};

    fse.copy(src, dst, options, err => {
        if (!err || err.code !== 'EPERM') {
            return cb(err);
        }
        if (Logger.log) {
            Logger.log.debug(
                { src, dst },
                'fs-extra copy hit EPERM; retrying with stream copy (no utimens)'
            );
        }
        _streamCopyRespectingOverwrite(src, dst, options, cb);
    });
}

function safeMoveFile(src, dst, options, cb) {
    if (typeof options === 'function') {
        cb = options;
        options = {};
    }
    options = options || {};

    fse.move(src, dst, options, err => {
        if (!err || err.code !== 'EPERM') {
            return cb(err);
        }
        if (Logger.log) {
            Logger.log.debug(
                { src, dst },
                'fs-extra move hit EPERM; retrying with stream copy + unlink'
            );
        }
        _streamCopyRespectingOverwrite(src, dst, options, e => {
            if (e) {
                return cb(e);
            }
            //  Best-effort unlink of source; data is already at dst.
            fs.unlink(src, unlinkErr => {
                if (unlinkErr && Logger.log) {
                    Logger.log.warn(
                        { src, error: unlinkErr.message },
                        'Failed to unlink source after stream-fallback move'
                    );
                }
                return cb(null);
            });
        });
    });
}

function _streamCopyRespectingOverwrite(src, dst, options, cb) {
    //  Mirror fs-extra's overwrite/errorOnExist semantics, since the original
    //  call we're standing in for relied on them.
    fs.stat(dst, statErr => {
        const exists = !statErr;
        if (exists && options.errorOnExist) {
            const e = new Error('dest already exists.');
            e.code = 'EEXIST';
            return cb(e);
        }
        if (exists && options.overwrite === false) {
            return cb(null); //  fs-extra behavior: silently skip
        }
        _streamCopy(src, dst, cb);
    });
}

function _streamCopy(src, dst, cb, writeOptions) {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dst, writeOptions);
    let done = false;
    const finish = err => {
        if (done) return;
        done = true;
        if (err && 'EEXIST' === err.code) {
            rs.destroy();
            return cb(err); //  exclusive, and not ours to remove
        }
        if (err) {
            //  Best-effort cleanup of partial dst on failure.
            fs.unlink(dst, () => cb(err));
        } else {
            cb(null);
        }
    };
    rs.on('error', finish);
    ws.on('error', finish);
    ws.on('close', () => finish(null));
    rs.pipe(ws);
}

//
//  Finishing a write stream means waiting for 'close', but a stream that has
//  already failed will never emit it again: the error fired earlier and the
//  stream destroyed itself, taking 'close' with it. A listener attached after
//  that waits forever, and whatever was driving the stream is never answered.
//
//  Answer exactly once on either event, and refuse a stream that is already
//  gone rather than waiting on it.
//
function endWriteStream(ws, cb) {
    let done = false;
    const finish = err => {
        if (done) {
            return;
        }
        done = true;
        return cb(err || null);
    };

    if (ws.destroyed) {
        return finish(Errors.General('Stream closed before it could be finished'));
    }

    ws.once('error', finish);
    ws.once('close', () => finish(null));
    ws.end();
}

//
//  Errors from fs.link() that mean "no hard link here", not "no": another
//  volume, a file system without hard links (FAT, some network shares), a
//  platform or sandbox that refuses them. The copy fallback takes over.
//
const NO_LINK_CODES = ['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'];

//
//  Copies |src| to |dst| without ever replacing |dst|: an existing |dst| is
//  an EEXIST error, decided by the file system, not by a check made earlier.
//  Falls back to a stream copy (also exclusive) on EPERM; see safeCopyFile().
//
function _exclusiveCopy(src, dst, cb) {
    fs.copyFile(src, dst, fs.constants.COPYFILE_EXCL, err => {
        if (!err || 'EPERM' !== err.code) {
            return cb(err);
        }
        _streamCopy(src, dst, cb, { flags: 'wx' });
    });
}

//
//  Moves |src| to |dst| without ever replacing |dst|. A plain rename()
//  replaces whatever is there, so an "exists?" check before it is a race:
//  two callers moving "same.zip" both see the name free and the second
//  rename overwrites the first file. link() fails with EEXIST instead, so
//  the name is claimed atomically; the source is then unlinked. Where hard
//  links are not available the copy fallback is exclusive the same way.
//
//  If the source cannot be removed afterwards the move has not happened:
//  the new name is removed again and the error returned.
//
function _moveNoReplace(src, dst, cb) {
    const removeSource = () => {
        fs.unlink(src, unlinkErr => {
            if (!unlinkErr) {
                return cb(null);
            }
            fs.unlink(dst, () => cb(unlinkErr));
        });
    };

    fs.link(src, dst, err => {
        if (!err) {
            return removeSource();
        }
        if (!NO_LINK_CODES.includes(err.code)) {
            return cb(err); //  EEXIST included: the caller tries the next name
        }
        _exclusiveCopy(src, dst, err => {
            if (err) {
                return cb(err);
            }
            return removeSource();
        });
    });
}

function moveOrCopyFileWithCollisionHandling(src, dst, operation, cb) {
    operation = operation || 'copy';
    const dstPath = paths.dirname(dst);
    const dstFileExt = paths.extname(dst);
    const dstFileSuffix = paths.basename(dst, dstFileExt);

    EnigAssert('move' === operation || 'copy' === operation);

    let renameIndex = 0;
    let opOk = false;
    let tryDstPath;

    //
    //  Neither ever replaces an existing file: see _moveNoReplace(). Like the
    //  fs-extra move/copy they stand in for, both create the destination
    //  directory if it is missing (on ENOENT, then try once more: an ENOENT
    //  that persists is a missing source).
    //
    function tryOperation(src, dst, callback) {
        const attempt = cb =>
            'move' === operation
                ? _moveNoReplace(src, dst, cb)
                : _exclusiveCopy(src, dst, cb);

        attempt(err => {
            if (!err || 'ENOENT' !== err.code) {
                return callback(err);
            }
            fse.mkdirs(paths.dirname(dst), mkdirErr => {
                if (mkdirErr) {
                    return callback(err);
                }
                return attempt(callback);
            });
        });
    }

    async.until(
        callback => callback(null, opOk), //  until moved OK
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

            tryOperation(src, tryDstPath, err => {
                if (err) {
                    if ('EEXIST' === err.code) {
                        renameIndex += 1;
                        return cb(null); //  keep trying
                    }

                    return cb(err);
                }

                opOk = true;
                return cb(null, tryDstPath);
            });
        },
        (err, finalPath) => {
            return cb(err, finalPath);
        }
    );
}

//
//  Move |src| -> |dst| renaming to file(1).ext, file(2).ext, etc.
//  in the case of collisions.
//
function moveFileWithCollisionHandling(src, dst, cb) {
    return moveOrCopyFileWithCollisionHandling(src, dst, 'move', cb);
}

function copyFileWithCollisionHandling(src, dst, cb) {
    return moveOrCopyFileWithCollisionHandling(src, dst, 'copy', cb);
}

function pathWithTerminatingSeparator(path) {
    if (path && paths.sep !== path.charAt(path.length - 1)) {
        path = path + paths.sep;
    }
    return path;
}
