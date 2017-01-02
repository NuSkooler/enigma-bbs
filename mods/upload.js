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

//	deps
const async					= require('async');
const _						= require('lodash');

exports.moduleInfo = {
	name		: 'Upload',
	desc		: 'Module for classic file uploads',
	author		: 'NuSkooler',
};

const FormIds = {
	options		: 0,
	fileDetails	: 1,

};

const MciViewIds = {
	options : {
		area		: 1,	//	area selection
		uploadType	: 2,	//	blind vs specify filename
		fileName	: 3,	//	for non-blind; not editable for blind
		navMenu		: 4,	//	next/cancel/etc.
	},

	fileDetails : {
		tags		: 1,	//	tag(s) for item
		desc		: 2,	//	defaults to 'desc' (e.g. from FILE_ID.DIZ)
		accept		: 3,	//	accept fields & continue
	}
};

exports.getModule = class UploadModule extends MenuModule {

	constructor(options) {
		super(options);

		this.availAreas = getSortedAvailableFileAreas(this.client, { writeAcs : true } );

		this.menuMethods = {
			navContinue : (formData, extraArgs, cb) => {
				if(this.isBlindUpload()) {
					//	jump to fileDetails form
					//	:TODO: support blind					
				} else {
					//	jump to protocol selection
					const areaUploadDir = this.getSelectedAreaUploadDirectory();

					const modOpts = {
						extraArgs : {
							recvDirectory	: areaUploadDir,
							direction		: 'recv',
						}
					};

					return this.gotoMenu(this.menuConfig.config.fileTransferProtocolSelection || 'fileTransferProtocolSelection', modOpts, cb);					
				}
			}
		};	
	}

	getSelectedAreaUploadDirectory() {
		const areaSelectView	= this.viewControllers.options.getView(MciViewIds.options.area);
		const selectedArea		= this.availAreas[areaSelectView.getData()];
		
		return getAreaDefaultStorageDirectory(selectedArea);
	}

	isBlindUpload() { return 'blind' === this.uploadType; }

	initSequence() {
		const self = this;

		async.series(
			[
				function before(callback) {
					return self.beforeArt(callback);
				},
				function display(callback) {
					return self.displayOptionsPage(false, callback);
				}
			],
			() => {
				return self.finishedLoading();
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

};
