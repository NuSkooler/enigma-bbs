/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var ViewController		= require('../core/view_controller.js').ViewController;
var messageArea			= require('../core/message_area.js');
var strUtil				= require('../core/string_util.js');

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

var MciCodesIds = {
	AreaList	: 1,
	CurrentArea	: 2,
};

function MessageAreaListModule(options) {
	MenuModule.call(this, options);

	var self = this;

    this.messageAreas = messageArea.getSortedAvailMessageAreasByConfTag(
         self.client.user.properties.message_conf_tag,
        { client : self.client }
    );

	this.menuMethods = {
		changeArea : function(formData, extraArgs) {
			if(1 === formData.submitId) {
				const areaTag = self.messageAreas[formData.value.area].areaTag;

                messageArea.changeMessageArea(self.client, areaTag, function areaChanged(err) {
                    if(err) {
                        self.client.term.pipeWrite('\n|00Cannot change area: ' + err.message + '\n');

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

require('util').inherits(MessageAreaListModule, MenuModule);

MessageAreaListModule.prototype.mciReady = function(mciData, cb) {
	var self	= this;
	const vc	= self.viewControllers.areaList = new ViewController( { client : self.client } );

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
				const listFormat 		= self.menuConfig.config.listFormat || '{index} ) - {name}';
				const focusListFormat	= self.menuConfig.config.focusListFormat || listFormat;
                
                const areaListView = vc.getView(1);
                let i = 1;
                areaListView.setItems(_.map(self.messageAreas, v => {
                    return listFormat.format({
                        index   : i++,
                        areaTag : v.area.areaTag,
                        name    : v.area.name,
                        desc    : v.area.desc, 
                    });
                }));
                
                i = 1;
                areaListView.setFocusItems(_.map(self.messageAreas, v => {
                    return focusListFormat.format({
                        index   : i++,
                        areaTag : v.area.areaTag,
                        name    : v.area.name,
                        desc    : v.area.desc, 
                    })
                }));

				areaListView.redraw();

				callback(null);
			},
			function populateTextViews(callback) {
				//	:TODO: populate current message area desc!
				//self.setViewText(MciCodesIds.CurrentArea, 

				callback(null);
			}
		],
		function complete(err) {
			cb(null);
		}
	);
};