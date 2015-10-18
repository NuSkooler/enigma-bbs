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

var MciCodesIds = {
	AreaList	: 1,
	CurrentArea	: 2,
};

function MessageAreaListModule(options) {
	MenuModule.call(this, options);

	var self = this;

	this.messageAreas = messageArea.getAvailableMessageAreas();

	this.menuMethods = {
		changeArea : function(formData, extraArgs) {
			if(1 === formData.submitId) {
				var areaName = self.messageAreas[formData.value.area].name;

			messageArea.changeMessageArea(self.client, areaName, function areaChanged(err) {
					if(err) {
						self.client.term.pipeWrite('\n|00Cannot change area: ' + err.message + '\n');

						setTimeout(function timeout() {
							self.client.fallbackMenuModule();
						}, 1000);
					} else {
						self.client.fallbackMenuModule();
					}
				});
			}
		}
	};

	this.setViewText = function(id, text) {
		var v = self.viewControllers.areaList.getView(id);
		if(v) {
			v.setText(text);
		}
	};

}

require('util').inherits(MessageAreaListModule, MenuModule);

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
				var listFormat 		= self.menuConfig.config.listFormat || '{index} ) - {desc}';
				var focusListFormat	= self.menuConfig.config.focusListFormat || listFormat;

				var areaListItems = [];
				var focusListItems = [];

				//	:TODO: use _.map() here
				for(var i = 0; i < self.messageAreas.length; ++i) {
					areaListItems.push(listFormat.format(
						{ index : i, name : self.messageAreas[i].name, desc : self.messageAreas[i].desc	} )
					);
					focusListItems.push(focusListFormat.format(
						{ index : i, name : self.messageAreas[i].name, desc : self.messageAreas[i].desc	} )
					);
				}

				var areaListView = vc.getView(1);
				
				areaListView.setItems(areaListItems);
				areaListView.setFocusItems(focusListItems);

				areaListView.redraw();

				callback(null);
			},
			function populateTextViews(callback) {
				//	:TODO: populate current message area desc!
				//self.setViewText(MciCodesIds.CurrentArea, 

				callback(null);
			}
		],
		function complete(err) {
			cb(null);
		}
	);
};