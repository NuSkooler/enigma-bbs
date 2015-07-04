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
	this.artNames	= [ 'header', 'body', 'footerEdit', 'footerEditMenu', 'footerView' ];
	this.editorMode	= 'edit';	//	:TODO: This needs to be passed in via args

	this.initSequence = function() {
		var mciData = { };
		var art		= self.menuConfig.config.art;
		assert(_.isObject(art));

		//	:TODO: async.series here?
		async.waterfall(
			[
				function beforeDisplayArt(callback) {
					self.beforeArt();
					callback(null);
				},
				/*
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
				*/
				function displayArtHeaderAndBody(callback) {
					assert(_.isString(art.header));
					assert(_.isString(art.body));

					async.eachSeries( [ 'header', 'body' ], function dispArt(n, next) {
						self.displayArtAsset(art[n], function artDisplayed(err, artData) {
							mciData[n] = artData;
							next(err);
						});
					}, function complete(err) {
						callback(err);
					});
				},
				function displayArtFooter(callback) {
					callback(null);
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

		var menuLoadOpts = { callingMenu : self	};

		async.series(
			[
				function header(callback) {
					menuLoadOpts.formId = 0;
					menuLoadOpts.mciMap	= mciData.header.mciMap;

					self.addViewController(
						'header', 
						new ViewController( { client : self.client } )
					).loadFromMenuConfig(menuLoadOpts, function headerReady(err) {
						callback(err);
					});
				},
				function body(callback) {
					menuLoadOpts.formId	= 1;
					menuLoadOpts.mciMap	= mciData.body.mciMap;

					self.addViewController(
						'body',
						new ViewController( { client : self.client } )
					).loadFromMenuConfig(menuLoadOpts, function bodyReady(err) {
						callback(err);
					});
				}
			],
			function complete(err) {
				self.viewControllers.body.removeFocus();	//	:TODO: Change vc to allow *not* setting focus @ create	
				self.viewControllers.header.switchFocus(1);
			}
		);		
	};

	/*
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
	*/

	this.menuMethods = {
		headerSubmit : function(formData, extraArgs) {
			console.log('submit header:\n' + JSON.stringify(self.viewControllers.header.getFormData()))
			self.viewControllers.body.switchFocus(1);
		},
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

