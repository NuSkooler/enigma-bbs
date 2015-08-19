/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var ViewController		= require('../core/view_controller.js').ViewController;
var messageArea			= require('../core/message_area.js');
var strUtil				= require('../core/string_util.js');
//var msgDb				= require('./database.js').dbs.message;

var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.getModule			= MessageAreaListModule;

exports.moduleInfo = {
	name	: 'Message Area List',
	desc	: 'Module for listing / choosing message areas',
	author	: 'NuSkooler',
};

function MessageAreaListModule(options) {
	MenuModule.call(this, options);

	var self = this;

	if(_.isObject(this.menuConfig.config)) {
		if(_.isString(this.menuConfig.config.entryFormat)) {
			this.entryFormat = this.menuConfig.config.entryFormat;
		}
	}

	this.entryFormat = this.entryFormat || '( {areaId} ) - {name}';

	this.menuMethods = {
		changeArea : function(formData, extraArgs) {
			if(1 === formData.submitId) {
				var areaId = self.messageAreas[formData.value.area].areaId;
				messageArea.changeCurrentArea(self.client, areaId, function areaChanged(err) {
					if(err) {
						self.client.term.write('\nCannot change area: ' + err.message + '\n');

						setTimeout(function timeout() {
							self.client.gotoMenuModule( { name : self.menuConfig.fallback } );
						}, 1000);
					} else {
						self.client.gotoMenuModule( { name : self.menuConfig.fallback } );
					}
				});
			}
		}
	};

}

require('util').inherits(MessageAreaListModule, MenuModule);

MessageAreaListModule.prototype.enter = function(client) {
	var self = this;

	messageArea.getAvailableMessageAreas(function fetched(err, areas) {
		self.messageAreas = areas;
		
		MessageAreaListModule.super_.prototype.enter.call(self, client);
	});
};

MessageAreaListModule.prototype.mciReady = function(mciData, cb) {
	var self	= this;
	var vc		= self.viewControllers.areaList = new ViewController( { client : self.client } );

	async.series(
		[
			function callParentMciReady(callback) {
				MessageAreaListModule.super_.prototype.mciReady.call(this, mciData, function parentMciReady(err) {
					callback(err);
				});
			},
			function loadFromConfig(callback) {
				var loadOpts = {
					callingMenu	: self,
					mciMap		: mciData.menu,
					formId		: 0,
				};

				vc.loadFromMenuConfig(loadOpts, function startingViewReady(err) {
					callback(err);
				});
			},
			function populateAreaListView(callback) {
				var areaListView = vc.getView(1);

				var areaList = [];
				self.messageAreas.forEach(function entry(msgArea) {
					//	:TODO: depending on options, filter out private, local user to user, etc. area IDs
					//	:TODO: dep. on options, filter out areas that current user does not have access to
					areaList.push(strUtil.format(self.entryFormat, msgArea));
				});

				areaListView.setItems(areaList);
				areaListView.redraw();
			}
		],
		function complete(err) {

		}
	);
};