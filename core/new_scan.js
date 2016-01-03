/* jslint node: true */
'use strict';

//	ENiGMA½
var msgArea				= require('./message_area.js');
var Message				= require('./message.js');
var MenuModule			= require('./menu_module.js').MenuModule;
var ViewController		= require('../core/view_controller.js').ViewController;

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
 * * Add status TL/VM (either/both should update if present)
 * * 
 
*/


function NewScanModule(options) {
	MenuModule.call(this, options);

	var self	= this;
	var config	= this.menuConfig.config;

	this.currentStep		= 'messageAreas';
	this.currentScanAux		= 0;	//	Message.WellKnownAreaNames.Private

	
	this.newScanMessageArea = function(cb) {
		var availMsgAreas 	= msgArea.getAvailableMessageAreas( { includePrivate : true } );
		var currentArea		= availMsgAreas[self.currentScanAux];
		
		//
		//	Scan and update index until we find something. If results are found,
		//	we'll goto the list module & show them.
		//
		async.waterfall(
			[
				function checkAndUpdateIndex(callback) {
					//	Advance to next area if possible
					if(availMsgAreas.length >= self.currentScanAux + 1) {
						self.currentScanAux += 1;
						callback(null);
					} else {
						callback(new Error('No more areas'));
					}
				},
				function updateStatus(callback) {
					//	:TODO: Update status text
					callback(null);
				},
				function newScanAreaAndGetMessages(callback) {
					msgArea.getNewMessagesInAreaForUser(
						self.client.user.userId, currentArea.name, function msgs(err, msgList) {
							callback(err, msgList);
						}
					);
				},
				function displayMessageList(msgList, callback) {
					if(msgList && msgList.length > 0) {
						var nextModuleOpts = {
							extraArgs: {
								messageAreaName : currentArea.name,
								messageList		: msgList,
							}
						};
						
						self.gotoMenu(config.newScanMessageList || 'newScanMessageList', nextModuleOpts);
					} else {
						self.newScanMessageArea(cb);
					}
				}
			],
			cb
		);
	};

}

require('util').inherits(NewScanModule, MenuModule);

NewScanModule.prototype.getSaveState = function() {
	return {
		currentStep 	: this.currentStep,
		currentScanAux	: this.currentScanAux,
	};
};

NewScanModule.prototype.restoreSavedState = function(savedState) {
	this.currentStep 	= savedState.currentStep;
	this.currentScanAux	= savedState.currentScanAux;
};

NewScanModule.prototype.mciReady = function(mciData, cb) {

	var self	= this;
	var vc		= self.viewControllers.allViews = new ViewController( { client : self.client } );

	//	:TODO: display scan step/etc.

	async.series(		
		[
			function callParentMciReady(callback) {
				NewScanModule.super_.prototype.mciReady.call(self, mciData, callback);
			},
			function loadFromConfig(callback) {
					var loadOpts = {
					callingMenu		: self,
					mciMap			: mciData.menu,
					noInput			: true,
				};

				vc.loadFromMenuConfig(loadOpts, callback);
			},
			function performCurrentStepScan(callback) {
				switch(self.currentStep) {
					case 'messageAreas' :
						self.newScanMessageArea(function scanComplete(err) {
							callback(null);	//	finished
						});
						break;	
						
					default :
						callback(null);
				}
			}
		],
		function complete(err) {
			if(err) {
				self.client.log.error( { error : err.toString() }, 'Error during new scan');
			}
			cb(err);
		}
	);
};

/*
NewScanModule.prototype.finishedLoading = function() {
	NewScanModule.super_.prototype.finishedLoading.call(this);
};
*/