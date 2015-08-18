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
			console.log(formData)
		}
	};

}

require('util').inherits(MessageAreaListModule, MenuModule);

MessageAreaListModule.prototype.mciReady = function(mciData, cb) {
	var self	= this;
	var vc		= self.viewControllers.areaList = new ViewController( { client : self.client } );

	var messageAreas = [];

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
					noInput		: true,
				};

				vc.loadFromMenuConfig(loadOpts, function startingViewReady(err) {
					callback(err);
				});
			},
			function fetchAreaData(callback) {
				messageArea.getAvailableMessageAreas(function fetched(err, areas) {
					messageAreas = areas;
					callback(err);
				});
			},
			function populateAreaListView(callback) {
				var areaListView = vc.getView(1);

				var areaList = [];
				messageAreas.forEach(function entry(msgArea) {
					areaList.push(strUtil.format(self.entryFormat, msgArea));
				});

				console.log(areaList)

				areaListView.setItems(areaList);
				areaListView.redraw();
			}
		],
		function complete(err) {

		}
	);
};