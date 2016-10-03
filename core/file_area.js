/* jslint node: true */
'use strict';

//	ENiGMA½
const Config			= require('./config.js').config;
const Errors			= require('./enig_error.js').Errors;
const sortAreasOrConfs	= require('./conf_area_util.js').sortAreasOrConfs;
const FileEntry			= require('./file_entry.js');
const FileDb			= require('./database.js').dbs.file;
const ArchiveUtil		= require('./archive_util.js');

//	deps
const _				= require('lodash');
const async			= require('async');
const fs			= require('fs');
const crypto		= require('crypto');
const paths			= require('path');

exports.getAvailableFileAreas			= getAvailableFileAreas;
exports.getSortedAvailableFileAreas		= getSortedAvailableFileAreas;
exports.getDefaultFileArea				= getDefaultFileArea;
exports.getFileAreaByTag				= getFileAreaByTag;
exports.changeFileAreaWithOptions		= changeFileAreaWithOptions;
//exports.addOrUpdateFileEntry			= addOrUpdateFileEntry;
exports.scanFileAreaForChanges			= scanFileAreaForChanges;

const WellKnownAreaTags					= exports.WellKnownAreaTags = {
	Invalid				: '',
	MessageAreaAttach	: 'message_area_attach',
};

function getAvailableFileAreas(client, options) {
	options = options || { includeSystemInternal : false };

	//	perform ACS check per conf & omit system_internal if desired
	return _.omit(Config.fileAreas.areas, (area, areaTag) => {        
		if(!options.includeSystemInternal && WellKnownAreaTags.MessageAreaAttach === areaTag) {
			return true;
		}

		return !client.acs.hasFileAreaRead(area);
	});
}

function getSortedAvailableFileAreas(client, options) {
	const areas = _.map(getAvailableFileAreas(client, options), (v, k) => { 
		return {
			areaTag : k,
			area	: v
		};
	});

	sortAreasOrConfs(areas, 'area');
	return areas;
}

function getDefaultFileArea(client, disableAcsCheck) {
	let defaultArea = _.findKey(Config.fileAreas, o => o.default);
	if(defaultArea) {
		const area = Config.fileAreas.areas[defaultArea];
		if(true === disableAcsCheck || client.acs.hasFileAreaRead(area)) {
			return defaultArea;
		}
	}

	//  just use anything we can
	defaultArea = _.findKey(Config.fileAreas.areas, (area, areaTag) => {
		return WellKnownAreaTags.MessageAreaAttach !== areaTag && (true === disableAcsCheck || client.acs.hasFileAreaRead(area));
	});
    
	return defaultArea;
}

function getFileAreaByTag(areaTag) {
	const areaInfo = Config.fileAreas.areas[areaTag];
	if(areaInfo) {
		areaInfo.areaTag = areaTag;	//	convienence!
		return areaInfo;
	}
}

function changeFileAreaWithOptions(client, areaTag, options, cb) {
	async.waterfall(
		[
			function getArea(callback) {
				const area = getFileAreaByTag(areaTag);
				return callback(area ? null : Errors.Invalid('Invalid file areaTag'), area);
			},
			function validateAccess(area, callback) {
				if(!client.acs.hasFileAreaRead(area)) {
					return callback(Errors.AccessDenied('No access to this area'));
				}
			},
			function changeArea(area, callback) {
				if(true === options.persist) {
					client.user.persistProperty('file_area_tag', areaTag, err => {
						return callback(err, area);
					});
				} else {
					client.user.properties['file_area_tag'] = areaTag;
					return callback(null, area);
				}
			}
		],
		(err, area) => {
			if(!err) {
				client.log.info( { areaTag : areaTag, area : area }, 'Current file area changed');
			} else {
				client.log.warn( { areaTag : areaTag, area : area, error : err.message }, 'Could not change file area');
			}

			return cb(err);
		}
	);
}

function getAreaStorageDirectory(areaInfo) {
	return paths.join(Config.fileBase.areaStoragePrefix, areaInfo.storageDir || '');
}

function getExistingFileEntriesBySha1(sha1, cb) {
	const entries = [];

	FileDb.each(
		`SELECT file_id, area_tag
		FROM file
		WHERE file_sha1=?;`,
		[ sha1 ],
		(err, fileRow) => {
			if(fileRow) {
				entries.push({
					fileId	: fileRow.file_id,
					areaTag	: fileRow.area_tag,
				});
			}
		},
		err => {
			return cb(err, entries);
		}
	);
}

function addNewArchiveFileEnty(fileEntry, filePath, archiveType, cb) {
	async.series(
		[
			function getArchiveFileList(callback) {
				//	:TODO: get list of files in archive
				return callback(null);
			}
		],
		err => {
			return cb(err);
		}
	);
}

function addNewFileEntry(fileEntry, filePath, cb) {
	const archiveUtil = ArchiveUtil.getInstance();

	//	:TODO: Use detectTypeWithBuf() once avail - we *just* read some file data
	archiveUtil.detectType(filePath, (err, archiveType) => {
		if(archiveType) {
			return addNewArchiveFileEnty(fileEntry, filePath, archiveType, cb);
		} else {
			//	:TODO:addNewNonArchiveFileEntry
		}
	});
}

function addOrUpdateFileEntry(areaInfo, fileName, options, cb) {
	
	const fileEntry = new FileEntry({
		areaTag		: areaInfo.areaTag,
		meta		: options.meta,
		hashTags	: options.hashTags,	//	Set() or Array
	});

	const filePath	= paths.join(getAreaStorageDirectory(areaInfo), fileName);

	async.waterfall(
		[
			function processPhysicalFile(callback) {			
				const stream = fs.createReadStream(filePath);

				let byteSize	= 0;
				const sha1		= crypto.createHash('sha1');
				const sha256	= crypto.createHash('sha256');
				const md5		= crypto.createHash('md5');
				
				
				//	:TODO: crc32

				stream.on('data', data => {
					byteSize += data.length;

					sha1.update(data);
					sha256.update(data);
					md5.update(data);					
				});

				stream.on('end', () => {
					fileEntry.meta.byte_size = byteSize;

					//	sha-1 is in basic file entry
					fileEntry.fileSha1 = sha1.digest('hex');

					//	others are meta
					fileEntry.meta.file_sha256	= sha256.digest('hex');
					fileEntry.meta.file_md5 	= md5.digest('hex');

					return callback(null);
				});

				stream.on('error', err => {
					return callback(err);
				});
			},
			function fetchExistingEntry(callback) {
				getExistingFileEntriesBySha1(fileEntry.fileSha1, (err, existingEntries) => {
					return callback(err, existingEntries);
				});
			},
			function addOrUpdate(callback, existingEntries) {
				if(existingEntries.length > 0) {

				} else {
					return addNewFileEntry(fileEntry, filePath, callback);
				}
			}, 
		],		
		err => {
			return cb(err);
		}
	);
}

function scanFileAreaForChanges(areaInfo, cb) {
	const areaPhysDir = getAreaStorageDirectory(areaInfo);

	async.series(
		[
			function scanPhysFiles(callback) {
				fs.readdir(areaPhysDir, (err, files) => {
					if(err) {
						return callback(err);
					}

					async.each(files, (fileName, next) => {
						const fullPath = paths.join(areaPhysDir, fileName);

						fs.stat(fullPath, (err, stats) => {
							if(err) {
								//	:TODO: Log me!
								return next(null);	//	always try next file
							}

							if(!stats.isFile()) {
								return next(null);
							}

							addOrUpdateFileEntry(areaInfo, fileName, err => {

							});
						});
					}, err => {
						return callback(err);
					});
				});
			},
			function scanDbEntries(callback) {
				//	:TODO: Look @ db entries for area that were *not* processed above
				return callback(null);
			}
		],
		err => {
			return cb(err);
		}
	);
}