/* jslint node: true */
'use strict';

//	ENiGMA½

//	deps
const fse		= require('fs-extra');
const paths		= require('path');
const async		= require('async');

exports.moveFileWithCollisionHandling		= moveFileWithCollisionHandling;
exports.pathWithTerminatingSeparator		= pathWithTerminatingSeparator;

//
//	Move |src| -> |dst| renaming to file(1).ext, file(2).ext, etc. 
//	in the case of collisions.
//
function moveFileWithCollisionHandling(src, dst, cb) {	
	const dstPath		= paths.dirname(dst);
	const dstFileExt	= paths.extname(dst);
	const dstFileSuffix	= paths.basename(dst, dstFileExt);

	let renameIndex		= 0;
	let movedOk			= false;
	let tryDstPath;

	async.until(
		() => movedOk,	//	until moved OK
		(cb) => {
			if(0 === renameIndex) {
				//	try originally supplied path first
				tryDstPath = dst;
			} else {
				tryDstPath = paths.join(dstPath, `${dstFileSuffix}(${renameIndex})${dstFileExt}`);
			}

			fse.move(src, tryDstPath, err => {
				if(err) {
					if('EEXIST' === err.code) {
						renameIndex += 1;
						return cb(null);	//	keep trying
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

function pathWithTerminatingSeparator(path) {
	if(path && paths.sep !== path.charAt(path.length - 1)) {
		path = path + paths.sep;
	}
	return path;
}
