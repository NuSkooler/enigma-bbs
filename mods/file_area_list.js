/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule		= require('../core/menu_module.js').MenuModule;
const ViewController	= require('../core/view_controller.js').ViewController;
const ansi				= require('../core/ansi_term.js');
const theme				= require('../core/theme.js');
const FileEntry			= require('../core/file_entry.js');
const stringFormat		= require('../core/string_format.js');
const FileArea			= require('../core/file_area.js');

//	deps
const async				= require('async');
const _					= require('lodash');
const moment			= require('moment');

/*
	Misc TODO
		* Allow rating to be user defined colors & characters/etc.
		* 


	Well known file entry meta values:
	* upload_by_username
	* upload_by_user_id	
	* file_md5
	* file_sha256
	* file_crc32
	* est_release_year
	* dl_count
	* byte_size
	* user_rating
	* 
*/

exports.moduleInfo = {
	name	: 'File Area List',
	desc	: 'Lists contents of file an file area',
	author	: 'NuSkooler',
};

const FormIds = {
	browse	: 0,
	details	: 1,
};

const MciViewIds = {
	browse	: {
		desc		: 1,
		navMenu		: 2,
		//	10+: customs
	},
};

exports.getModule = class FileAreaList extends MenuModule {

	constructor(options) {
		super(options);

		const config	= this.menuConfig.config;

		if(options.extraArgs) {
			this.filterCriteria	= options.extraArgs.filterCriteria;
		}

		this.filterCriteria = this.filterCriteria || { 
			//	:TODO: set area tag - all in current area by default
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

	displayBrowsePage(clearScreen, cb) {
		const self		= this;
		const config	= this.menuConfig.config;

		async.waterfall(
			[
				function clearAndDisplayArt(callback) {
					if (clearScreen) {
						self.client.term.rawWrite(ansi.resetScreen());
					}
					
					theme.displayThemedAsset(
						config.art.browse,
						self.client,
						{ font : self.menuConfig.font, trailingLF : false },
						(err, artData) => {
							return callback(err, artData);
						}
					);
				},
				function prepeareViewController(artData, callback) {
					if(_.isUndefined(self.viewControllers.browse)) {
						const vc = self.addViewController(
							'browse',
							new ViewController( { client : self.client, formId : FormIds.browse } )
						);

						const loadOpts = {
							callingMenu		: self,
							mciMap			: artData.mciMap,
							formId			: FormIds.browse,
						};

						return vc.loadFromMenuConfig(loadOpts, callback);
					}

					self.viewControllers.view.setFocus(true);
					self.viewControllers.view.getView(MciViewIds.view.BBSList).redraw();

					return callback(null);					
				},
				function fetchEntryData(callback) {
					return self.loadFileIds(callback);
				},
				function loadCurrentFileInfo(callback) {
					self.currentFileEntry = new FileEntry();
					
					self.currentFileEntry.load( self.fileList[ self.fileListPosition ], err => {
						return callback(err);
					});
				},
				function populateViews(callback) {
					if(_.isString(self.currentFileEntry.desc)) {
						const descView = self.viewControllers.browse.getView(MciViewIds.browse.desc);
						if(descView) {
							descView.setText(self.currentFileEntry.desc);
							//descView.redraw();
						}
					}
					
					const currEntry	= self.currentFileEntry;
					const uploadTimestampFormat = config.browseUploadTimestampFormat || config.uploadTimestampFormat || 'YYYY-MMM-DD';
					const area = FileArea.getFileAreaByTag(currEntry.areaTag);
					const hashTagsSep = config.hashTagsSep || ', ';
					const entryInfo = {
						fileId				: currEntry.fileId,
						areaTag				: currEntry.areaTag,
						areaName			: area.name || 'N/A',
						areaDesc			: area.desc || 'N/A',
						fileSha1			: currEntry.fileSha1,
						fileName			: currEntry.fileName,
						desc				: currEntry.desc,
						descLong			: currEntry.descLong,
						uploadByUsername	: currEntry.uploadByUsername,
						uploadTimestamp		: moment(currEntry.uploadTimestamp).format(uploadTimestampFormat),
						hashTags			: Array.from(currEntry.hashTags).join(hashTagsSep),
					};

					//
					//	We need the entry object to contain meta keys even if they are empty as
					//	consumers may very likely attempt to use them
					//
					const metaValues = FileEntry.getWellKnownMetaValues();
					metaValues.forEach(name => {
						const value = currEntry.meta[name] || '';
						entryInfo[_.camelCase(name)] = value;
					});

					//	10+ are custom textviews
					let textView;					
					let customMciId = 10;

					while( (textView = self.viewControllers.browse.getView(customMciId)) ) {
						const key		= `browseInfoFormat${customMciId}`;
						const format	= config[key];

						if(format) {
							textView.setText(stringFormat(format, entryInfo));
						}

						++customMciId;
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

	loadFileIds(cb) {
		this.fileListPosition = 0;

		FileEntry.findFiles(this.filterCriteria, (err, fileIds) => {
			this.fileList = fileIds;
			return cb(err);
		});
	}

};
