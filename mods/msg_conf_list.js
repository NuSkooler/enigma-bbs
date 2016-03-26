/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var ViewController		= require('../core/view_controller.js').ViewController;
var messageArea			= require('../core/message_area.js');

var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.getModule		= MessageConfListModule;

exports.moduleInfo = {
	name	: 'Message Conference List',
	desc	: 'Module for listing / choosing message conferences',
	author	: 'NuSkooler',
};

var MciCodesIds = {
	ConfList	: 1,
	CurrentConf	: 2,
	
	//	:TODO:
	//	# areas in con
	//	
};

function MessageConfListModule(options) {
	MenuModule.call(this, options);

	var self = this;

	this.messageConfs = messageArea.getSortedAvailMessageConferences(self.client);

	this.menuMethods = {
		changeConference : function(formData, extraArgs) {
			if(1 === formData.submitId) {
				const confTag = self.messageConfs[formData.value.conf].confTag;

				messageArea.changeMessageConference(self.client, confTag, err => {
					if(err) {						
						self.client.term.pipeWrite(`\n|00Cannot change conference: ${err.message}\n`);

						setTimeout(function timeout() {
                            self.prevMenu();
                        }, 1000);
					} else {
						self.prevMenu();
					}
				});
			}
		}
	};

	this.setViewText = function(id, text) {
		const v = self.viewControllers.areaList.getView(id);
		if(v) {
			v.setText(text);
		}
	};
}

require('util').inherits(MessageConfListModule, MenuModule);

MessageConfListModule.prototype.mciReady = function(mciData, cb) {
	var self	= this;
	const vc	= self.viewControllers.areaList = new ViewController( { client : self.client } );

	async.series(
		[
			function callParentMciReady(callback) {
				MessageConfListModule.super_.prototype.mciReady.call(this, mciData, callback);
			},
			function loadFromConfig(callback) {
				let loadOpts = {
					callingMenu	: self,
					mciMap		: mciData.menu,
					formId		: 0,
				};

				vc.loadFromMenuConfig(loadOpts, callback);
			},
			function populateConfListView(callback) {
				const listFormat 		= self.menuConfig.config.listFormat || '{index} ) - {name}';
				const focusListFormat	= self.menuConfig.config.focusListFormat || listFormat;
                
                const confListView = vc.getView(1);
                let i = 1;
                confListView.setItems(_.map(self.messageConfs, v => {
                    return listFormat.format({
                        index   : i++,
                        confTag : v.conf.confTag,
                        name    : v.conf.name,
                        desc    : v.conf.desc, 
                    });
                }));
                
                i = 1;
                confListView.setFocusItems(_.map(self.messageConfs, v => {
                    return focusListFormat.format({
                        index   : i++,
                        confTag : v.conf.confTag,
                        name    : v.conf.name,
                        desc    : v.conf.desc, 
                    })
                }));

				confListView.redraw();

				callback(null);
			},
			function populateTextViews(callback) {
				//	:TODO: populate other avail MCI, e.g. current conf name
				callback(null);
			}
		],
		function complete(err) {
			cb(err);
		}
	);
};