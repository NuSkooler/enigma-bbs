/* jslint node: true */
'use strict';

//	enigma-bbs
const MenuModule						= require('./menu_module.js').MenuModule;
const stringFormat						= require('./string_format.js');
const getSortedAvailableFileAreas		= require('./file_base_area.js').getSortedAvailableFileAreas;
const StatLog							= require('./stat_log.js');

//	deps
const async								= require('async');

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

			const self = this;

			async.series(
				[
					function mergeAreaStats(callback) {
						const areaStats = StatLog.getSystemStat('file_base_area_stats') || { areas : {} };

						self.availAreas.forEach(area => {
							const stats = areaStats.areas[area.areaTag];
							area.totalFiles = stats ? stats.files : 0;
							area.totalBytes	= stats ? stats.bytes : 0;
						});

						return callback(null);
					},
					function prepView(callback) {
						self.prepViewController('allViews', 0, { mciMap : mciData.menu }, (err, vc) => {
							if(err) {
								return callback(err);
							}

							const areaListView = vc.getView(MciViewIds.areaList);

							const areaListFormat = self.config.areaListFormat || '{name}';

							areaListView.setItems(self.availAreas.map(a => stringFormat(areaListFormat, a) ) );

							if(self.config.areaListFocusFormat) {
								areaListView.setFocusItems(self.availAreas.map(a => stringFormat(self.config.areaListFocusFormat, a) ) );
							}

							areaListView.redraw();

							return callback(null);
						});
					}
				],
				err => {
					return cb(err);
				}
			);
		});
	}
};
