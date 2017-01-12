/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule		= require('../core/menu_module.js').MenuModule;
const ViewController	= require('../core/view_controller.js').ViewController;
const ansi				= require('../core/ansi_term.js');
const theme				= require('../core/theme.js');
const FileEntry			= require('../core/file_entry.js');
const stringFormat		= require('../core/string_format.js');
const createCleanAnsi	= require('../core/string_util.js').createCleanAnsi;
const FileArea			= require('../core/file_area.js');
const Errors			= require('../core/enig_error.js').Errors;
const ArchiveUtil		= require('../core/archive_util.js');
const Config			= require('../core/config.js').config;
const DownloadQueue		= require('../core/download_queue.js');
const FileAreaWeb		= require('../core/file_area_web.js');
const FileBaseFilters	= require('../core/file_base_filter.js');

const cleanControlCodes	= require('../core/string_util.js').cleanControlCodes;

//	deps
const async				= require('async');
const _					= require('lodash');
const moment			= require('moment');
const paths				= require('path');

/*
	Misc TODO
	 
*/

exports.moduleInfo = {
	name	: 'File Area List',
	desc	: 'Lists contents of file an file area',
	author	: 'NuSkooler',
};

const FormIds = {
	browse			: 0,
	details			: 1,
	detailsGeneral	: 2,
	detailsNfo		: 3,
	detailsFileList	: 4,
};

const MciViewIds = {
	browse	: {
		desc		: 1,
		navMenu		: 2,
		//	10+ = customs
	},
	details	: {
		navMenu			: 1,
		infoXyTop		: 2,	//	%XY starting position for info area
		infoXyBottom	: 3,
		//	10+ = customs
	},
	detailsGeneral : {
		//	10+ = customs
	},
	detailsNfo : {
		nfo		: 1,
		//	10+ = customs
	},
	detailsFileList : {
		fileList	: 1,
		//	10+ = customs
	},
};

exports.getModule = class FileAreaList extends MenuModule {

	constructor(options) {
		super(options);

		if(options.extraArgs) {
			this.filterCriteria	= options.extraArgs.filterCriteria;
		}

		this.dlQueue = new DownloadQueue(this.client);

		this.filterCriteria = this.filterCriteria || { 
			//	:TODO: set area tag - all in current area by default
		};

		this.menuMethods = {
			nextFile : (formData, extraArgs, cb) => {		
				if(this.fileListPosition + 1 < this.fileList.length) {
					this.fileListPosition += 1;

					return this.displayBrowsePage(true, cb);	//	true=clerarScreen
				}

				return cb(null);
			},
			prevFile : (formData, extraArgs, cb) => {
				if(this.fileListPosition > 0) {
					--this.fileListPosition;

					return this.displayBrowsePage(true, cb);	//	true=clearScreen
				}

				return cb(null);
			},
			viewDetails : (formData, extraArgs, cb) => {
				this.viewControllers.browse.setFocus(false);
				return this.displayDetailsPage(cb);
			},
			detailsQuit : (formData, extraArgs, cb) => {
				this.viewControllers.details.setFocus(false);
				return this.displayBrowsePage(true, cb);	//	true=clearScreen
			},
			toggleQueue : (formData, extraArgs, cb) => {
				this.dlQueue.toggle(this.currentFileEntry);
				this.updateQueueIndicator();
				return cb(null);  
			},
			showWebDownloadLink : (formData, extraArgs, cb) => {
				return this.fetchAndDisplayWebDownloadLink(cb);
			},
		};
	}

	enter() {
		super.enter();
	}

	leave() {
		super.leave();
	}

	initSequence() {
		const self = this;

		async.series(
			[
				function beforeArt(callback) {
					return self.beforeArt(callback);
				},
				function display(callback) {
					return self.displayBrowsePage(false, callback);
				}
			],
			() => {
				self.finishedLoading();
			}
		);
	}

	populateCurrentEntryInfo(cb) {
		const config		= this.menuConfig.config;
		const currEntry		= this.currentFileEntry;

		const uploadTimestampFormat = config.browseUploadTimestampFormat || config.uploadTimestampFormat || 'YYYY-MMM-DD';
		const area					= FileArea.getFileAreaByTag(currEntry.areaTag);
		const hashTagsSep			= config.hashTagsSep || ', ';
		const isQueuedIndicator		= config.isQueuedIndicator || 'Y';
		const isNotQueuedIndicator	= config.isNotQueuedIndicator || 'N';
		
		const entryInfo = this.currentFileEntry.entryInfo = {
			fileId				: currEntry.fileId,
			areaTag				: currEntry.areaTag,
			areaName			: area.name || 'N/A',
			areaDesc			: area.desc || 'N/A',
			fileSha1			: currEntry.fileSha1,
			fileName			: currEntry.fileName,
			desc				: currEntry.desc || '',
			descLong			: currEntry.descLong || '',
			uploadTimestamp		: moment(currEntry.uploadTimestamp).format(uploadTimestampFormat),
			hashTags			: Array.from(currEntry.hashTags).join(hashTagsSep),
			isQueued			: this.dlQueue.isQueued(this.currentFileEntry) ? isQueuedIndicator : isNotQueuedIndicator,
			webDlLink			: '',	//	:TODO: fetch web any existing web d/l link
			webDlExpire			: '',	//	:TODO: fetch web d/l link expire time
		};

		//
		//	We need the entry object to contain meta keys even if they are empty as
		//	consumers may very likely attempt to use them
		//
		const metaValues = FileEntry.getWellKnownMetaValues();
		metaValues.forEach(name => {
			const value = !_.isUndefined(currEntry.meta[name]) ? currEntry.meta[name] : 'N/A';
			entryInfo[_.camelCase(name)] = value;
		});

		if(entryInfo.archiveType) {
			entryInfo.archiveTypeDesc = _.has(Config, [ 'archives', 'formats', entryInfo.archiveType, 'desc' ]) ?
				Config.archives.formats[entryInfo.archiveType].desc :
				entryInfo.archiveType;
		} else {
			entryInfo.archiveTypeDesc = 'N/A';
		}

		entryInfo.uploadByUsername 	= entryInfo.uploadByUsername || 'N/A';	//	may be imported
		entryInfo.hashTags			= entryInfo.hashTags || '(none)';

		//	create a rating string, e.g. "**---"
		const userRatingTicked		= config.userRatingTicked || '*';
		const userRatingUnticked	= config.userRatingUnticked || '';					
		entryInfo.userRating		= entryInfo.userRating || 0;	//	be safe!
		entryInfo.userRatingString	= new Array(entryInfo.userRating + 1).join(userRatingTicked);
		if(entryInfo.userRating < 5) {
			entryInfo.userRatingString += new Array( (5 - entryInfo.userRating) + 1).join(userRatingUnticked);
		}

		FileAreaWeb.getExistingTempDownloadServeItem(this.client, this.currentFileEntry, (err, serveItem) => {
			if(err) {
				entryInfo.webDlLink 	= config.webDlLinkNeedsGenerated || 'Not yet generated';
				entryInfo.webDlExpire	= '';
			} else {
				const webDlExpireTimeFormat = config.webDlExpireTimeFormat || 'YYYY-MMM-DD @ h:mm';

				entryInfo.webDlLink		= serveItem.url;
				entryInfo.webDlExpire	= moment(serveItem.expireTimestamp).format(webDlExpireTimeFormat);
			}

			return cb(null);
		});
	}

	populateCustomLabels(category, startId) {
		return this.updateCustomLabelsWithFilter(category, startId);
	}

	updateCustomLabelsWithFilter(category, startId, filter) {
		let textView;					
		let customMciId = startId;
		const config	= this.menuConfig.config;

		while( (textView = this.viewControllers[category].getView(customMciId)) ) {
			const key		= `${category}InfoFormat${customMciId}`;
			const format	= config[key];

			if(format && (!filter || filter.find(f => format.indexOf(f) > - 1))) {
				textView.setText(stringFormat(format, this.currentFileEntry.entryInfo));
			}

			++customMciId;
		}
	}

	displayArtAndPrepViewController(name, options, cb) {
		const self		= this;
		const config	= this.menuConfig.config;

		async.waterfall(
			[
				function readyAndDisplayArt(callback) {
					if(options.clearScreen) {
						self.client.term.rawWrite(ansi.clearScreen());
					}

					theme.displayThemedAsset(
						config.art[name],
						self.client,
						{ font : self.menuConfig.font, trailingLF : false },
						(err, artData) => {
							return callback(err, artData);
						}
					);
				},
				function prepeareViewController(artData, callback) {
					if(_.isUndefined(self.viewControllers[name])) {
						const vcOpts = {
							client		: self.client,
							formId		: FormIds[name],
						};

						if(!_.isUndefined(options.noInput)) {
							vcOpts.noInput = options.noInput;
						}

						const vc = self.addViewController(name, new ViewController(vcOpts));

						if('details' === name) {
							try {
								self.detailsInfoArea = {
									top		: artData.mciMap.XY2.position,
									bottom	: artData.mciMap.XY3.position,
								};
							} catch(e) {
								return callback(Errors.DoesNotExist('Missing XY2 and XY3 position indicators!'));
							}
						}

						const loadOpts = {
							callingMenu		: self,
							mciMap			: artData.mciMap,
							formId			: FormIds[name],
						};

						return vc.loadFromMenuConfig(loadOpts, callback);
					}
					
					self.viewControllers[name].setFocus(true);
					return callback(null);
										
				},
			],
			err => {
				return cb(err);
			}
		);
	}

	displayBrowsePage(clearScreen, cb) {
		const self		= this;

		async.series(
			[
				function prepArtAndViewController(callback) {
					return self.displayArtAndPrepViewController('browse', { clearScreen : clearScreen }, callback);
				},
				function fetchEntryData(callback) {
					if(self.fileList) {
						return callback(null);
					}
					return self.loadFileIds(callback);
				},
				function loadCurrentFileInfo(callback) {
					self.currentFileEntry = new FileEntry();

					self.currentFileEntry.load( self.fileList[ self.fileListPosition ], err => {
						if(err) {
							return callback(err);
						}
						
						return self.populateCurrentEntryInfo(callback);
					});
				},
				function populateViews(callback) {
					if(_.isString(self.currentFileEntry.desc)) {
						const descView = self.viewControllers.browse.getView(MciViewIds.browse.desc);
						if(descView) {					
							/* :TODO: finish createCleanAnsi() and use here!!!
							createCleanAnsi(
								self.currentFileEntry.desc, 
								{ height : self.client.termHeight, width : descView.dimens.width },
								cleanDesc => {
									descView.setText(cleanDesc);

									self.updateQueueIndicator();
									self.populateCustomLabels('browse', 10);

									return callback(null);
								}
							);	
							*/

							descView.setText( self.currentFileEntry.desc );
						}
					} else {
						self.updateQueueIndicator();
						self.populateCustomLabels('browse', 10);

						return callback(null);
					}
				}
			],
			err => {
				if(cb) {
					return cb(err);
				}
			}
		);
	}

	displayDetailsPage(cb) {
		const self		= this;

		async.series(
			[
				function prepArtAndViewController(callback) {
					return self.displayArtAndPrepViewController('details', { clearScreen : true }, callback);
				},
				function populateViews(callback) {
					self.populateCustomLabels('details', 10);
					return callback(null);
				},
				function prepSection(callback) {
					return self.displayDetailsSection('general', false, callback);
				},
				function listenNavChanges(callback) {
					const navMenu = self.viewControllers.details.getView(MciViewIds.details.navMenu);
					navMenu.setFocusItemIndex(0);
					
					navMenu.on('index update', index => {
						const sectionName = {
							0	: 'general',
							1	: 'nfo',
							2	: 'fileList',
						}[index];

						if(sectionName) {
							self.displayDetailsSection(sectionName, true);
						}
					});

					return callback(null);
				}
			],
			err => {
				return cb(err);
			}
		);
	}
	
	fetchAndDisplayWebDownloadLink(cb) {
		const self = this;

		async.series(
			[
				function generateLinkIfNeeded(callback) {

					if(self.currentFileEntry.webDlExpireTime < moment()) {
						return callback(null);
					}
					
					const expireTime = moment().add(Config.fileBase.web.expireMinutes, 'minutes');

					FileAreaWeb.createAndServeTempDownload(
						self.client, 
						self.currentFileEntry,
						{ expireTime : expireTime },
						(err, url) => {
							if(err) {
								return callback(err);
							}

							self.currentFileEntry.webDlExpireTime = expireTime;

							const webDlExpireTimeFormat = self.menuConfig.config.webDlExpireTimeFormat || 'YYYY-MMM-DD @ h:mm';

							self.currentFileEntry.entryInfo.webDlLink 	= url;
							self.currentFileEntry.entryInfo.webDlExpire	= expireTime.format(webDlExpireTimeFormat);

							return callback(null);
						}
					);
				},
				function updateActiveViews(callback) {
					self.updateCustomLabelsWithFilter( 'browse', 10, [ '{webDlLink}', '{webDlExpire}' ] );
					return callback(null);
				}
			],
			err => {
				return cb(err);
			}
		);		
	}

	updateQueueIndicator() {
		const isQueuedIndicator		= this.menuConfig.config.isQueuedIndicator || 'Y';
		const isNotQueuedIndicator	= this.menuConfig.config.isNotQueuedIndicator || 'N';

		this.currentFileEntry.entryInfo.isQueued = stringFormat(
			this.dlQueue.isQueued(this.currentFileEntry) ? 
				isQueuedIndicator : 
				isNotQueuedIndicator
		);

		this.updateCustomLabelsWithFilter( 'browse', 10, [ '{isQueued}' ] );
	}

	cacheArchiveEntries(cb) {
		//	check cache
		if(this.currentFileEntry.archiveEntries) {
			return cb(null, 'cache');
		}

		const areaInfo = FileArea.getFileAreaByTag(this.currentFileEntry.areaTag);
		if(!areaInfo) {
			return cb(Errors.Invalid('Invalid area tag'));
		}
		
		const filePath		= this.currentFileEntry.filePath;
		const archiveUtil	= ArchiveUtil.getInstance();

		archiveUtil.listEntries(filePath, this.currentFileEntry.entryInfo.archiveType, (err, entries) => {
			if(err) {
				return cb(err);
			}

			this.currentFileEntry.archiveEntries = entries;
			return cb(null, 're-cached');
		});
	}

	populateFileListing() {
		const fileListView = this.viewControllers.detailsFileList.getView(MciViewIds.detailsFileList.fileList);
		
		if(this.currentFileEntry.entryInfo.archiveType) {
			this.cacheArchiveEntries( (err, cacheStatus) => {
				if(err) {
					//	:TODO: Handle me!!!
					fileListView.setItems( [ 'Failed getting file listing' ] );	//	:TODO: make this not suck
					return;
				}

				if('re-cached' === cacheStatus) {
					const fileListEntryFormat 		= this.menuConfig.config.fileListEntryFormat || '{fileName} {fileSize}';	//	:TODO: use byteSize here?
					const focusFileListEntryFormat	= this.menuConfig.config.focusFileListEntryFormat || fileListEntryFormat;
					
					fileListView.setItems( this.currentFileEntry.archiveEntries.map( entry => stringFormat(fileListEntryFormat, entry) ) );
					fileListView.setFocusItems( this.currentFileEntry.archiveEntries.map( entry => stringFormat(focusFileListEntryFormat, entry) ) );

					fileListView.redraw();
				}
			});
		} else {
			fileListView.setItems( [ stringFormat(this.menuConfig.config.notAnArchiveFormat || 'Not an archive', { fileName : this.currentFileEntry.fileName } ) ] );	
		}
	}

	displayDetailsSection(sectionName, clearArea, cb) {
		const self		= this;
		const name		= `details${_.capitalize(sectionName)}`;

		async.series(
			[
				function detachPrevious(callback) {
					if(self.lastDetailsViewController) {
						self.lastDetailsViewController.detachClientEvents();
					}
					return callback(null); 
				},
				function prepArtAndViewController(callback) {

					function gotoTopPos() {
						self.client.term.rawWrite(ansi.goto(self.detailsInfoArea.top[0], 1));
					}

					gotoTopPos();  

					if(clearArea) {
						self.client.term.rawWrite(ansi.reset());

						let pos 		= self.detailsInfoArea.top[0];
						const bottom	= self.detailsInfoArea.bottom[0];

						while(pos++ <= bottom) {
							self.client.term.rawWrite(ansi.eraseLine() + ansi.down());
						}

						gotoTopPos();
					}

					return self.displayArtAndPrepViewController(name, { clearScreen : false, noInput : true }, callback);
				},
				function populateViews(callback) {
					self.lastDetailsViewController = self.viewControllers[name];

					switch(sectionName) {
						case 'nfo' :
							{
								const nfoView = self.viewControllers.detailsNfo.getView(MciViewIds.detailsNfo.nfo);
								if(nfoView) {
									nfoView.setText(self.currentFileEntry.entryInfo.descLong);
								}
							}
							break;

						case 'fileList' :
							self.populateFileListing();
							break;
					}

					self.populateCustomLabels(name, 10);
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

	loadFileIds(cb) {
		this.fileListPosition	= 0;
		const activeFilter		= FileBaseFilters.getActiveFilter(this.client);

		FileEntry.findFiles(activeFilter, (err, fileIds) => {
			this.fileList = fileIds;
			return cb(err);
		});
	}

};
