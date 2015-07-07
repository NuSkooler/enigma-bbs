/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var ViewController		= require('../core/view_controller.js').ViewController;
var ansi				= require('../core/ansi_term.js');

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

	this.getFooterName = function(menu) {
		return true === menu ? 
			'footerEditMenu' : {
				edit : 'footerEdit',
				view : 'footerView',
			}[self.editorMode];
	};

	this.initSequence = function() {
		var mciData = { };
		var art		= self.menuConfig.config.art;
		assert(_.isObject(art));

		async.series(
			[
				function beforeDisplayArt(callback) {
					self.beforeArt();
					callback(null);
				},
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
				function moveToFooterPosition(callback) {
					//
					//	Calculate footer staring position
					//
					//	row = (header height + body height)
					//
					//	Header: mciData.body.height
					//	Body  : We must find this in the config / theme
					//
					//	:TODO: don't hard code this -- allow footer to be themed/etc.
					self.client.term.rawWrite(ansi.goto(23, 1));
					callback(null);
				},
				function displayArtFooter(callback) {
					var footerName = self.getFooterName(false);

					self.displayArtAsset(art[footerName], function artDisplayed(err, artData) {
						mciData[footerName] = artData;
						callback(err);
					});
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
						new ViewController( { client : self.client, formId : 0 } )
					).loadFromMenuConfig(menuLoadOpts, function headerReady(err) {
						callback(err);
					});
				},
				function body(callback) {
					menuLoadOpts.formId	= 1;
					menuLoadOpts.mciMap	= mciData.body.mciMap;

					self.addViewController(
						'body',
						new ViewController( { client : self.client, formId : 1 } )
					).loadFromMenuConfig(menuLoadOpts, function bodyReady(err) {
						callback(err);
					});
				},
				function footer(callback) {
					var footerName = self.getFooterName(false);

					menuLoadOpts.formId = 2;
					menuLoadOpts.mciMap = mciData[footerName].mciMap;

					self.addViewController(
						footerName,
						new ViewController( { client : self.client, formId : 2 } )
					).loadFromMenuConfig(menuLoadOpts, function footerReady(err) {
						callback(err);
					});
				}
			],
			function complete(err) {
				var bodyView = self.getBodyView();
				self.updateTextEditMode(bodyView.getTextEditMode());
				self.updateEditModePosition(bodyView.getEditPosition());

				self.viewControllers.body.removeFocus();	//	:TODO: Change vc to allow *not* setting focus @ create	
				self.viewControllers.header.switchFocus(1);
			}
		);		
	};

	this.getBodyView = function() {
		return self.viewControllers.body.getView(1);
	};

	this.updateEditModePosition = function(pos) {
		if('edit' === this.editorMode) {
			var posView = self.viewControllers[self.getFooterName(false)].getView(1);
			if(posView) {
				self.client.term.rawWrite(ansi.savePos());
				posView.setText(_.padLeft(String(pos.row + 1), 2, '0') + ',' + _.padLeft(String(pos.col + 1), 2, '0'));
				self.client.term.rawWrite(ansi.restorePos());
			}
		}
	};

	this.updateTextEditMode = function(mode) {
		if('edit' === this.editorMode) {
			var modeView = self.viewControllers[self.getFooterName(false)].getView(2);
			if(modeView) {
				self.client.term.rawWrite(ansi.savePos());
				modeView.setText('insert' === mode ? 'INS' : 'OVR');
				self.client.term.rawWrite(ansi.restorePos());	
			}
		}
	};


	this.menuMethods = {
		headerSubmit : function(formData, extraArgs) {
//			console.log('submit header:\n' + JSON.stringify(self.viewControllers.header.getFormData()))
			self.viewControllers.header.removeFocus();
			self.viewControllers.body.switchFocus(1);

			self.getBodyView().on('edit position', function cursorPosUpdate(pos) {
				self.updateEditModePosition(pos);
			});

			self.getBodyView().on('text edit mode', function textEditMode(mode) {
				self.updateTextEditMode(mode);
			});
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

