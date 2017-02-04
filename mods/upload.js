/* jslint node: true */
'use strict';

//	enigma-bbs
const MenuModule						= require('../core/menu_module.js').MenuModule;
const stringFormat						= require('../core/string_format.js');
const getSortedAvailableFileAreas		= require('../core/file_base_area.js').getSortedAvailableFileAreas;
const getAreaDefaultStorageDirectory	= require('../core/file_base_area.js').getAreaDefaultStorageDirectory;
const scanFile							= require('../core/file_base_area.js').scanFile;
const ansiGoto							= require('../core/ansi_term.js').goto;
const moveFileWithCollisionHandling		= require('../core/file_util.js').moveFileWithCollisionHandling;
const pathWithTerminatingSeparator		= require('../core/file_util.js').pathWithTerminatingSeparator;
const Log								= require('../core/logger.js').log;
const Errors							= require('../core/enig_error.js').Errors;

//	deps
const async								= require('async');
const _									= require('lodash');
const temptmp							= require('temptmp').createTrackedSession('upload');
const paths								= require('path');
const sanatizeFilename					= require('sanitize-filename');

exports.moduleInfo = {
	name		: 'Upload',
	desc		: 'Module for classic file uploads',
	author		: 'NuSkooler',
};

const FormIds = {
	options		: 0,
	processing	: 1,
	fileDetails	: 2,

};

const MciViewIds = {
	options : {
		area		: 1,	//	area selection
		uploadType	: 2,	//	blind vs specify filename
		fileName	: 3,	//	for non-blind; not editable for blind
		navMenu		: 4,	//	next/cancel/etc.
		errMsg		: 5,	//	errors (e.g. filename cannot be blank)
	},

	processing : {
		calcHashIndicator		: 1,
		archiveListIndicator	: 2,
		descFileIndicator		: 3,

		customRangeStart		: 10,	//	10+ = customs
	},

	fileDetails : {
		desc				: 1,	//	defaults to 'desc' (e.g. from FILE_ID.DIZ)
		tags				: 2,	//	tag(s) for item
		estYear				: 3,
		accept				: 4,	//	accept fields & continue
		customRangeStart	: 10,	//	10+ = customs
	}
};

exports.getModule = class UploadModule extends MenuModule {

	constructor(options) {
		super(options);

		if(_.has(options, 'lastMenuResult.recvFilePaths')) {
			this.recvFilePaths = options.lastMenuResult.recvFilePaths;
		}

		this.availAreas = getSortedAvailableFileAreas(this.client, { writeAcs : true } );

		this.menuMethods = {
			optionsNavContinue : (formData, extraArgs, cb) => {
				return this.performUpload(cb);
			},

			fileDetailsContinue : (formData, extraArgs, cb) => {
				//	see displayFileDetailsPageForUploadEntry() for this hackery:
				cb(null);				
				return this.fileDetailsCurrentEntrySubmitCallback(null, formData.value);	//	move on to the next entry, if any
			},

			//	validation
			validateNonBlindFileName : (fileName, cb) => {
				fileName = sanatizeFilename(fileName);	//	remove unsafe chars, path info, etc.
				if(0 === fileName.length) {
					return cb(new Error('Invalid filename'));
				}

				if(0 === fileName.length) {
					return cb(new Error('Filename cannot be empty'));
				}

				//	At least SEXYZ doesn't like non-blind names that start with a number - it becomes confused
				if(/^[0-9].*$/.test(fileName)) {
					return cb(new Error('Invalid filename'));
				}

				return cb(null);
			},
			viewValidationListener : (err, cb) => {
				const errView = this.viewControllers.options.getView(MciViewIds.options.errMsg);
				if(errView) {
					if(err) {
						errView.setText(err.message);
					} else {
						errView.clearText();
					}
				}

				return cb(null);
			}
		};	
	}

	getSaveState() {
		return {
			uploadType			: this.uploadType,
			tempRecvDirectory	: this.tempRecvDirectory,
			areaInfo			: this.availAreas[ this.viewControllers.options.getView(MciViewIds.options.area).getData() ],
		};
	}

	restoreSavedState(savedState) {
		if(savedState.areaInfo) {
			this.uploadType			= savedState.uploadType;
			this.areaInfo			= savedState.areaInfo;
			this.tempRecvDirectory	= savedState.tempRecvDirectory;
		}
	}

	isBlindUpload() { return 'blind' === this.uploadType; }
	isFileTransferComplete() { return !_.isUndefined(this.recvFilePaths); }
	
	initSequence() {
		const self = this;

		async.series(
			[
				function before(callback) {
					return self.beforeArt(callback);
				},
				function display(callback) {
					if(self.isFileTransferComplete()) {
						return self.displayProcessingPage(callback);
					} else {
						return self.displayOptionsPage(callback);
					}
				}
			],
			() => {
				return self.finishedLoading();
			}
		);
	}

	finishedLoading() {
		if(this.isFileTransferComplete()) {
			return this.processUploadedFiles();
		}
	}

	leave() {
		//	remove any temp files - only do this when 
		if(this.isFileTransferComplete()) {
			temptmp.cleanup( paths => {
				Log.debug( { paths : paths, sessionId : temptmp.sessionId }, 'Temporary files cleaned up' );
			});
		}

		super.leave();
	}

	performUpload(cb) {
		temptmp.mkdir( { prefix : 'enigul-' }, (err, tempRecvDirectory) => {
			if(err) {
				return cb(err);
			}

			//	need a terminator for various external protocols
			this.tempRecvDirectory = pathWithTerminatingSeparator(tempRecvDirectory);
		
			const modOpts = {
				extraArgs : {
					recvDirectory	: this.tempRecvDirectory,	//	we'll move files from here to their area container once processed/confirmed
					direction		: 'recv',
				}
			};

			if(!this.isBlindUpload()) {
				//	data has been sanatized at this point
				modOpts.extraArgs.recvFileName = this.viewControllers.options.getView(MciViewIds.options.fileName).getData();
			}

			//
			//	Move along to protocol selection -> file transfer
			//	Upon completion, we'll re-enter the module with some file paths handed to us
			//
			return this.gotoMenu(
				this.menuConfig.config.fileTransferProtocolSelection || 'fileTransferProtocolSelection', 
				modOpts, 
				cb
			);
		});
	}

	continueNonBlindUpload(cb) {
		return cb(null);
	}

	updateScanStepInfoViews(stepInfo) {
		//	:TODO: add some blinking (e.g. toggle items) indicators - see OBV.DOC

		const fmtObj = Object.assign( {}, stepInfo);
		let stepIndicatorFmt = '';

		const indicatorStates 	= this.menuConfig.config.indicatorStates || [ '|', '/', '-', '\\' ];
		const indicatorFinished	= this.menuConfig.config.indicatorFinished || '√';

		const indicator = { };
		const self = this;

		function updateIndicator(mci, isFinished) {
			indicator.mci = mci;

			if(isFinished) {
				indicator.text = indicatorFinished;
			} else {
				self.scanStatus.indicatorPos += 1;
				if(self.scanStatus.indicatorPos >= indicatorStates.length) {
					self.scanStatus.indicatorPos = 0;
				}
				indicator.text = indicatorStates[self.scanStatus.indicatorPos];
			}
		}		

		switch(stepInfo.step) {
			case 'start' :
				stepIndicatorFmt = this.menuConfig.config.scanningStartFormat || 'Scanning {fileName}';
				break;

			case 'hash_update' :
				stepIndicatorFmt = this.menuConfig.calcHashFormat || 'Calculating hash/checksums: {calcHashPercent}%';
				updateIndicator(MciViewIds.processing.calcHashIndicator);
				break;

			case 'hash_finish' : 
				stepIndicatorFmt = this.menuConfig.calcHashCompleteFormat || 'Finished calculating hash/checksums';
				updateIndicator(MciViewIds.processing.calcHashIndicator, true);
				break;

			case 'archive_list_start' :
				stepIndicatorFmt = this.menuConfig.extractArchiveListFormat || 'Extracting archive list';
				updateIndicator(MciViewIds.processing.archiveListIndicator);
				break;

			case 'archive_list_finish' : 
				fmtObj.archivedFileCount = stepInfo.archiveEntries.length;
				stepIndicatorFmt = this.menuConfig.extractArchiveListFinishFormat || 'Archive list extracted ({archivedFileCount} files)';
				updateIndicator(MciViewIds.processing.archiveListIndicator, true);
				break;

			case 'archive_list_failed' :
				stepIndicatorFmt = this.menuConfig.extractArchiveListFailedFormat || 'Archive list extraction failed';
				break;

			case 'desc_files_start' : 
				stepIndicatorFmt = this.menuConfig.processingDescFilesFormat || 'Processing description files';
				updateIndicator(MciViewIds.processing.descFileIndicator);
				break;

			case 'desc_files_finish' :
				stepIndicatorFmt = this.menuConfig.processingDescFilesFinishFormat || 'Finished processing description files';
				updateIndicator(MciViewIds.processing.descFileIndicator, true);
				break;
		}

		fmtObj.stepIndicatorText = stringFormat(stepIndicatorFmt, fmtObj);
		
		if(this.hasProcessingArt) {
			this.updateCustomViewTextsWithFilter('processing', MciViewIds.processing.customRangeStart, fmtObj, { appendMultiLine : true } );

			if(indicator.mci && indicator.text) {
				this.setViewText('processing', indicator.mci, indicator.text);
			}
		} else {
			this.client.term.pipeWrite(fmtObj.stepIndicatorText);
		}
	}

	scanFiles(cb) {
		const self = this;

		const results = {
			newEntries	: [],
			dupes		: [],
		};

		self.client.log.debug('Scanning upload(s)', { paths : this.recvFilePaths } );

		async.eachSeries(this.recvFilePaths, (filePath, nextFilePath) => {
			//	:TODO: virus scanning/etc. should occur around here

			self.scanStatus = {
				indicatorPos	: 0,
			};

			const scanOpts = {
				areaTag		: self.areaInfo.areaTag,
				storageTag	: self.areaInfo.storageTags[0],
			};

			function handleScanStep(stepInfo, nextScanStep) {
				self.updateScanStepInfoViews(stepInfo);
				return nextScanStep(null);
			}

			self.client.log.debug('Scanning file', { filePath : filePath } );

			scanFile(filePath, scanOpts, handleScanStep, (err, fileEntry, dupeEntries) => {
				if(err) {
					return nextFilePath(err);
				}

				//	new or dupe?
				if(dupeEntries.length > 0) {
					//	1:n dupes found
					self.client.log.debug('Duplicate file(s) found', { dupeEntries : dupeEntries } );

					results.dupes = results.dupes.concat(dupeEntries);
				} else {
					//	new one
					results.newEntries.push(fileEntry);
				}

				return nextFilePath(null);
			});
		}, err => {
			return cb(err, results);
		});
	}

	moveAndPersistUploadsToDatabase(newEntries) {

		const areaStorageDir = getAreaDefaultStorageDirectory(this.areaInfo);
		const self = this;

		async.eachSeries(newEntries, (newEntry, nextEntry) => {
			const src 	= paths.join(self.tempRecvDirectory, newEntry.fileName);
			const dst	= paths.join(areaStorageDir, newEntry.fileName);

			moveFileWithCollisionHandling(src, dst,	(err, finalPath) => {
				if(err) {
					self.client.log.error(
						'Failed moving physical upload file', { error : err.message, fileName : newEntry.fileName, source : src, dest : dst }
					);
					
					return nextEntry(null);	//	still try next file
				}

				self.client.log.debug('Moved upload to area', { path : finalPath } );

				//	persist to DB
				newEntry.persist(err => {
					if(err) {
						self.client.log.error('Failed persisting upload to database', { path : finalPath, error : err.message } );
					}

					return nextEntry(null);	//	still try next file
				});
			});
		});
	}

	prepDetailsForUpload(scanResults, cb) {
		async.eachSeries(scanResults.newEntries, (newEntry, nextEntry) => {
			this.displayFileDetailsPageForUploadEntry(newEntry, (err, newValues) => {
				if(err) {
					return nextEntry(err);
				}

				//	if the file entry did *not* have a desc, take the user desc
				if(!this.fileEntryHasDetectedDesc(newEntry)) {
					newEntry.desc = newValues.shortDesc.trim();
				}

				if(newValues.estYear.length > 0) {
					newEntry.meta.est_release_year = newValues.estYear;
				}

				if(newValues.tags.length > 0) {
					newEntry.setHashTags(newValues.tags);
				}

				return nextEntry(err);
			});
		}, err => {
			delete this.fileDetailsCurrentEntrySubmitCallback;
			return cb(err, scanResults);
		});
	}

	processUploadedFiles() {
		//
		//	For each file uploaded, we need to process & gather information
		//
		const self = this;

		async.waterfall(
			[
				function prepNonBlind(callback) {
					if(self.isBlindUpload()) {
						return callback(null);
					}

					//
					//	For non-blind uploads, batch is not supported, we expect a single file
					//	in |recvFilePaths|. If not, it's an error (we don't want to process the wrong thing)
					//
					if(self.recvFilePaths.length > 1) {
						self.client.log.warn( { recvFilePaths : self.recvFilePaths }, 'Non-blind upload received 2:n files' );
						return callback(Errors.UnexpectedState(`Non-blind upload expected single file but got received ${self.recvFilePaths.length}`));
					}

					return callback(null);
				},
				function scan(callback) {
					return self.scanFiles(callback);
				},
				function pause(scanResults, callback) {
					if(self.hasProcessingArt) {
						self.client.term.rawWrite(ansiGoto(self.client.term.termHeight, 1));
					} else {
						self.client.term.write('\n');
					}

					self.pausePrompt( () => {
						return callback(null, scanResults);
					});					
				},
				function displayDupes(scanResults, callback) {
					if(0 === scanResults.dupes.length) {
						return callback(null, scanResults);
					}

					//	:TODO: display dupe info
					return callback(null, scanResults);
				},
				function prepDetails(scanResults, callback) {
					return self.prepDetailsForUpload(scanResults, callback);					
				},
				function startMovingAndPersistingToDatabase(scanResults, callback) {
					//
					//	*Start* the process of moving files from their current |tempRecvDirectory|
					//	locations -> their final area destinations. Don't make the user wait
					//	here as I/O can take quite a bit of time. Log any failures.
					//
					self.moveAndPersistUploadsToDatabase(scanResults.newEntries);
					return callback(null);
				},
			],
			err => {
				if(err) {
					self.client.log.warn('File upload error encountered', { error : err.message } );
				}

				return self.prevMenu();
			}
		);
	}

	displayOptionsPage(cb) {
		const self = this;
		
		async.series(
			[
				function prepArtAndViewController(callback) {
					return self.prepViewControllerWithArt(
						'options', 
						FormIds.options, 
						{ clearScreen : true, trailingLF : false }, 
						callback
					);
				},
				function populateViews(callback) {
					const areaSelectView = self.viewControllers.options.getView(MciViewIds.options.area);
					areaSelectView.setItems( self.availAreas.map(areaInfo => areaInfo.name ) );

					const uploadTypeView 	= self.viewControllers.options.getView(MciViewIds.options.uploadType);
					const fileNameView		= self.viewControllers.options.getView(MciViewIds.options.fileName);

					const blindFileNameText = self.menuConfig.config.blindFileNameText || '(blind - filename ignored)';

					uploadTypeView.on('index update', idx => {
						self.uploadType = (0 === idx) ? 'blind' : 'non-blind';

						if(self.isBlindUpload()) {
							fileNameView.setText(blindFileNameText);
							fileNameView.acceptsFocus = false;
						} else  {
							fileNameView.clearText();
							fileNameView.acceptsFocus = true;
						}
					});

					//	sanatize filename for display when leaving the view
					self.viewControllers.options.on('leave', prevView => {
						if(prevView.id === MciViewIds.options.fileName) {
							fileNameView.setText(sanatizeFilename(fileNameView.getData()));
						}
					});
					
					self.uploadType = 'blind';
					uploadTypeView.setFocusItemIndex(0);	//	default to blind
					fileNameView.setText(blindFileNameText);
					areaSelectView.redraw();

					return callback(null);
				}
			],
			err => {
				if(cb) {
					return cb(err);
				}
			}
		);
	}

	displayProcessingPage(cb) {
		return this.prepViewControllerWithArt(
			'processing',
			FormIds.processing,
			{ clearScreen : true, trailingLF : false },
			err => {
				//	note: this art is not required
				this.hasProcessingArt = !err;

				return cb(null);
			}
		);
	}

	fileEntryHasDetectedDesc(fileEntry) {
		return (fileEntry.desc && fileEntry.desc.length > 0);
	}

	displayFileDetailsPageForUploadEntry(fileEntry, cb) {
		const self = this;
		
		async.series(
			[
				function prepArtAndViewController(callback) {
					return self.prepViewControllerWithArt(
						'fileDetails', 
						FormIds.fileDetails,
						{ clearScreen : true, trailingLF : false }, 
						callback
					);
				},
				function populateViews(callback) {
					const descView = self.viewControllers.fileDetails.getView(MciViewIds.fileDetails.desc);
					const tagsView = self.viewControllers.fileDetails.getView(MciViewIds.fileDetails.tags);
					const yearView = self.viewControllers.fileDetails.getView(MciViewIds.fileDetails.estYear);

					tagsView.setText( Array.from(fileEntry.hashTags).join(',') );	//	:TODO: optional 'hashTagsSep' like file list/browse
					yearView.setText(fileEntry.meta.est_release_year || '');

					if(self.fileEntryHasDetectedDesc(fileEntry)) {
						descView.setText(fileEntry.desc);
						descView.setPropertyValue('mode', 'preview');
						self.viewControllers.fileDetails.switchFocus(MciViewIds.fileDetails.tags);
						descView.acceptsFocus = false;
					} else {
						self.viewControllers.fileDetails.switchFocus(MciViewIds.fileDetails.desc);
					}

					return callback(null);
				}
			],
			err => {
				//
				//	we only call |cb| here if there is an error
				//	else, wait for the current from to be submit - then call -
				//	this way we'll move on to the next file entry when ready
				//
				if(err) {
					return cb(err);
				}

				self.fileDetailsCurrentEntrySubmitCallback = cb;	//	stash for moduleMethods.fileDetailsContinue
			}
		);
	}
};
