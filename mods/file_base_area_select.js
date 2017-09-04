/* jslint node: true */
'use strict';

//	enigma-bbs
const MenuModule						= require('../core/menu_module.js').MenuModule;
const Config							= require('../core/config.js').config;
const stringFormat						= require('../core/string_format.js');
const ViewController					= require('../core/view_controller.js').ViewController;
const getSortedAvailableFileAreas		= require('../core/file_base_area.js').getSortedAvailableFileAreas;

//	deps
const async			= require('async');
const _				= require('lodash');

exports.moduleInfo = {
	name	: 'File Area Selector',
	desc	: 'Select from available file areas',
	author	: 'NuSkooler',
};

const MciViewIds = {
	areaList	: 1,
};

exports.getModule = class FileAreaSelectModule extends MenuModule {
	constructor(options) {
		super(options);

		this.config = this.menuConfig.config || {};

		this.loadAvailAreas();

		this.menuMethods = {
			selectArea : (formData, extraArgs, cb) => {
				const area = this.availAreas[formData.value.areaSelect] || 0;

				const filterCriteria = {
					areaTag		: area.areaTag,
				};

				const menuOpts = {
					extraArgs	: {
						filterCriteria	: filterCriteria,				
					},
					menuFlags	: [ 'noHistory' ],
				};

				return this.gotoMenu(this.menuConfig.config.fileBaseListEntriesMenu || 'fileBaseListEntries', menuOpts, cb);
			}
		};
	}

	loadAvailAreas() {
		this.availAreas = getSortedAvailableFileAreas(this.client);
	}

	mciReady(mciData, cb) {
		super.mciReady(mciData, err => {
			if(err) {
				return cb(err);
			}

			this.prepViewController('allViews', 0, { mciMap : mciData.menu }, (err, vc) => {
				if(err) {
					return cb(err);
				}

				const areaListView = vc.getView(MciViewIds.areaList);

				const areaListFormat = this.config.areaListFormat || '{name}';

				areaListView.setItems(this.availAreas.map(a => stringFormat(areaListFormat, a) ) );

				if(this.config.areaListFocusFormat) {
					areaListView.setFocusItems(this.availAreas.map(a => stringFormat(this.config.areaListFocusFormat, a) ) );
				}

				areaListView.redraw();

				return cb(null);
			});
		});
	}
};
