/* jslint node: true */
'use strict';

//	ENiGMA½
const Config			= require('./config.js').config;
const Errors			= require('./enig_error.js').Errors;
const sortAreasOrConfs	= require('./conf_area_util.js').sortAreasOrConfs;
const FileEntry			= require('./file_entry.js');
const FileDb			= require('./database.js').dbs.file;
const ArchiveUtil		= require('./archive_util.js');
const CRC32				= require('./crc.js').CRC32;

//	deps
const _				= require('lodash');
const async			= require('async');
const fs			= require('fs');
const crypto		= require('crypto');
const paths			= require('path');
const temp			= require('temp').track();	//	track() cleans up temp dir/files for us
const iconv			= require('iconv-lite');

exports.getAvailableFileAreas			= getAvailableFileAreas;
exports.getSortedAvailableFileAreas		= getSortedAvailableFileAreas;
exports.getDefaultFileAreaTag			= getDefaultFileAreaTag;
exports.getFileAreaByTag				= getFileAreaByTag;
exports.getFileEntryPath				= getFileEntryPath;
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
	const areas = _.map(getAvailableFileAreas(client, options), v => v);
	sortAreasOrConfs(areas, 'area');
	return areas;
}

function getDefaultFileAreaTag(client, disableAcsCheck) {
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
		areaInfo.areaTag			= areaTag;	//	convienence!
		areaInfo.storageDirectory	= getAreaStorageDirectory(areaInfo);
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

function getFileEntryPath(fileEntry) {
	const areaInfo = getFileAreaByTag(fileEntry.areaTag);
	if(areaInfo) {
		return paths.join(areaInfo.storageDirectory, fileEntry.fileName);
	}
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

//	:TODO: This is bascially sliceAtEOF() from art.js .... DRY!
function sliceAtSauceMarker(data) {
	let eof			= data.length;
	const stopPos	= Math.max(data.length - (256), 0);	//	256 = 2 * sizeof(SAUCE)

	for(let i = eof - 1; i > stopPos; i--) {
		if(0x1a === data[i]) {
			eof = i;
			break;
		}
	}
	return data.slice(0, eof);
}

function attemptSetEstimatedReleaseDate(fileEntry) {
	//	:TODO: yearEstPatterns RegExp's should be cached - we can do this @ Config (re)load time
	const patterns	= Config.fileBase.yearEstPatterns.map( p => new RegExp(p, 'gmi'));

	function getMatch(input) {
		if(input) {
			let m;
			for(let i = 0; i < patterns.length; ++i) {
				m = patterns[i].exec(input);
				if(m) {
					return m;
				}
			}
		}
	}

	//
	//	We attempt deteciton in short -> long order
	//
	const match = getMatch(fileEntry.desc) || getMatch(fileEntry.descLong);
	if(match && match[1]) {
		let year;
		if(2 === match[1].length) {
			year = parseInt(match[1]);
			if(year) {
				if(year > 70) {
					year += 1900;
				} else {
					year += 2000;
				}
			}
		} else {
			year = parseInt(match[1]);
		}

		if(year) {
			fileEntry.meta.est_release_year = year;
		}
	}
}

function populateFileEntryWithArchive(fileEntry, filePath, archiveType, cb) {
	const archiveUtil = ArchiveUtil.getInstance();

	async.waterfall(
		[
			function getArchiveFileList(callback) {				
				archiveUtil.listEntries(filePath, archiveType, (err, entries) => {
					return callback(null, entries || []);	//	ignore any errors here	
				});
			},
			function extractDescFiles(entries, callback) {

				//	:TODO: would be nice if these RegExp's were cached
				//	:TODO: this is long winded...

				const extractList = [];

				const shortDescFile = entries.find( e => {
					return Config.fileBase.fileNamePatterns.shortDesc.find( pat => new RegExp(pat, 'i').test(e.fileName) );
				});

				if(shortDescFile) {
					extractList.push(shortDescFile.fileName);
				}

				const longDescFile = entries.find( e => {
					return Config.fileBase.fileNamePatterns.longDesc.find( pat => new RegExp(pat, 'i').test(e.fileName) );
				});

				if(longDescFile) {
					extractList.push(longDescFile.fileName);
				}

				temp.mkdir('enigextract-', (err, tempDir) => {
					if(err) {
						return callback(err);
					}

					archiveUtil.extractTo(filePath, tempDir, archiveType, extractList, err => {
						if(err) {
							return callback(err);
						}				

						const descFiles = {
							desc		: shortDescFile ? paths.join(tempDir, shortDescFile.fileName) : null,
							descLong	: longDescFile ? paths.join(tempDir, longDescFile.fileName) : null,
						};

						return callback(null, descFiles);
					});
				});
			},
			function readDescFiles(descFiles, callback) {
				//	:TODO: we shoudl probably omit files that are too large
				async.each(Object.keys(descFiles), (descType, next) => {
					const path = descFiles[descType];
					if(!path) {
						return next(null);
					}

					fs.readFile(path, (err, data) => {
						if(err || !data) {
							return next(null);
						}

						//
						//	Assume FILE_ID.DIZ, NFO files, etc. are CP437. 
						//
						//	:TODO: This isn't really always the case - how to handle this? We could do a quick detection...
						fileEntry[descType] = iconv.decode(sliceAtSauceMarker(data, 0x1a), 'cp437');
						return next(null);
					});
				}, () => {
					//	cleanup, but don't wait...
					temp.cleanup( err => {
						//	:TODO: Log me!
					});
					return callback(null);
				});
			},
			function attemptReleaseYearEstimation(callback) {
				attemptSetEstimatedReleaseDate(fileEntry);
				return callback(null);
			}
		],
		err => {
			return cb(err);
		}
	);
}

function populateFileEntry(fileEntry, filePath, archiveType, cb) {
	//	:TODO:	implement me!
	return cb(null);
}

function addNewFileEntry(fileEntry, filePath, cb) {
	const archiveUtil = ArchiveUtil.getInstance();

	//	:TODO: Use detectTypeWithBuf() once avail - we *just* read some file data

	async.series(
		[
			function populateInfo(callback) {
				archiveUtil.detectType(filePath, (err, archiveType) => {
					if(archiveType) {
						//	save this off
						fileEntry.meta.archive_type = archiveType;

						populateFileEntryWithArchive(fileEntry, filePath, archiveType, err => {
							if(err) {
								populateFileEntry(fileEntry, filePath, err => {
									//	:TODO: log err
									return callback(null);	//	ignore err
								});
							} else {
								return callback(null);
							}
						});
					} else {
						populateFileEntry(fileEntry, filePath, err => {
							//	:TODO: log err
							return callback(null);	//	ignore err
						});
					}
				});
			},
			function addNewDbRecord(callback) {
				return fileEntry.persist(callback);
			}
		],
		err => {
			return cb(err);
		}
	);
}

function updateFileEntry(fileEntry, filePath, cb) {

}

function addOrUpdateFileEntry(areaInfo, fileName, options, cb) {
	
	const fileEntry = new FileEntry({
		areaTag		: areaInfo.areaTag,
		meta		: options.meta,
		hashTags	: options.hashTags,	//	Set() or Array
		fileName	: fileName,
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
				const crc32		= new CRC32();
								
				//	:TODO: crc32

				stream.on('data', data => {
					byteSize += data.length;

					sha1.update(data);
					sha256.update(data);
					md5.update(data);
					crc32.update(data);
				});

				stream.on('end', () => {
					fileEntry.meta.byte_size = byteSize;

					//	sha-1 is in basic file entry
					fileEntry.fileSha1 = sha1.digest('hex');

					//	others are meta
					fileEntry.meta.file_sha256	= sha256.digest('hex');
					fileEntry.meta.file_md5 	= md5.digest('hex');
					fileEntry.meta.file_crc32	= crc32.finalize().toString(16);

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
			function addOrUpdate(existingEntries, callback) {
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

					async.eachSeries(files, (fileName, next) => {
						const fullPath = paths.join(areaPhysDir, fileName);

						fs.stat(fullPath, (err, stats) => {
							if(err) {
								//	:TODO: Log me!
								return next(null);	//	always try next file
							}

							if(!stats.isFile()) {
								return next(null);
							}

							addOrUpdateFileEntry(areaInfo, fileName, { areaTag : areaInfo.areaTag }, err => {
								return next(err);
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