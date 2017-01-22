/* jslint node: true */
'use strict';

//	enigma-bbs
const MenuModule						= require('../core/menu_module.js').MenuModule;
const ViewController					= require('../core/view_controller.js').ViewController;
const theme								= require('../core/theme.js');
const ansi								= require('../core/ansi_term.js');
const Errors							= require('../core/enig_error.js').Errors;
const stringFormat						= require('../core/string_format.js');
const getSortedAvailableFileAreas		= require('../core/file_area.js').getSortedAvailableFileAreas;
const getAreaDefaultStorageDirectory	= require('../core/file_area.js').getAreaDefaultStorageDirectory;
const scanFile							= require('../core/file_area.js').scanFile;
const getAreaStorageDirectoryByTag		= require('../core/file_area.js').getAreaStorageDirectoryByTag;

//	deps
const async								= require('async');
const _									= require('lodash');
const paths								= require('path');

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
	},

	processing : {
		stepIndicator		: 1,
		customRangeStart	: 10,	//	10+ = customs
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
				if(this.isBlindUpload()) {
					//	jump to protocol selection
					const areaUploadDir = this.getSelectedAreaUploadDirectory();

					const modOpts = {
						extraArgs : {
							recvDirectory	: areaUploadDir,
							direction		: 'recv',
						}
					};

					return this.gotoMenu(this.menuConfig.config.fileTransferProtocolSelection || 'fileTransferProtocolSelection', modOpts, cb);					
				} else {
					//	jump to fileDetails form
					//	:TODO: support non-blind: collect info/filename -> upload -> complete					
				}
			},

			fileDetailsContinue : (formData, extraArgs, cb) => {


				//	see notes in displayFileDetailsPageForEntry() about this hackery:
				cb(null);
				return this.fileDetailsCurrentEntrySubmitCallback(null, formData.value);	//	move on to the next entry, if any
			}
		};	
	}

	getSaveState() {
		const saveState = {
			uploadType	: this.uploadType,

		};

		if(this.isBlindUpload()) {
			saveState.areaInfo = this.getSelectedAreaInfo();
		}

		return saveState;
	}

	restoreSavedState(savedState) {
		if(savedState.areaInfo) {
			this.areaInfo = savedState.areaInfo;
		}
	}

	getSelectedAreaInfo() {
		const areaSelectView = this.viewControllers.options.getView(MciViewIds.options.area);
		return this.availAreas[areaSelectView.getData()];
	}

	getSelectedAreaUploadDirectory() {
		const areaInfo = this.getSelectedAreaInfo();
		return getAreaDefaultStorageDirectory(areaInfo);
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

	updateScanStepInfoViews(stepInfo) {
		//	:TODO: add some blinking (e.g. toggle items) indicators - see OBV.DOC

		const fmtObj = Object.assign( {}, stepInfo);
		let stepIndicatorFmt = '';

		switch(stepInfo.step) {
			case 'start' :
				stepIndicatorFmt = this.menuConfig.config.scanningStartFormat || 'Scanning {fileName}';
				break;

			case 'hash_update' :
				stepIndicatorFmt = this.menuConfig.calcHashFormat || 'Calculating hash/checksums: {calcHashPercent}%';

				this.scanStatus.hashUpdateCount += 1;
				fmtObj.calcHashPercent = Math.round(((stepInfo.bytesProcessed / stepInfo.byteSize) * 100)).toString();

				if(this.scanStatus.hashUpdateCount % 2) {
					fmtObj.calcHashIndicator = this.menuConfig.config.hashUpdateIndicator1Fmt || '-';
				} else {
					fmtObj.calcHashIndicator = this.menuConfig.config.hashUpdateIndicator2Fmt || '*';
				}
				break;

			case 'hash_finish' : 
				stepIndicatorFmt = this.menuConfig.calcHashCompleteFormat || 'Finished calculating hash/checksums';
				break;

			case 'archive_list_start' :
				stepIndicatorFmt = this.menuConfig.extractArchiveListFormat || 'Extracting archive list';
				break;

			case 'archive_list_finish' : 
				fmtObj.archivedFileCount = stepInfo.archiveEntries.length;
				stepIndicatorFmt = this.menuConfig.extractArchiveListFinishFormat || 'Archive list extracted ({archivedFileCount} files)';
				break;

			case 'archive_list_failed' :
				stepIndicatorFmt = this.menuConfig.extractArchiveListFailedFormat || 'Archive list extraction failed';
				break;

			case 'desc_files_start' : 
				stepIndicatorFmt = this.menuConfig.processingDescFilesFormat || 'Processing description files';
				break;

			case 'desc_files_finish' :
				stepIndicatorFmt = this.menuConfig.processingDescFilesFinishFormat || 'Finished processing description files';
				break;
		}

		const stepIndicatorText = stringFormat(stepIndicatorFmt, fmtObj);

		if(this.hasProcessingArt) {
			this.setViewText('processing', MciViewIds.processing.stepIndicator, stepIndicatorText);
			this.updateCustomViewTextsWithFilter('processing', MciViewIds.processing.customRangeStart, fmtObj);
		} else {
			this.client.term.pipeWrite(`${stepIndicatorText}\n`);
		}
	}

	scanFiles(cb) {
		const self = this;

		const results = {
			newEntries	: [],
			dupes		: [],
		};

		async.eachSeries(this.recvFilePaths, (filePath, nextFilePath) => {
			//	:TODO: virus scanning/etc. should occur around here

			self.scanStatus = {
				hashUpdateCount	: 0,
			};

			const scanOpts = {
				areaTag		: self.areaInfo.areaTag,
				storageTag	: self.areaInfo.storageTags[0],
			};

			function handleScanStep(stepInfo, nextScanStep) {
				self.updateScanStepInfoViews(stepInfo);
				return nextScanStep(null);
			}

			scanFile(filePath, scanOpts, handleScanStep, (err, fileEntry, dupeEntries) => {
				if(err) {
					return nextFilePath(err);
				}

				//	new or dupe?
				if(dupeEntries.length > 0) {
					//	1:n dupes found
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

	processUploadedFiles() {
		//
		//	For each file uploaded, we need to process & gather information
		//
		const self = this;

		async.waterfall(
			[
				function scan(callback) {
					return self.scanFiles(callback);
				},
				function displayDupes(scanResults, callback) {
					if(0 === scanResults.dupes.length) {
						return callback(null, scanResults);
					}

					//	:TODO: display dupe info
					return callback(null, scanResults);
				},
				function prepDetails(scanResults, callback) {
					async.eachSeries(scanResults.newEntries, (newEntry, nextEntry) => {
						self.displayFileDetailsPageForEntry(newEntry, (err, newValues) => {
							if(err) {
								return nextEntry(err);
							}

							//	if the file entry did *not* have a desc, take the user desc
							if(!self.fileEntryHasDetectedDesc(newEntry)) {
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
						delete self.fileDetailsCurrentEntrySubmitCallback;
						return callback(err, scanResults);
					});
				},
				function persistNewEntries(scanResults, callback) {
					//	loop over entries again & persist to DB
					async.eachSeries(scanResults.newEntries, (newEntry, nextEntry) => {
						newEntry.persist(err => {
							return nextEntry(err);
						});
					}, err => {
						return callback(err);
					});
				}
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

							//	:TODO: when blind, fileNameView should not be focus/editable
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

	displayFileDetailsPageForEntry(fileEntry, cb) {
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
					
					if(self.fileEntryHasDetectedDesc(fileEntry)) {
						descView.setText(fileEntry.desc);
						descView.setPropertyValue('mode', 'preview');

						//	:TODO: it would be nice to take this out of the focus order
					}

					const tagsView = self.viewControllers.fileDetails.getView(MciViewIds.fileDetails.tags);
					tagsView.setText( Array.from(fileEntry.hashTags).join(',') );	//	:TODO: optional 'hashTagsSep' like file list/browse

					const yearView = self.viewControllers.fileDetails.getView(MciViewIds.fileDetails.estYear);
					yearView.setText(fileEntry.meta.est_release_year || '');

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
