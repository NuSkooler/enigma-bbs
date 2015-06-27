/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var ViewController		= require('../core/view_controller.js').ViewController;

var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.getModule	= FullScreenEditorModule;

exports.moduleInfo = {
	name	: 'Full Screen Editor (FSE)',
	desc	: 'A full screen editor/viewer',
	author	: 'NuSkooler',
};

function FullScreenEditorModule(options) {
	MenuModule.call(this, options);

	var self		= this;
	this.menuConfig	= options.menuConfig;
	this.editorType	= this.menuConfig.config.editorType;

	this.initSequence = function() {
		var mciData = { };

		async.waterfall(
			[
				function beforeDisplayArt(callback) {
					self.beforeArt();
					callback(null);
				},
				function displayMainArt(callback) {
					if(_.isString(self.menuConfig.art)) {
						self.displayArtAsset(self.menuConfig.art, function frameDisplayed(err, artData) {
							mciData.main = artData;
							callback(err);
						});
					} else {
						callback(null);	//	:TODO: should probably throw error... can't do much without this
					}
				},
				function afterArtDisplayed(callback) {
					self.mciReady(mciData);
					callback(null);
				}
			],
			function complete(err) {

			}
		);	
	};

	this.mciReadyHandlerNetMail = function(mciData) {
		var vc = self.addViewController('main', new ViewController( { client : self.client } ));

		//	:TODO: This can probably come from the normal mci configuration...
		//	additional mci stuff could be in config{} block. This should all be easily user-defined
		var mciConfig = {
			ET1 : {
				width : 20,
				text : 'Hello, World'
			},
			ET2 : {
				width : 10,
				text : 'This is a longer string',
			},
			MT3 : {
				width : 79,
				height : 17,
				focus : true,
				text : 'Ermergerd!\nHuzzah!'
			}

		};

		var initialFocusedId = 3;	//	editor

		async.waterfall(
			[
				function createViews(callback) {
					vc.createViewsFromMCI(mciData.main.mciMap, function viewsCreated(err) {
						callback(err);
					});
				},
				function applyThemeCustomization(callback) {
					console.log('applyThemeCustomization...')
					//	:TODO: menuUtil.applyThemeCustomization() ...
					//	this should update local hard coded mci stuff for example to change colors, widths, blah blah
					callback(null);
				},
				function applyViewConfiguration(callback) {
					console.log('applyViewConfiguration...')
					
					vc.applyViewConfig( { mci : mciConfig }, function configApplied(err, info) {
						callback(err);
					});
				},
				function drawAllViews(callback) {
					vc.redrawAll(initialFocusedId);
					callback(null);
				},
				function setInitialFocus(callback) {
					vc.switchFocus(initialFocusedId);	//	editor
				}
			]
		);
	};
}

require('util').inherits(FullScreenEditorModule, MenuModule);

FullScreenEditorModule.prototype.enter = function(client) {	
	FullScreenEditorModule.super_.prototype.enter.call(this, client);
};

FullScreenEditorModule.prototype.mciReady = function(mciData) {
	this['mciReadyHandler' + _.capitalize(this.editorType)](mciData);
};

