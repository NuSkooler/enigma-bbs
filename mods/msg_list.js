/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var ViewController		= require('../core/view_controller.js').ViewController;
var messageArea			= require('../core/message_area.js');
var Message				= require('../core/message.js');

//var moment				= require('moment');
var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');
var moment				= require('moment');

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

//	VM1		- message list
//	TL2		- Message area desc

//	TL4		- message selected # 
//	TL5		- message total #
//	
//	See Obv/2, Iniq, and Mystic docs

var MciCodesIds = {
	MsgList			: 1,
	MsgAreaDesc		: 2,
	
	MsgSelNum		: 4,
	MsgTotal		: 5,
};

function MessageListModule(options) {
	MenuModule.call(this, options);

	var self	= this;
	var config	= this.menuConfig.config;

	this.listType = config.listType || 'public';

	this.messageList = [];

	this.menuMethods = {
		selectMessage : function(formData, extraArgs) {
			if(1 === formData.submitId) {
				var modOpts = {
					name		: 'messageAreaViewPost',	//	:TODO: should come from config!!!
					extraArgs 	: {
						messageAreaName		: self.messageAreaName,
						messageList			: self.messageList,
						messageIndex		: formData.value.message,
					}
				};

				self.client.gotoMenuModule(modOpts);
			}
		}
	};

	this.setViewText = function(id, text) {
		var v = self.viewControllers.allViews.getView(id);
		if(v) {
			v.setText(text);
		}
	};
}

require('util').inherits(MessageListModule, MenuModule);

MessageListModule.prototype.enter = function(client) {
	MessageListModule.super_.prototype.enter.call(this, client);

	if('private' === this.listType) {
		this.messageAreaName = Message.WellKnownAreaNames.Private;
	} else {
		this.messageAreaName = client.user.properties.message_area_name;
	}
};

MessageListModule.prototype.mciReady = function(mciData, cb) {
	var self	= this;
	var vc		= self.viewControllers.allViews = new ViewController( { client : self.client } );

	async.series(
		[
			function callParentMciReady(callback) {
				MessageListModule.super_.prototype.mciReady.call(self, mciData, callback);
			},
			function loadFromConfig(callback) {
				var loadOpts = {
					callingMenu		: self,
					mciMap			: mciData.menu
				};

				vc.loadFromMenuConfig(loadOpts, callback);
			},
			function fetchMessagesInArea(callback) {
				messageArea.getMessageListForArea( { client : self.client }, self.messageAreaName, function msgs(err, msgList) {
					if(msgList && 0 === msgList.length) {
						callback(new Error('No messages in area'));
					} else {
						self.messageList = msgList;
						callback(err);
					}
				});
			},
			function populateList(callback) {
				var msgListView = vc.getView(MciCodesIds.MsgList);

				//	:TODO: fix default format
				var listFormat = self.menuConfig.config.listFormat || '{msgNum:>4} - {subj:>35} |{to:>15}';
				var focusListFormat = self.menuConfig.config.focusListFormat || listFormat;	//	:TODO: default change color here

				var msgNum = 1;
				var newMark = '*';	//	:TODO: Make configurable
				var dateFmt = 'ddd MMM DD';	//	:TODO: Make configurable
				msgListView.setItems(_.map(self.messageList, function formatMsgListEntry(mle) {
					return listFormat.format( { 
						msgNum	: msgNum++, 
						subj	: mle.subject,
						from	: mle.fromUserName,
						to		: mle.toUserName,
						ts		: moment(mle.modTimestamp).format(dateFmt),
						newMark	: newMark,	//	:TODO: These should only be for actual new messages!
					} );
				}));

				if(focusListFormat) {
					msgNum = 1;
					msgListView.setFocusItems(_.map(self.messageList, function formatMsgListEntry(mle) {
						return focusListFormat.format( { 
							msgNum	: msgNum++, 
							subj	: mle.subject,
							from	: mle.fromUserName,
							to		: mle.toUserName,
							ts		: moment(mle.modTimestamp).format(dateFmt),
							newMark	: newMark,
						} );
					}));
				}

				msgListView.on('index update', function indexUpdated(idx) {
					self.setViewText(MciCodesIds.MsgSelNum, (idx + 1).toString());
				});

				msgListView.redraw();

				callback(null);
			},
			function populateOtherMciViews(callback) {

				self.setViewText(MciCodesIds.MsgAreaDesc, messageArea.getMessageAreaByName(self.messageAreaName).desc);
				self.setViewText(MciCodesIds.MsgSelNum, (vc.getView(MciCodesIds.MsgList).getData() + 1).toString());
				self.setViewText(MciCodesIds.MsgTotal, self.messageList.length.toString());

				callback(null);
			},
		],
		function complete(err) {
			if(err) {
				//	:TODO: log this properly
				//	:TODO: use fallbackMenuModule() here
				self.client.gotoMenuModule( { name : self.menuConfig.fallback } );
				console.log(err)
			}
			cb(err);
		}
	);
};

