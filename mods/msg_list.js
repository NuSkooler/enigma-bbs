/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var ViewController		= require('../core/view_controller.js').ViewController;
var messageArea			= require('../core/message_area.js');

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
//	* Single list view with advanced formatting (would need textOverflow stuff), advanced formatting...
//	* Multiple LV's in sync with keyboard input
//	* New Table LV (TV)
//	* 
//	
//	See Obv/2, Iniq, and Mystic docs

function MessageListModule(options) {
	MenuModule.call(this, options);

	var self = this;

	this.messageList = [];

	this.menuMethods = {
		selectMessage : function(formData, extraArgs) {
			if(1 === formData.submitId) {
				var selectedMessage = self.messageList[formData.value.message];
				console.log(selectedMessage)
			}
		}
	};
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
			},
			function fetchMessagesInArea(callback) {
				messageArea.getMessageListForArea( { client : self.client }, self.client.user.properties.message_area_name, function msgs(err, msgList) {
					self.messageList = msgList;
					callback(err);
				});
			},
			function populateList(callback) {
				var msgListView = vc.getView(1);

				//	:TODO: {name!over5}, ...over6, over7... -> "text..." for format()

				var msgNum = 1;
				msgListView.setItems(_.map(self.messageList, function formatMsgListEntry(mle) {
					return '{msgNum} - {subj}         {to}'.format( { 
						msgNum	: msgNum++, 
						subj	: mle.subject,
						to		: mle.toUsername
					} );
				}));

				msgListView.redraw();
			}
		],
		function complete(err) {
			if(err) {
				console.log(err)
			}
			cb(err);
		}
	);
};

