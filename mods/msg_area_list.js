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

function MessageAreaListModule(options) {
	MenuModule.call(this, options);

	var self = this;

	this.messageAreas = messageArea.getAvailableMessageAreas();

	if(_.isObject(this.menuConfig.config)) {
		if(_.isString(this.menuConfig.config.entryFormat)) {
			this.entryFormat = this.menuConfig.config.entryFormat;
		}
	}

	this.entryFormat = this.entryFormat || '( {index} ) - {desc}';

	this.menuMethods = {
		changeArea : function(formData, extraArgs) {
			if(1 === formData.submitId) {
				var areaName = self.messageAreas[formData.value.area].name;

				messageArea.changeMessageArea(self.client, areaName, function areaChanged(err) {
					if(err) {
						self.client.term.pipeWrite('\n|00Cannot change area: ' + err.message + '\n');

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
/*
MessageAreaListModule.prototype.enter = function(client) {
	this.messageAreas = messageArea.getAvailableMessageAreas();

	MessageAreaListModule.super_.prototype.enter.call(this, client);
};
*/

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
				var areaListItems = [];
				for(var i = 0; i < self.messageAreas.length; ++i) {
					areaListItems.push(self.entryFormat.format(
						{ index : i, name : self.messageAreas[i].name, desc : self.messageAreas[i].desc	} )
					);
				}

				var areaListView = vc.getView(1);
				areaListView.setItems(areaListItems);
				areaListView.redraw();
			}
		],
		function complete(err) {
			cb(null);
		}
	);
};