/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const printUsageAndSetExitCode	= require('./oputil_common.js').printUsageAndSetExitCode;
const ExitCodes					= require('./oputil_common.js').ExitCodes;
const argv						= require('./oputil_common.js').argv;
const initConfigAndDatabases	= require('./oputil_common.js').initConfigAndDatabases;
const getHelpFor				= require('./oputil_help.js').getHelpFor;
const getAreaAndStorage			= require('./oputil_common.js').getAreaAndStorage;
const Errors					= require('../enig_error.js').Errors;

const async						= require('async');
const fs						= require('graceful-fs');
const paths						= require('path');
const _							= require('lodash');
const moment					= require('moment');
const inq						= require('inquirer');

exports.handleFileBaseCommand			= handleFileBaseCommand;

/*
	:TODO:

	Global options:
		--yes: assume yes
		--no-prompt: try to avoid user input 

	Prompt for import and description before scan
		* Only after finding duplicate-by-path
		* Default to filename -> desc if auto import

*/

let fileArea;	//	required during init

function finalizeEntryAndPersist(isUpdate, fileEntry, descHandler, cb) {
	async.series(
		[
			function getDescFromHandlerIfNeeded(callback) {
				if((fileEntry.desc && fileEntry.desc.length > 0 ) && !argv['desc-file']) {
					return callback(null);	//	we have a desc already and are NOT overriding with desc file
				}

				if(!descHandler) {
					return callback(null);	//	not much we can do!
				}

				const desc = descHandler.getDescription(fileEntry.fileName);
				if(desc) {
					fileEntry.desc = desc;
				}
				return callback(null);
			},
			function getDescFromUserIfNeeded(callback) {
				if(fileEntry.desc && fileEntry.desc.length > 0 ) {
					return callback(null);
				}

				const getDescFromFileName	= require('../../core/file_base_area.js').getDescFromFileName;
				const descFromFile			= getDescFromFileName(fileEntry.fileName);
				
				if(false === argv.prompt) {
					fileEntry.desc = descFromFile;
					return callback(null);
				}

				const questions = [
					{
						name	: 'desc',
						message	: `Description for ${fileEntry.fileName}:`,
						type	: 'input',
						default	: descFromFile,
					}
				];

				inq.prompt(questions).then( answers => {
					fileEntry.desc = answers.desc;
					return callback(null);
				});
			},
			function persist(callback) {
				fileEntry.persist(isUpdate, err => {
					return callback(err);
				});
			}
		],
		err => {
			return cb(err);
		}
	);
}

const SCAN_EXCLUDE_FILENAMES = [ 'DESCRIPT.ION', 'FILES.BBS' ];

function loadDescHandler(path, cb) {
	const DescIon = require('../../core/descript_ion_file.js');

	//	:TODO: support FILES.BBS also

	DescIon.createFromFile(path, (err, descHandler) => {
		return cb(err, descHandler);
	});
}

function scanFileAreaForChanges(areaInfo, options, cb) {

	const storageLocations = fileArea.getAreaStorageLocations(areaInfo).filter(sl => {
		return options.areaAndStorageInfo.find(asi => {
			return !asi.storageTag || sl.storageTag === asi.storageTag;
		});
	});

	function updateTags(fe) {
		if(Array.isArray(options.tags)) {
			fe.hashTags = new Set(options.tags);
		}
	}
	
	async.eachSeries(storageLocations, (storageLoc, nextLocation) => {
		async.waterfall(
			[
				function initDescFile(callback) {
					if(options.descFileHandler) {
						return callback(null, options.descFileHandler);	//	we're going to use the global handler
					}

					loadDescHandler(paths.join(storageLoc.dir, 'DESCRIPT.ION'), (err, descHandler) => {
						return callback(null, descHandler);
					});
				},
				function scanPhysFiles(descHandler, callback) {
					const physDir = storageLoc.dir;

					fs.readdir(physDir, (err, files) => {
						if(err) {
							return callback(err);
						}

						async.eachSeries(files, (fileName, nextFile) => {
							const fullPath = paths.join(physDir, fileName);

							if(SCAN_EXCLUDE_FILENAMES.includes(fileName.toUpperCase())) {
								console.info(`Excluding ${fullPath}`);
								return nextFile(null);
							}

							fs.stat(fullPath, (err, stats) => {
								if(err) {
									//	:TODO: Log me!
									return nextFile(null);	//	always try next file
								}

								if(!stats.isFile()) {
									return nextFile(null);
								}

								process.stdout.write(`Scanning ${fullPath}... `);

								fileArea.scanFile(
									fullPath,
									{
										areaTag		: areaInfo.areaTag,
										storageTag	: storageLoc.storageTag
									},
									(err, fileEntry, dupeEntries) => {
										if(err) {
											console.info(`Error: ${err.message}`);											
											return nextFile(null);	//	try next anyway
										}

										//
										//	We'll update the entry if the following conditions are met:
										//	* We have a single duplicate, and:
										//	* --update was passed or the existing entry's desc,
										//	  longDesc, or est_release_year meta are blank/empty
										//
										if(argv.update && 1 === dupeEntries.length) {
											const FileEntry		= require('../../core/file_entry.js');
											const existingEntry	= new FileEntry();

											return existingEntry.load(dupeEntries[0].fileId, err => {
												if(err) {
													console.info('Dupe (cannot update)');
													return nextFile(null);
												}

												//
												//	Update only if tags or desc changed
												//
												const optTags	= Array.isArray(options.tags) ? new Set(options.tags) : existingEntry.hashTags;
												const tagsEq	= _.isEqual(optTags, existingEntry.hashTags);

												if( tagsEq && 
													fileEntry.desc === existingEntry.desc && 
													fileEntry.descLong == existingEntry.descLong &&
													fileEntry.meta.est_release_year == existingEntry.meta.est_release_year)
												{
													console.info('Dupe');
													return nextFile(null);
												}

												console.info('Dupe (updating)');

												//	don't allow overwrite of values if new version is blank
												existingEntry.desc 					= fileEntry.desc || existingEntry.desc;
												existingEntry.descLong				= fileEntry.descLong || existingEntry.descLong;

												if(fileEntry.meta.est_release_year) {
													existingEntry.meta.est_release_year	= fileEntry.meta.est_release_year;
												}

												updateTags(existingEntry);

												finalizeEntryAndPersist(true, existingEntry, descHandler, err => {
													return nextFile(err);
												});
											});
										} else if(dupeEntries.length > 0) {
											console.info('Dupe');
											return nextFile(null);
										}
										
										console.info('Done!');
										updateTags(fileEntry);
										
										finalizeEntryAndPersist(false, fileEntry, descHandler, err => {
											return nextFile(err);
										});
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

function dumpAreaInfo(areaInfo, areaAndStorageInfo, cb) {
	console.info(`areaTag: ${areaInfo.areaTag}`);
	console.info(`name: ${areaInfo.name}`);
	console.info(`desc: ${areaInfo.desc}`);

	areaInfo.storage.forEach(si => {
		console.info(`storageTag: ${si.storageTag} => ${si.dir}`);
	});
	console.info('');
	
	return cb(null);
}

function getFileEntries(pattern, cb) {
	//	spec: FILENAME_WC|FILE_ID|SHA|PARTIAL_SHA
	const FileEntry = require('../../core/file_entry.js');

	async.waterfall(
		[
			function tryByFileId(callback) {
				const fileId = parseInt(pattern);
				if(!/^[0-9]+$/.test(pattern) || isNaN(fileId)) {
					return callback(null, null);	//	try SHA
				}

				const fileEntry = new FileEntry();
				fileEntry.load(fileId, err => {
					return callback(null, err ? null : [ fileEntry ] );
				});
			},
			function tryByShaOrPartialSha(entries, callback) {
				if(entries) {
					return callback(null, entries);	//	already got it by FILE_ID
				}

				FileEntry.findFileBySha(pattern, (err, fileEntry) => {
					return callback(null, fileEntry ? [ fileEntry ] : null );
				});
			},
			function tryByFileNameWildcard(entries, callback) {
				if(entries) {
					return callback(null, entries);	//	already got by FILE_ID|SHA
				}

				return FileEntry.findByFileNameWildcard(pattern, callback);
			}
		],
		(err, entries) => {
			return cb(err, entries);
		}
	);
}

function dumpFileInfo(shaOrFileId, cb) {
	async.waterfall(
		[
			function getEntry(callback) {
				getFileEntries(shaOrFileId, (err, entries) => {
					if(err) {
						return callback(err);
					}

					return callback(null, entries[0]);
				});
			},
			function dumpInfo(fileEntry, callback) {
				const fullPath = paths.join(fileArea.getAreaStorageDirectoryByTag(fileEntry.storageTag), fileEntry.fileName);

				console.info(`file_id: ${fileEntry.fileId}`);
				console.info(`sha_256: ${fileEntry.fileSha256}`);
				console.info(`area_tag: ${fileEntry.areaTag}`);
				console.info(`storage_tag: ${fileEntry.storageTag}`);
				console.info(`path: ${fullPath}`);
				console.info(`hashTags: ${Array.from(fileEntry.hashTags).join(', ')}`);
				console.info(`uploaded: ${moment(fileEntry.uploadTimestamp).format()}`);
				
				_.each(fileEntry.meta, (metaValue, metaName) => {
					console.info(`${metaName}: ${metaValue}`);
				});

				if(argv['show-desc']) {
					console.info(`${fileEntry.desc}`);
				}
				console.info('');

				return callback(null);
			}
		],
		err => {
			return cb(err);
		}
	);
}

function displayFileAreaInfo() {
	//	AREA_TAG[@STORAGE_TAG]
	//	SHA256|PARTIAL
	//	if sha: dump file info
	//	if area/stoarge dump area(s) +

	async.series(
		[
			function init(callback) {
				return initConfigAndDatabases(callback);
			},	
			function dumpInfo(callback) {
				const Config = require('../../core/config.js').config;
				let suppliedAreas = argv._.slice(2);
				if(!suppliedAreas || 0 === suppliedAreas.length) {
					suppliedAreas = _.map(Config.fileBase.areas, (areaInfo, areaTag) => areaTag);
				}

				const areaAndStorageInfo = getAreaAndStorage(suppliedAreas);

				fileArea = require('../../core/file_base_area.js');

				async.eachSeries(areaAndStorageInfo, (areaAndStorage, nextArea) => {
					const areaInfo = fileArea.getFileAreaByTag(areaAndStorage.areaTag);
					if(areaInfo) {
						return dumpAreaInfo(areaInfo, areaAndStorageInfo, nextArea);
					} else {
						return dumpFileInfo(areaAndStorage.areaTag, nextArea);
					}
				},
				err => {
					return callback(err);
				});
			}
		],
		err => {
			if(err) {
				process.exitCode = ExitCodes.ERROR;
				console.error(err.message);
			}
		}
	);
}

function scanFileAreas() {
	const options = {};

	const tags = argv.tags;
	if(tags) {
		options.tags = tags.split(',');
	}

	options.descFile = argv['desc-file'];	//	--desc-file or --desc-file PATH
	
	options.areaAndStorageInfo = getAreaAndStorage(argv._.slice(2));

	async.series(
		[
			function init(callback) {
				return initConfigAndDatabases(callback);
			},
			function initGlobalDescHandler(callback) {		
				//
				//	If options.descFile is a String, it represents a FILE|PATH. We'll init
				//	the description handler now. Else, we'll attempt to look for a description 
				//	file in each storage location.
				//
				if(!_.isString(options.descFile)) {
					return callback(null);
				}

				loadDescHandler(options.descFile, (err, descHandler) => {
					options.descFileHandler = descHandler;
					return callback(null);
				});
			},
			function scanAreas(callback) {
				fileArea = require('../../core/file_base_area.js');

				async.eachSeries(options.areaAndStorageInfo, (areaAndStorage, nextAreaTag) => {
					const areaInfo = fileArea.getFileAreaByTag(areaAndStorage.areaTag);
					if(!areaInfo) {
						return nextAreaTag(new Error(`Invalid file base area tag: ${areaAndStorage.areaTag}`));
					}

					console.info(`Processing area "${areaInfo.name}":`);

					scanFileAreaForChanges(areaInfo, options, err => {
						return callback(err);
					});
				}, err => {
					return callback(err);
				});
			}
		],
		err => {
			if(err) {
				process.exitCode = ExitCodes.ERROR;
				console.error(err.message);
			}
		}
	);
}

function expandFileTargets(targets, cb) {
	let entries = [];

	//	Each entry may be PATH|FILE_ID|SHA|AREA_TAG[@STORAGE_TAG]
	const FileEntry = require('../../core/file_entry.js');

	async.eachSeries(targets, (areaAndStorage, next) => {
		const areaInfo = fileArea.getFileAreaByTag(areaAndStorage.areaTag);

		if(areaInfo) {
			//	AREA_TAG[@STORAGE_TAG] - all files in area@tag
			const findFilter = {
				areaTag : areaAndStorage.areaTag,
			};

			if(areaAndStorage.storageTag) {
				findFilter.storageTag = areaAndStorage.storageTag;
			}

			FileEntry.findFiles(findFilter, (err, fileIds) => {
				if(err) {
					return next(err);
				}

				async.each(fileIds, (fileId, nextFileId) => {
					const fileEntry = new FileEntry();
					fileEntry.load(fileId, err => {
						if(!err) {
							entries.push(fileEntry);
						}
						return nextFileId(err);
					});
				},
				err => {
					return next(err);
				});
			});

		} else {
			//	FILENAME_WC|FILE_ID|SHA|PARTIAL_SHA
			//	:TODO: FULL_PATH -> entries
			getFileEntries(areaAndStorage.pattern, (err, fileEntries) => {
				if(err) {
					return next(err);
				}

				entries = entries.concat(fileEntries);
				return next(null);
			});
		}
	},
	err => {
		return cb(err, entries);
	});
}

function moveFiles() {
	//
	//	oputil fb move SRC [SRC2 ...] DST
	//
	//	SRC: FILENAME_WC|FILE_ID|SHA|AREA_TAG[@STORAGE_TAG]
	//	DST: AREA_TAG[@STORAGE_TAG]
	//
	if(argv._.length < 4) {
		return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.ERROR);
	}

	const moveArgs = argv._.slice(2);
	const src = getAreaAndStorage(moveArgs.slice(0, -1));
	const dst = getAreaAndStorage(moveArgs.slice(-1))[0];

	let FileEntry;

	async.waterfall(
		[
			function init(callback) {
				return initConfigAndDatabases( err => {
					if(!err) {
						fileArea = require('../../core/file_base_area.js');
					}
					return callback(err);
				});
			},
			function validateAndExpandSourceAndDest(callback) {
				const areaInfo = fileArea.getFileAreaByTag(dst.areaTag);
				if(areaInfo) {
					dst.areaInfo = areaInfo;
				} else {
					return callback(Errors.DoesNotExist('Invalid or unknown destination area'));
				}

				FileEntry = require('../../core/file_entry.js');

				expandFileTargets(src, (err, srcEntries) => {
					return callback(err, srcEntries);
				});
			},
			function moveEntries(srcEntries, callback) {
				
				if(!dst.storageTag) {
					dst.storageTag = dst.areaInfo.storageTags[0];
				}
				
				const destDir = FileEntry.getAreaStorageDirectoryByTag(dst.storageTag);
				
				async.eachSeries(srcEntries, (entry, nextEntry) => {			
					const srcPath 	= entry.filePath;
					const dstPath	= paths.join(destDir, entry.fileName);

					process.stdout.write(`Moving ${srcPath} => ${dstPath}... `);

					FileEntry.moveEntry(entry, dst.areaTag, dst.storageTag, err => {
						if(err) {
							console.info(`Failed: ${err.message}`);
						} else {
							console.info('Done');
						}
						return nextEntry(null);	//	always try next
					});					
				},
				err => {
					return callback(err);
				});
			}
		],
		err => {
			if(err) {
				process.exitCode = ExitCodes.ERROR;
				console.error(err.message);
			}
		}
	);
}

function removeFiles() {
	//
	//	oputil fb rm|remove|del|delete SRC [SRC2 ...]
	//
	//	SRC: FILENAME_WC|FILE_ID|SHA|AREA_TAG[@STORAGE_TAG]
	//
	//	AREA_TAG[@STORAGE_TAG] remove all entries matching
	//	supplied area/storage tags
	//
	//	--phys-file removes backing physical file(s)
	//
	if(argv._.length < 3) {
		return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.ERROR);
	}

	const removePhysFile = argv['phys-file'];

	const src =  getAreaAndStorage(argv._.slice(2));

	async.waterfall(
		[
			function init(callback) {
				return initConfigAndDatabases( err => {
					if(!err) {
						fileArea = require('../../core/file_base_area.js');
					}
					return callback(err);
				});
			},
			function expandSources(callback) {
				expandFileTargets(src, (err, srcEntries) => {
					return callback(err, srcEntries);
				});
			},
			function removeEntries(srcEntries, callback) {
				const FileEntry = require('../../core/file_entry.js');

				const extraOutput = removePhysFile ? ' (including physical file)' : '';

				async.eachSeries(srcEntries, (entry, nextEntry) => {

					process.stdout.write(`Removing ${entry.filePath}${extraOutput}... `);

					FileEntry.removeEntry(entry, { removePhysFile }, err => {
						if(err) {
							console.info(`Failed: ${err.message}`);
						} else {
							console.info('Done');
						}

						return nextEntry(err);
					});
				}, err => {
					return callback(err);
				});
			}
		],
		err => {
			if(err) {
				process.exitCode = ExitCodes.ERROR;
				console.error(err.message);
			}
		}
	);
}

function handleFileBaseCommand() {

	function errUsage()  {
		return printUsageAndSetExitCode(
			getHelpFor('FileBase') + getHelpFor('FileOpsInfo'), 
			ExitCodes.ERROR
		);
	}

	if(true === argv.help) {
		return errUsage();
	}

	const action = argv._[1];

	return ({
		info	: displayFileAreaInfo,
		scan	: scanFileAreas,

		mv		: moveFiles,
		move	: moveFiles,

		rm		: removeFiles,
		remove	: removeFiles,
		del		: removeFiles,
		delete	: removeFiles,
	}[action] || errUsage)();
}