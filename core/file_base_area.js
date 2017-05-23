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
const Log				= require('./logger.js').log;
const resolveMimeType	= require('./mime_util.js').resolveMimeType;
const stringFormat		= require('./string_format.js');
const wordWrapText		= require('./word_wrap.js').wordWrapText;

//	deps
const _				= require('lodash');
const async			= require('async');
const fs			= require('graceful-fs');
const crypto		= require('crypto');
const paths			= require('path');
const temptmp		= require('temptmp').createTrackedSession('file_area');
const iconv			= require('iconv-lite');
const execFile		= require('child_process').execFile;
const moment		= require('moment');

exports.isInternalArea					= isInternalArea;
exports.getAvailableFileAreas			= getAvailableFileAreas;
exports.getSortedAvailableFileAreas		= getSortedAvailableFileAreas;
exports.isValidStorageTag				= isValidStorageTag;
exports.getAreaStorageDirectoryByTag	= getAreaStorageDirectoryByTag;
exports.getAreaDefaultStorageDirectory	= getAreaDefaultStorageDirectory;
exports.getAreaStorageLocations			= getAreaStorageLocations;
exports.getDefaultFileAreaTag			= getDefaultFileAreaTag;
exports.getFileAreaByTag				= getFileAreaByTag;
exports.getFileEntryPath				= getFileEntryPath;
exports.changeFileAreaWithOptions		= changeFileAreaWithOptions;
exports.scanFile						= scanFile;
exports.scanFileAreaForChanges			= scanFileAreaForChanges;
exports.getDescFromFileName				= getDescFromFileName;

const WellKnownAreaTags					= exports.WellKnownAreaTags = {
	Invalid				: '',
	MessageAreaAttach	: 'system_message_attachment',
};

function isInternalArea(areaTag) {
	return areaTag === WellKnownAreaTags.MessageAreaAttach;
}

function getAvailableFileAreas(client, options) {
	options = options || { };

	//	perform ACS check per conf & omit internal if desired
	const allAreas = _.map(Config.fileBase.areas, (areaInfo, areaTag) => Object.assign(areaInfo, { areaTag : areaTag } ));
	
	return _.omitBy(allAreas, areaInfo => {        
		if(!options.includeSystemInternal && isInternalArea(areaInfo.areaTag)) {
			return true;
		}

		if(options.writeAcs && !client.acs.hasFileAreaWrite(areaInfo)) {
			return true;	//	omit
		}

		return !client.acs.hasFileAreaRead(areaInfo);
	});
}

function getSortedAvailableFileAreas(client, options) {
	const areas = _.map(getAvailableFileAreas(client, options), v => v);
	sortAreasOrConfs(areas);
	return areas;
}

function getDefaultFileAreaTag(client, disableAcsCheck) {
	let defaultArea = _.findKey(Config.fileBase, o => o.default);
	if(defaultArea) {
		const area = Config.fileBase.areas[defaultArea];
		if(true === disableAcsCheck || client.acs.hasFileAreaRead(area)) {
			return defaultArea;
		}
	}

	//  just use anything we can
	defaultArea = _.findKey(Config.fileBase.areas, (area, areaTag) => {
		return WellKnownAreaTags.MessageAreaAttach !== areaTag && (true === disableAcsCheck || client.acs.hasFileAreaRead(area));
	});
    
	return defaultArea;
}

function getFileAreaByTag(areaTag) {
	const areaInfo = Config.fileBase.areas[areaTag];
	if(areaInfo) {
		areaInfo.areaTag	= areaTag;	//	convienence!
		areaInfo.storage	= getAreaStorageLocations(areaInfo); 
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

function isValidStorageTag(storageTag) {
	return storageTag in Config.fileBase.storageTags;
}

function getAreaStorageDirectoryByTag(storageTag) {
	const storageLocation = (storageTag && Config.fileBase.storageTags[storageTag]);

	return paths.resolve(Config.fileBase.areaStoragePrefix, storageLocation || '');
}

function getAreaDefaultStorageDirectory(areaInfo) {
	return getAreaStorageDirectoryByTag(areaInfo.storageTags[0]);
}

function getAreaStorageLocations(areaInfo) {
	
	const storageTags = Array.isArray(areaInfo.storageTags) ? 
		areaInfo.storageTags : 
		[ areaInfo.storageTags || '' ];

	const avail = Config.fileBase.storageTags;
	
	return _.compact(storageTags.map(storageTag => {
		if(avail[storageTag]) {
			return {
				storageTag	: storageTag,
				dir			: getAreaStorageDirectoryByTag(storageTag),
			};
		}
	}));
}

function getFileEntryPath(fileEntry) {
	const areaInfo = getFileAreaByTag(fileEntry.areaTag);
	if(areaInfo) {
		return paths.join(areaInfo.storageDirectory, fileEntry.fileName);
	}
}

function getExistingFileEntriesBySha256(sha256, cb) {
	const entries = [];

	FileDb.each(
		`SELECT file_id, area_tag
		FROM file
		WHERE file_sha256=?;`,
		[ sha256 ],
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
	//	We attempt detection in short -> long order
	//
	//	Throw out anything that is current_year + 2 (we give some leway)
	//	with the assumption that must be wrong.
	//
	const maxYear = moment().add(2, 'year').year();
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

		if(year && year <= maxYear) {
			fileEntry.meta.est_release_year = year;
		}
	}
}

//	a simple log proxy for when we call from oputil.js
function logDebug(obj, msg) {
	if(Log) {
		Log.debug(obj, msg);
	}
}

function extractAndProcessDescFiles(fileEntry, filePath, archiveEntries, cb) {
	async.waterfall(
		[
			function extractDescFiles(callback) {
				//	:TODO: would be nice if these RegExp's were cached
				//	:TODO: this is long winded...

				const extractList = [];

				const shortDescFile = archiveEntries.find( e => {
					return Config.fileBase.fileNamePatterns.desc.find( pat => new RegExp(pat, 'i').test(e.fileName) );
				});

				if(shortDescFile) {
					extractList.push(shortDescFile.fileName);
				}

				const longDescFile = archiveEntries.find( e => {
					return Config.fileBase.fileNamePatterns.descLong.find( pat => new RegExp(pat, 'i').test(e.fileName) );
				});

				if(longDescFile) {
					extractList.push(longDescFile.fileName);
				}

				if(0 === extractList.length) {
					return callback(null, [] );
				}

				temptmp.mkdir( { prefix : 'enigextract-' }, (err, tempDir) => {
					if(err) {
						return callback(err);
					}

					const archiveUtil = ArchiveUtil.getInstance();
					archiveUtil.extractTo(filePath, tempDir, fileEntry.meta.archive_type, extractList, err => {
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
				async.each(Object.keys(descFiles), (descType, next) => {
					const path = descFiles[descType];
					if(!path) {
						return next(null);
					}

					fs.stat(path, (err, stats) => {
						if(err) {
							return next(null);
						}

						//	skip entries that are too large
						const maxFileSizeKey = `max${_.upperFirst(descType)}FileByteSize`;
					
						if(Config.fileBase[maxFileSizeKey] && stats.size > Config.fileBase[maxFileSizeKey]) {
							logDebug( { byteSize : stats.size, maxByteSize : Config.fileBase[maxFileSizeKey] }, `Skipping "${descType}"; Too large` );
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
					});
				}, () => {
					//	cleanup but don't wait
					temptmp.cleanup( paths => {
						//	note: don't use client logger here - may not be avail
						logDebug( { paths : paths, sessionId : temptmp.sessionId }, 'Cleaned up temporary files' );
					});
					return callback(null);
				});
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
				//	:TODO: we may want to skip this if the compressed file is too large...
				temptmp.mkdir( { prefix : 'enigextract-' }, (err, tempDir) => {
					if(err) {
						return callback(err);
					}

					const archiveUtil = ArchiveUtil.getInstance();
					
					//	ensure we only extract one - there should only be one anyway -- we also just need the fileName
					const extractList = archiveEntries.slice(0, 1).map(entry => entry.fileName);
					
					archiveUtil.extractTo(filePath, tempDir, fileEntry.meta.archive_type, extractList, err => {
						if(err) {
							return callback(err);
						}

						return callback(null, paths.join(tempDir, extractList[0]));
					});
				});
			},
			function processSingleExtractedFile(extractedFile, callback) {
				populateFileEntryInfoFromFile(fileEntry, extractedFile, err => {
					if(!fileEntry.desc) {
						fileEntry.desc = getDescFromFileName(filePath);
					}
					return callback(err);
				});
			}
		],
		err => {
			return cb(err);
		}
	);
}

function populateFileEntryWithArchive(fileEntry, filePath, stepInfo, iterator, cb) {
	const archiveUtil 	= ArchiveUtil.getInstance();
	const archiveType	= fileEntry.meta.archive_type;	//	we set this previous to populateFileEntryWithArchive()

	async.waterfall(
		[
			function getArchiveFileList(callback) {
				stepInfo.step = 'archive_list_start';

				iterator(err => {
					if(err) {
						return callback(err);
					}

					archiveUtil.listEntries(filePath, archiveType, (err, entries) => {
						if(err) {
							stepInfo.step = 'archive_list_failed';
						} else {
							stepInfo.step = 'archive_list_finish';
							stepInfo.archiveEntries = entries || [];
						}

						iterator(iterErr => {
							return callback( iterErr, entries || [] );	//	ignore original |err| here
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
				//	If we have a -single- entry in the archive, extract that file
				//	and try retrieving info in the non-archive manor. This should
				//	work for things like zipped up .pdf files.
				//
				//	Otherwise, try to find particular desc files such as FILE_ID.DIZ
				//	and README.1ST
				//
				const archDescHandler = (1 === entries.length) ? extractAndProcessSingleArchiveEntry : extractAndProcessDescFiles;
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

function getInfoExtractUtilForDesc(mimeType, descType) {
	let util = _.get(Config, [ 'fileTypes', mimeType, `${descType}DescUtil` ]);
	if(!_.isString(util)) {
		return;
	}

	util = _.get(Config, [ 'infoExtractUtils', util ]);
	if(!util || !_.isString(util.cmd)) {
		return;
	}

	return util;
}

function populateFileEntryInfoFromFile(fileEntry, filePath, cb) {
	const mimeType = resolveMimeType(filePath);
	if(!mimeType) {
		return cb(null);
	}

	async.eachSeries( [ 'short', 'long' ], (descType, nextDesc) => {
		const util = getInfoExtractUtilForDesc(mimeType, descType);
		if(!util) {
			return nextDesc(null);
		}

		const args = (util.args || [ '{filePath}'] ).map( arg => stringFormat(arg, { filePath : filePath } ) );

		execFile(util.cmd, args, { timeout : 1000 * 30 }, (err, stdout) => {
			if(err || !stdout) {
				const reason = err ? err.message : 'No description produced';
				logDebug(
					{ reason : reason, cmd : util.cmd, args : args },
					`${_.upperFirst(descType)} description command failed`
				);
			} else {
				stdout = (stdout || '').trim();
				if(stdout.length > 0) {
					const key = 'short' === descType ? 'desc' : 'descLong';
					if('desc' === key) {
						//
						//	Word wrap short descriptions to FILE_ID.DIZ spec
						//
						//	"...no more than 45 characters long"
						//
						//	See http://www.textfiles.com/computers/fileid.txt
						//
						stdout = (wordWrapText( stdout, { width : 45 } ).wrapped || []).join('\n');
					}

					fileEntry[key] = stdout;
				}
			}

			return nextDesc(null);
		});
	}, () => {
		return cb(null);
	});	
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
					if(!fileEntry.desc) {
						fileEntry.desc = getDescFromFileName(filePath);
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
	//	:TODO: Use detectTypeWithBuf() once avail - we *just* read some file data

	async.series(
		[
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

const HASH_NAMES =  [ 'sha1', 'sha256', 'md5', 'crc32' ];

function scanFile(filePath, options, iterator, cb) {

	if(3 === arguments.length && _.isFunction(iterator)) {
		cb			= iterator;
		iterator	= null;
	} else if(2 === arguments.length && _.isFunction(options)) {
		cb			= options;
		iterator	= null;
		options		= {};
	}

	const fileEntry = new FileEntry({
		areaTag		: options.areaTag,
		meta		: options.meta,
		hashTags	: options.hashTags,	//	Set() or Array
		fileName	: paths.basename(filePath),
		storageTag	: options.storageTag,
		fileSha256	: options.sha256,	//	caller may know this already
	});

	const stepInfo = {
		filePath	: filePath,
		fileName	: paths.basename(filePath),
	};

	function callIter(next) {
		if(iterator) {
			return iterator(stepInfo, next);
		} else {
			return next(null);
		}
	}

	function readErrorCallIter(origError, next) {
		stepInfo.step	= 'read_error';
		stepInfo.error	= origError.message;

		callIter( () => {
			return next(origError);
		});
	}


	let lastCalcHashPercent;

	//	don't re-calc hashes for any we already have in |options|
	const hashesToCalc = HASH_NAMES.filter(hn =>  {
		if('sha256' === hn && fileEntry.fileSha256) {
			return false;
		}

		if(`file_${hn}` in fileEntry.meta) {
			return false;
		}

		return true;
	});

	async.waterfall(
		[
			function startScan(callback) {
				fs.stat(filePath, (err, stats) => {
					if(err) {
						return readErrorCallIter(err, callback);
					}

					stepInfo.step		= 'start';
					stepInfo.byteSize	= fileEntry.meta.byte_size = stats.size;

					return callIter(callback);
				});
			},
			function processPhysicalFileGeneric(callback) {			
				stepInfo.bytesProcessed = 0;

				const hashes = {};
				hashesToCalc.forEach(hashName => {
					if('crc32' === hashName) {
						hashes.crc32 = new CRC32;
					} else {
						hashes[hashName] = crypto.createHash(hashName);
					}
				});

				const stream = fs.createReadStream(filePath);

				function updateHashes(data) {
					async.each(hashesToCalc, (hashName, nextHash) => {
						hashes[hashName].update(data);
						return nextHash(null);
					}, () => {
						return stream.resume();
					});
				}

				stream.on('data', data => {
					stream.pause();	//	until iterator compeltes

					stepInfo.bytesProcessed		+= data.length;		
					stepInfo.calcHashPercent	= Math.round(((stepInfo.bytesProcessed / stepInfo.byteSize) * 100));

					//
					//	Only send 'hash_update' step update if we have a noticable percentage change in progress
					//
					if(stepInfo.calcHashPercent === lastCalcHashPercent) {
						updateHashes(data);
					} else {
						lastCalcHashPercent = stepInfo.calcHashPercent;
						stepInfo.step		= 'hash_update';

						callIter(err => {
							if(err) {
								stream.destroy();	//	cancel read
								return callback(err);
							}

							updateHashes(data);
						});
					}					
				});

				stream.on('end', () => {
					fileEntry.meta.byte_size = stepInfo.bytesProcessed;

					async.each(hashesToCalc, (hashName, nextHash) => {						
						if('sha256' === hashName) {
							stepInfo.sha256 = fileEntry.fileSha256 = hashes.sha256.digest('hex');
						} else if('sha1' === hashName || 'md5' === hashName) {
							stepInfo[hashName] = fileEntry.meta[`file_${hashName}`] = hashes[hashName].digest('hex');
						} else if('crc32' === hashName) {
							stepInfo.crc32 = fileEntry.meta.file_crc32 = hashes.crc32.finalize().toString(16);
						}

						return nextHash(null);
					}, () => {
						stepInfo.step = 'hash_finish';
						return callIter(callback);
					});
				});

				stream.on('error', err => {
					return readErrorCallIter(err, callback);
				});
			},
			function processPhysicalFileByType(callback) {
				const archiveUtil = ArchiveUtil.getInstance();

				archiveUtil.detectType(filePath, (err, archiveType) => {
					if(archiveType) {
						//	save this off
						fileEntry.meta.archive_type = archiveType;

						populateFileEntryWithArchive(fileEntry, filePath, stepInfo, callIter, err => {
							if(err) {
								populateFileEntryNonArchive(fileEntry, filePath, stepInfo, callIter, err => {
									//	:TODO: log err
									return callback(null);	//	ignore err
								});
							} else {
								return callback(null);
							}
						});
					} else {
						populateFileEntryNonArchive(fileEntry, filePath, stepInfo, callIter, err => {
							//	:TODO: log err
							return callback(null);	//	ignore err
						});
					}
				});
			},
			function fetchExistingEntry(callback) {
				getExistingFileEntriesBySha256(fileEntry.fileSha256, (err, dupeEntries) => {
					return callback(err, dupeEntries);
				});
			},
			function finished(dupeEntries, callback) {
				stepInfo.step = 'finished';
				callIter( () => {
					return callback(null, dupeEntries);
				});
			}
		], 
		(err, dupeEntries) => {
			if(err) {
				return cb(err);
			}

			return cb(null, fileEntry, dupeEntries);
		}
	);
}

function scanFileAreaForChanges(areaInfo, options, iterator, cb) {
	if(3 === arguments.length && _.isFunction(iterator)) {
		cb			= iterator;
		iterator	= null;
	} else if(2 === arguments.length && _.isFunction(options)) {
		cb			= options;
		iterator	= null;
		options		= {};
	}

	const storageLocations = getAreaStorageLocations(areaInfo);

	async.eachSeries(storageLocations, (storageLoc, nextLocation) => {
		async.series(
			[
				function scanPhysFiles(callback) {
					const physDir = storageLoc.dir;

					fs.readdir(physDir, (err, files) => {
						if(err) {
							return callback(err);
						}

						async.eachSeries(files, (fileName, nextFile) => {
							const fullPath = paths.join(physDir, fileName);

							fs.stat(fullPath, (err, stats) => {
								if(err) {
									//	:TODO: Log me!
									return nextFile(null);	//	always try next file
								}

								if(!stats.isFile()) {
									return nextFile(null);
								}

								scanFile(
									fullPath,
									{
										areaTag		: areaInfo.areaTag,
										storageTag	: storageLoc.storageTag
									},
									iterator,
									(err, fileEntry, dupeEntries) => {
										if(err) {
											//	:TODO: Log me!!!
											return nextFile(null);	//	try next anyway
										}

										if(dupeEntries.length > 0) {
											//	:TODO: Handle duplidates -- what to do here???
										} else {
											if(Array.isArray(options.tags)) {
												options.tags.forEach(tag => {
													fileEntry.hashTags.add(tag);
												});
											}
											addNewFileEntry(fileEntry, fullPath, err => {
												//	pass along error; we failed to insert a record in our DB or something else bad
												return nextFile(err);
											});
										}
									}
								);
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
				return nextLocation(err);
			}
		);
	}, 
	err => {
		return cb(err);
	});
}

function getDescFromFileName(fileName) {
	//	:TODO: this method could use some more logic to really be nice.
	const ext   = paths.extname(fileName);
	const name  = paths.basename(fileName, ext);

	return _.upperFirst(name.replace(/[\-_.+]/g, ' ').replace(/\s+/g, ' '));
}