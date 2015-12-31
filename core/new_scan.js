/* jslint node: true */
'use strict';

//	ENiGMA½
var msgArea				= require('./message_area.js');
var Message				= require('./message.js');
var MenuModule			= require('./menu_module.js').MenuModule;

var async				= require('async');

exports.moduleInfo = {
	name		: 'New Scan',
	desc		: 'Performs a new scan against various areas of the system',
	author		: 'NuSkooler',
};

exports.getModule = NewScanModule;

/*
 * :TODO:
 * * Update message ID when reading (this should be working!)
 * * New scan all areas
 * * User configurable new scan: Area selection (avail from messages area)
 * 
 *
 
*/


function NewScanModule(options) {
	MenuModule.call(this, options);

	var self	= this;
	var config	= this.menuConfig.config;

	this.currentStep = 'privateMail';

	this.newScanMessageArea = function(areaName, cb) {
		async.waterfall(
			[
				function newScanAreaAndGetMessages(callback) {
					msgArea.getNewMessagesInAreaForUser(
						self.client.user.userId, areaName, function msgs(err, msgList) {
							callback(err, msgList);
						}
					);
				},
				function displayMessageList(msgList, callback) {
					if(msgList && msgList.length > 0) {
						var nextModuleOpts = {
							extraArgs: {
								messageAreaName : areaName,
								messageList		: msgList,
							}
						};
						
						self.gotoMenu(config.newScanMessageList || 'newScanMessageList', nextModuleOpts);
					} else {
						callback(null);
					}
				}
			],
			function complete(err) {
				cb(err);
			}
		);
	};
}

require('util').inherits(NewScanModule, MenuModule);

NewScanModule.prototype.getSaveState = function() {
	return {
		currentStep : this.currentStep,
	};
};

NewScanModule.prototype.restoreSavedState = function(savedState) {
	this.currentStep = savedState.currentStep;
};

NewScanModule.prototype.mciReady = function(mciData, cb) {

	var self = this;

	//	:TODO: display scan step/etc.

	switch(this.currentStep) {
		case 'privateMail' :
			self.currentStep = 'finished';
			self.newScanMessageArea(Message.WellKnownAreaNames.Private, cb);
			break;	
			
		default :
			cb(null);
	}

};

/*
NewScanModule.prototype.finishedLoading = function() {
	NewScanModule.super_.prototype.finishedLoading.call(this);
};
*/