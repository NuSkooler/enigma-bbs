/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var ViewController		= require('../core/view_controller.js').ViewController;

//var moment				= require('moment');
var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.getModule		= MessageListModule;

exports.moduleInfo = {
	name	: 'Message List',
	desc	: 'Module for listing/browsing available messages',
	author	: 'NuSkooler',
};

//
//	:TODO:
//	* Avail data:
//		To					- {to}
//		From				- {from}
//		Subject
//		Date
//		Status (New/Read)
//		Message Num (Area)
//		Message Total (Area)
//		Message Area desc	- {areaDesc} / %TL2
//		Message Area Name	- {areaName}
//		
//	Ideas
//	* Module config can define custom formats for items & focused items (inc. Pipe Codes)
//	* Single list view with advanced formatting (would need textOverflow stuff)
//	* Multiple LV's in sync with keyboard input
//	* New Table LV (TV)
//	* 
//	
//	See Obv/2, Iniq, and Mystic docs

function MessageListModule(options) {
	MenuModule.call(this, options);

	var self = this;
}

require('util').inherits(MessageListModule, MenuModule);

MessageListModule.prototype.mciReady = function(mciData, cb) {
	var self	= this;

	var vc		= self.viewControllers.msgList = new ViewController( { client : self.client } );

	async.series(
		[
			function callParentMciReady(callback) {
				MessageListModule.super_.prototype.mciReady.call(this, mciData, callback);
			},
			function loadFromConfig(callback) {
				var loadOpts = {
					callingMenu		: self,
					mciMap			: mciData.menu
				};

				vc.loadFromMenuConfig(loadOpts, callback);
			}
		],
		function complete(err) {
			cb(err);
		}
	);
};

