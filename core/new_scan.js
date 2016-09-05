/* jslint node: true */
'use strict';

//	ENiGMA½
const msgArea			= require('./message_area.js');
const MenuModule		= require('./menu_module.js').MenuModule;
const ViewController	= require('./view_controller.js').ViewController;
const stringFormat		= require('./string_format.js');

//	deps
const _					= require('lodash');
const async				= require('async');

exports.moduleInfo = {
	name		: 'New Scan',
	desc		: 'Performs a new scan against various areas of the system',
	author		: 'NuSkooler',
};

exports.getModule = NewScanModule;

/*
 * :TODO:
 * * User configurable new scan: Area selection (avail from messages area) (sep module)
 * * Add status TL/VM (either/both should update if present)
 * * 
 
*/

var MciCodeIds = {
	ScanStatusLabel	: 1,	//	TL1
	ScanStatusList	: 2,	//	VM2 (appends)
};

function NewScanModule(options) {
	MenuModule.call(this, options);

	var self	= this;
	var config	= this.menuConfig.config;

	this.newScanFullExit	= _.has(options, 'lastMenuResult.fullExit') ? options.lastMenuResult.fullExit : false;

	this.currentStep		= 'messageConferences';
	this.currentScanAux		= {};

    //  :TODO: Make this conf/area specific:
	this.scanStartFmt		= config.scanStartFmt || 'Scanning {confName} - {areaName}...';
	this.scanFinishNoneFmt	= config.scanFinishNoneFmt || 'Nothing new';
	this.scanFinishNewFmt	= config.scanFinishNewFmt || '{count} entries found';
	this.scanCompleteMsg	= config.scanCompleteMsg || 'Finished newscan';

	this.updateScanStatus = function(statusText) {
		var vc = self.viewControllers.allViews;
		
		var view = vc.getView(MciCodeIds.ScanStatusLabel);
		if(view) {
			view.setText(statusText);
		}

		view = vc.getView(MciCodeIds.ScanStatusList);
		//	:TODO: MenuView needs appendItem()
		if(view) {			
		}
	};
    
	this.newScanMessageConference = function(cb) {
        //  lazy init
		if(!self.sortedMessageConfs) {
			const getAvailOpts = { includeSystemInternal : true };      //  find new private messages, bulletins, etc.            

			self.sortedMessageConfs = _.map(msgArea.getAvailableMessageConferences(self.client, getAvailOpts), (v, k) => {
				return {
					confTag : k,
					conf    : v,  
				};
			});

			//
			//	Sort conferences by name, other than 'system_internal' which should
			//	always come first such that we display private mails/etc. before
			//	other conferences & areas
			//
			self.sortedMessageConfs.sort((a, b) => {
				if('system_internal' === a.confTag) {
					return -1;
				} else {
					return a.conf.name.localeCompare(b.conf.name);
				}
			});

			self.currentScanAux.conf = self.currentScanAux.conf || 0;
			self.currentScanAux.area = self.currentScanAux.area || 0;
		}
        
		const currentConf = self.sortedMessageConfs[self.currentScanAux.conf];
        
		async.series(
			[
				function scanArea(callback) {
					//self.currentScanAux.area = self.currentScanAux.area || 0;
					
					self.newScanMessageArea(currentConf, () => {
						if(self.sortedMessageConfs.length > self.currentScanAux.conf + 1) {
							self.currentScanAux.conf += 1;                            
							self.currentScanAux.area = 0;
							
							self.newScanMessageConference(cb);  //  recursive to next conf
							//callback(null);
						} else {
							self.updateScanStatus(self.scanCompleteMsg);
							callback(new Error('No more conferences'));
						} 
					});
				}
			],
			cb 
        );
	};
	
	this.newScanMessageArea = function(conf, cb) {
        //  :TODO: it would be nice to cache this - must be done by conf!
		const sortedAreas   = msgArea.getSortedAvailMessageAreasByConfTag(conf.confTag, { client : self.client } );
		const currentArea	= sortedAreas[self.currentScanAux.area];
				
		//
		//	Scan and update index until we find something. If results are found,
		//	we'll goto the list module & show them.
		//
		async.waterfall(
			[
				function checkAndUpdateIndex(callback) {
					//	Advance to next area if possible
					if(sortedAreas.length >= self.currentScanAux.area + 1) {
						self.currentScanAux.area += 1;
						return callback(null);
					} else {
						self.updateScanStatus(self.scanCompleteMsg);
						return callback(new Error('No more areas'));	//	this will stop our scan
					}
				},
				function updateStatusScanStarted(callback) {
					self.updateScanStatus(stringFormat(self.scanStartFmt, {
						confName    : conf.conf.name,
						confDesc    : conf.conf.desc,
						areaName    : currentArea.area.name,
						areaDesc    : currentArea.area.desc
					}));
					return callback(null);
				},
				function getNewMessagesCountInArea(callback) {
					msgArea.getNewMessageCountInAreaForUser(
						self.client.user.userId, currentArea.areaTag, (err, newMessageCount) => {
							callback(err, newMessageCount);
						}
					);
				},
				function displayMessageList(newMessageCount) {
					if(newMessageCount <= 0) {
						return self.newScanMessageArea(conf, cb);	//	next area, if any
					}

					const nextModuleOpts = {
						extraArgs: {
							messageAreaTag  : currentArea.areaTag,
						}
					};

					return self.gotoMenu(config.newScanMessageList || 'newScanMessageList', nextModuleOpts);
				}
			],
			cb // no more areas
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

	if(this.newScanFullExit) {
		//	user has canceled the entire scan @ message list view
		return cb(null);
	}


	var self	= this;
	var vc		= self.viewControllers.allViews = new ViewController( { client : self.client } );

	//	:TODO: display scan step/etc.

	async.series(		
		[
			function callParentMciReady(callback) {
				NewScanModule.super_.prototype.mciReady.call(self, mciData, callback);
			},
			function loadFromConfig(callback) {
				const loadOpts = {
					callingMenu		: self,
					mciMap			: mciData.menu,
					noInput			: true,
				};

				vc.loadFromMenuConfig(loadOpts, callback);
			},
			function performCurrentStepScan(callback) {
				switch(self.currentStep) {
					case 'messageConferences' :
						self.newScanMessageConference( () => {
							callback(null); //  finished
						});
						break;	
						
					default : return callback(null);
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
