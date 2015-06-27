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
		var mainVc = self.addViewController('main', new ViewController( { client : self.client } ));

		var menuLoadOpts = {
			callingMenu	: self,
			mciMap		: mciData.main.mciMap,
			formId		: 0,
		};
		
		mainVc.loadFromMenuConfig(menuLoadOpts, function viewsReady(err) {
		});
	};

	this.menuMethods = {
		editorEscPressed : function(formData, extraArgs) {

		}
	};
}

require('util').inherits(FullScreenEditorModule, MenuModule);

FullScreenEditorModule.prototype.enter = function(client) {	
	FullScreenEditorModule.super_.prototype.enter.call(this, client);
};

FullScreenEditorModule.prototype.mciReady = function(mciData) {
	this['mciReadyHandler' + _.capitalize(this.editorType)](mciData);
};

