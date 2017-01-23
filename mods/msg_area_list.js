/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule			= require('../core/menu_module.js').MenuModule;
const ViewController		= require('../core/view_controller.js').ViewController;
const messageArea			= require('../core/message_area.js');
const displayThemeArt		= require('../core/theme.js').displayThemeArt;
const displayThemedPause	= require('../core/theme.js').displayThemedPause;
const resetScreen			= require('../core/ansi_term.js').resetScreen;
const stringFormat			= require('../core/string_format.js');

//	deps
const async				= require('async');
const _					= require('lodash');

exports.getModule			= MessageAreaListModule;

exports.moduleInfo = {
	name	: 'Message Area List',
	desc	: 'Module for listing / choosing message areas',
	author	: 'NuSkooler',
};

/*
	:TODO:

	Obv/2 has the following:
	CHANGE .ANS - Message base changing ansi
          |SN      Current base name
          |SS      Current base sponsor
          |NM      Number of messages in current base
          |UP      Number of posts current user made (total)
          |LR      Last read message by current user
          |DT      Current date
          |TI      Current time
*/

const MCICodesIDs = {
	AreaList		: 1,
	SelAreaInfo1	: 2,
	SelAreaInfo2	: 3, 
};

function MessageAreaListModule(options) {
	MenuModule.call(this, options);

	var self = this;

	this.messageAreas = messageArea.getSortedAvailMessageAreasByConfTag(
         self.client.user.properties.message_conf_tag,
        { client : self.client }
    );

	this.prevMenuOnTimeout = function(timeout, cb) {
		setTimeout( () => {
			self.prevMenu(cb);
		}, timeout);
	};

	this.menuMethods = {
		changeArea : function(formData, extraArgs, cb) {
			if(1 === formData.submitId) {
				let area 		= self.messageAreas[formData.value.area];
				const areaTag	=  area.areaTag;
				area = area.area;	//	what we want is actually embedded

				messageArea.changeMessageArea(self.client, areaTag, err => {
					if(err) {
						self.client.term.pipeWrite(`\n|00Cannot change area: ${err.message}\n`);

						self.prevMenuOnTimeout(1000, cb);
					} else {						
						if(_.isString(area.art)) {
							const dispOptions = {
								client	: self.client,
								name	: area.art,
							};

							self.client.term.rawWrite(resetScreen());

							displayThemeArt(dispOptions, () => {
								//	pause by default, unless explicitly told not to
								if(_.has(area, 'options.pause') && false === area.options.pause) { 
									return self.prevMenuOnTimeout(1000, cb);
								} else {
									//	:TODO: Use MenuModule.pausePrompt()
									displayThemedPause( { client : self.client }, () => {
										return self.prevMenu(cb);
									});
								}
							});
						} else {
							return self.prevMenu(cb);
						}
					}
				});
			} else {
				return cb(null);
			}
		}
	};

	this.setViewText = function(id, text) {
		const v = self.viewControllers.areaList.getView(id);
		if(v) {
			v.setText(text);
		}
	};

	this.updateGeneralAreaInfoViews = function(areaIndex) {
		/* experimental: not yet avail
		const areaInfo = self.messageAreas[areaIndex];

		[ MCICodesIDs.SelAreaInfo1, MCICodesIDs.SelAreaInfo2 ].forEach(mciId => {
			const v = self.viewControllers.areaList.getView(mciId);
			if(v) {
				v.setFormatObject(areaInfo.area);
			}
		});
		*/
	};

}

require('util').inherits(MessageAreaListModule, MenuModule);

MessageAreaListModule.prototype.mciReady = function(mciData, cb) {
	const self	= this;
	const vc	= self.viewControllers.areaList = new ViewController( { client : self.client } );

	async.series(
		[
			function callParentMciReady(callback) {
				MessageAreaListModule.super_.prototype.mciReady.call(this, mciData, function parentMciReady(err) {
					callback(err);
				});
			},
			function loadFromConfig(callback) {
				const loadOpts = {
					callingMenu	: self,
					mciMap		: mciData.menu,
					formId		: 0,
				};

				vc.loadFromMenuConfig(loadOpts, function startingViewReady(err) {
					callback(err);
				});
			},
			function populateAreaListView(callback) {
				const listFormat 		= self.menuConfig.config.listFormat || '{index} ) - {name}';
				const focusListFormat	= self.menuConfig.config.focusListFormat || listFormat;
                
				const areaListView = vc.getView(MCICodesIDs.AreaList);
				let i = 1;
				areaListView.setItems(_.map(self.messageAreas, v => {
					return stringFormat(listFormat, {
						index   : i++,
						areaTag : v.area.areaTag,
						name    : v.area.name,
						desc    : v.area.desc, 
					});
				}));

				i = 1;
				areaListView.setFocusItems(_.map(self.messageAreas, v => {
					return stringFormat(focusListFormat, {
						index   : i++,
						areaTag : v.area.areaTag,
						name    : v.area.name,
						desc    : v.area.desc, 
					});
				}));

				areaListView.on('index update', areaIndex => {
					self.updateGeneralAreaInfoViews(areaIndex);
				});

				areaListView.redraw();

				callback(null);
			}
		],
		function complete(err) {
			return cb(err);
		}
	);
};