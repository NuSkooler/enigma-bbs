/* jslint node: true */
'use strict';

//  ENiGMA½
const EnigAssert = require('./enigma_assert.js');

//  deps
const fse = require('fs-extra');
const paths = require('path');
const async = require('async');

exports.moveFileWithCollisionHandling = moveFileWithCollisionHandling;
exports.copyFileWithCollisionHandling = copyFileWithCollisionHandling;
exports.pathWithTerminatingSeparator = pathWithTerminatingSeparator;

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
            fse.move(src, tryDstPath, err => {
                return callback(err);
            });
        } else if ('copy' === operation) {
            fse.copy(src, tryDstPath, { overwrite: false, errorOnExist: true }, err => {
                return callback(err);
            });
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
                    //  for some reason fs-extra copy doesn't pass err.code
                    //  :TODO: this is dangerous: submit a PR to fs-extra to set EEXIST
                    if ('EEXIST' === err.code || 'dest already exists.' === err.message) {
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
