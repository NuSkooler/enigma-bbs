/* jslint node: true */
'use strict';

//  ENiGMA½
const EnigAssert = require('./enigma_assert.js');
const Logger = require('./logger.js');

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

function _streamCopy(src, dst, cb) {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dst);
    let done = false;
    const finish = err => {
        if (done) return;
        done = true;
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

function moveOrCopyFileWithCollisionHandling(src, dst, operation, cb) {
    operation = operation || 'copy';
    const dstPath = paths.dirname(dst);
    const dstFileExt = paths.extname(dst);
    const dstFileSuffix = paths.basename(dst, dstFileExt);

    EnigAssert('move' === operation || 'copy' === operation);

    let renameIndex = 0;
    let opOk = false;
    let tryDstPath;

    function tryOperation(src, dst, callback) {
        if ('move' === operation) {
            safeMoveFile(src, tryDstPath, err => {
                return callback(err);
            });
        } else if ('copy' === operation) {
            safeCopyFile(
                src,
                tryDstPath,
                { overwrite: false, errorOnExist: true },
                err => {
                    return callback(err);
                }
            );
        }
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
                    //  fs-extra doesn't set err.code for the errorOnExist
                    //  path, and the message format has shifted across
                    //  versions ("dest already exists." → "'<path>' already
                    //  exists"). Match on either code or any "already exists"
                    //  variant so the collision-retry loop stays robust.
                    if (
                        'EEXIST' === err.code ||
                        (err.message && /already exists/i.test(err.message))
                    ) {
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
