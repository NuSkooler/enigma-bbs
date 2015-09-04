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

	var config = this.menuConfig.config;
	//	config.listType : public | private

	this.listType = config.listType || 'public';

	this.messageList = [];

	this.menuMethods = {
		selectMessage : function(formData, extraArgs) {
			if(1 === formData.submitId) {
				var selected = self.messageList[formData.value.message];
				console.log(selected);
				
				//						
				//	Load full Message object
				//
				var msg = new Message();
				msg.load( { uuid : selected.messageUuid, user : self.client.user }, function loaded(err) {

					if(err) {
						//	:TODO: Now what?!
						console.log(err)
					} else {
						var modOpts = {				
							//	:TODO: get this name from config
							name		: 'messageAreaViewPost',
							extraArgs	: { message : msg },
						};

						self.client.gotoMenuModule(modOpts);
					}
				});
			}
		}
	};
}

require('util').inherits(MessageListModule, MenuModule);

MessageListModule.prototype.enter = function(client) {

	if('private' === this.listType) {
		this.messageAreaName = Message.WellKnownAreaNames.Private;
	} else {
		this.messageAreaName = client.user.properties.message_area_name;
	}

	MessageListModule.super_.prototype.enter.call(this, client);
};

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

				callback(null);
			}
		],
		function complete(err) {
			if(err) {
				//	:TODO: log this properly
				self.client.gotoMenuModule( { name : self.menuConfig.fallback } );
				console.log(err)
			}
			cb(err);
		}
	);
};

