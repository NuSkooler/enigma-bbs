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
		//	10+ = customs
	},

	fileDetails : {
		desc		: 1,	//	defaults to 'desc' (e.g. from FILE_ID.DIZ)
		tags		: 2,	//	tag(s) for item
		estYear		: 3,
		accept		: 4,	//	accept fields & continue
		//	10+ = customs
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

	scanFiles(cb) {
		const self = this;

		const results = {
			newEntries	: [],
			dupes		: [],
		};

		async.eachSeries(this.recvFilePaths, (filePath, nextFilePath) => {
			//	:TODO: virus scanning/etc. should occur around here

			//	:TODO: update scanning status art or display line "scanning {fileName}..." type of thing

			self.client.term.pipeWrite(`|00|07\nScanning ${paths.basename(filePath)}...`);

			scanFile(
				filePath,
				{
					areaTag		: self.areaInfo.areaTag,
					storageTag	: self.areaInfo.storageTags[0],
				},
				(err, fileEntry, existingEntries) => {
					if(err) {
						return nextFilePath(err);
					}

					self.client.term.pipeWrite(' done\n');

					//	new or dupe?
					if(existingEntries.length > 0) {
						//	1:n dupes found
						results.dupes = results.dupes.concat(existingEntries);
					} else {
						//	new one
						results.newEntries.push(fileEntry);
					}

					return nextFilePath(null);
				}
			);
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
							if(!err) {
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
							}

							return nextEntry(err);
						});
					}, err => {
						delete self.fileDetailsCurrentEntrySubmitCallback;
						return callback(err);
					});
				}
			],
			err => {

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
		//	:TODO: If art is supplied, display & start processing + update status/etc.; if no art, we'll just write each status update on a new line
		return cb(null);
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
