/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const printUsageAndSetExitCode	= require('./oputil_common.js').printUsageAndSetExitCode;
const ExitCodes					= require('./oputil_common.js').ExitCodes;
const argv						= require('./oputil_common.js').argv;
const initConfigAndDatabases	= require('./oputil_common.js').initConfigAndDatabases;
const getHelpFor				= require('./oputil_help.js').getHelpFor;
const getAreaAndStorage			= require('./oputil_common.js').getAreaAndStorage;


const async						= require('async');
const fs						= require('fs');
const paths						= require('path');

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

function scanFileAreaForChanges(areaInfo, options, cb) {

	const storageLocations = fileArea.getAreaStorageLocations(areaInfo).filter(sl => {
		return options.areaAndStorageInfo.find(asi => {
			return !asi.storageTag || sl.storageTag === asi.storageTag;
		});
	});
	
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

								process.stdout.write(`* Scanning ${fullPath}... `);

								fileArea.scanFile(
									fullPath,
									{
										areaTag		: areaInfo.areaTag,
										storageTag	: storageLoc.storageTag
									},
									(err, fileEntry, dupeEntries) => {
										if(err) {
											//	:TODO: Log me!!!
											console.info(`Error: ${err.message}`);											
											return nextFile(null);	//	try next anyway
										}

										

										if(dupeEntries.length > 0) {
											//	:TODO: Handle duplidates -- what to do here???
											console.info('Dupe');
											return nextFile(null);
										} else {
											console.info('Done!');
											if(Array.isArray(options.tags)) {
												options.tags.forEach(tag => {
													fileEntry.hashTags.add(tag);
												});
											}

											fileEntry.persist( err => {
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

function scanFileAreas() {
	const options = {};

	const tags = argv.tags;
	if(tags) {
		options.tags = tags.split(',');
	}

	options.areaAndStorageInfo = getAreaAndStorage(argv._.slice(2));

	async.series(
		[
			function init(callback) {
				return initConfigAndDatabases(callback);
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

function handleFileBaseCommand() {
	if(true === argv.help) {
		return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.ERROR);
	}

	const action = argv._[1];

	switch(action) {
		case 'scan' : return scanFileAreas();
	}
}