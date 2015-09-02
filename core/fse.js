/* jslint node: true */
'use strict';

var MenuModule				= require('../core/menu_module.js').MenuModule;
var ViewController			= require('../core/view_controller.js').ViewController;
var ansi					= require('../core/ansi_term.js');
var theme					= require('../core/theme.js');
var MultiLineEditTextView	= require('../core/multi_line_edit_text_view.js').MultiLineEditTextView;
var Message					= require('../core/message.js');

var async					= require('async');
var assert					= require('assert');
var _						= require('lodash');
var moment					= require('moment');

exports.FullScreenEditorModule	= FullScreenEditorModule;

//	:TODO: clean this up:

exports.getModule	= FullScreenEditorModule;

exports.moduleInfo = {
	name	: 'Full Screen Editor (FSE)',
	desc	: 'A full screen editor/viewer',
	author	: 'NuSkooler',
};

/*
	MCI Codes - General
		MA - Message Area Desc

	MCI Codes - View Mode
		Header
			TL1 - From
			TL2 - To
			TL3 - Subject
			
			TL5 - Date/Time (TODO: format)
			TL6 - Message  number/total
			TL7 - View Count
			TL8 - Hash tags
			TL9 - Message ID
			TL10 - Reply to message ID
			
*/

function FullScreenEditorModule(options) {
	MenuModule.call(this, options);

	var self		= this;
	var config		= this.menuConfig.config;

	//
	//	menuConfig.config:
	//		editorType				: email | area
	//		editorMode				: view | edit | quote (private: editMenu | ... )
	//
	//	extraArgs:
	//		messageAreaName
	//		messageNumber / messageTotal
	//
	//
	this.editorType	= config.editorType;
	this.editorMode	= config.editorMode;

	if(_.isObject(options.extraArgs)) {
		this.messageAreaName = options.extraArgs.messageAreaName || Message.WellKnownAreaNames.Private;
	}
	
	this.isEditMode = function() {
		return 'edit' === self.editorMode;
	};
	
	this.isViewMode = function() {
		return 'view' === self.editorMode;
	};

	this.isLocalEmail = function() {
		return 'email' === self.editorType && Message.WellKnownAreaNames.Private === self.messageAreaName;
	};

	this.getFooterName = function(editorMode) {
		editorMode = editorMode || self.editorMode;
		return 'footer' + _.capitalize(editorMode);	//	e.g.. 'footerEditMenu'
	};

	this.getFormId = function(name) {
		return {
			header			: 0,
			body			: 1,
			footerEdit		: 2,
			footerEditMenu	: 3,
			footerView		: 4,

			help			: 50,
		}[name];
	};

	this.buildMessage = function() {
		var headerValues = self.viewControllers.header.getFormData().value;

		var msgOpts = {
			areaName		: self.messageAreaName,
			toUserName		: headerValues.to,
			fromUserName	: headerValues.from,
			subject			: headerValues.subject,
			message			: self.viewControllers.body.getFormData().value.message,
		};

		self.message = new Message(msgOpts);
	};

	this.setMessage = function(message) {
		console.log(message)
		
		self.message = message;
	};

	this.getMessage = function() {
		if(self.isEditMode()) {
			self.buildMessage();
		}

		return self.message;
	};

	this.redrawFooter = function(options, cb) {
		async.waterfall(
			[
				function moveToFooterPosition(callback) {
					//
					//	Calculate footer staring position
					//
					//	row = (header height + body height)
					//
					//	Header: mciData.body.height
					//	Body  : We must find this in the config / theme
					//
					//	:TODO: don't hard code this -- allow footer height to be part of theme/etc.
					self.client.term.rawWrite(ansi.goto(23, 1));
					callback(null);
				},
				function clearFooterArea(callback) {
					if(options.clear) {
						self.client.term.rawWrite(ansi.reset() + ansi.deleteLine(3));
					}
					callback(null);
				},
				function displayFooterArt(callback) {
					var footerArt = self.menuConfig.config.art[options.footerName];

					theme.displayThemedAsset(
						footerArt,
						self.client,
						{ font : self.menuConfig.font },
						function displayed(err, artData) {
							callback(err, artData);
						}
					);
				}
			],
			function complete(err, artData) {
				cb(err, artData);
			}
		);
	};

	this.redrawScreen = function(options, cb) {
		var comps	= [ 'header', 'body' ];
		var art		= self.menuConfig.config.art;

		self.client.term.rawWrite(ansi.resetScreen());

		async.series(
			[
				function displayHeaderAndBody(callback) {
					async.eachSeries( comps, function dispArt(n, next) {
						theme.displayThemedAsset(
							art[n],
							self.client,
							{ font : self.menuConfig.font },
							function displayed(err, artData) {
								next(err);
							}
						);
					}, function complete(err) {
						callback(err);
					});
				},
				function displayFooter(callback) {
					//	we have to treat the footer special
					self.redrawFooter( { clear : false, footerName : self.getFooterName() }, function footerDisplayed(err) {
						callback(err);
					});
				},
				function refreshViews(callback) {
					comps.push(self.getFooterName());

					comps.forEach(function artComp(n) {
						self.viewControllers[n].redrawAll();
					});
				}
			],
			function complete(err) {
				cb(err);
			}
		);	
	};


	this.switchFooter = function(cb) {
		var footerName = self.getFooterName();
	
		self.redrawFooter( { footerName : footerName, clear : true }, function artDisplayed(err, artData) {
			if(err) {
				cb(err);
				return;
			}

			var formId = self.getFormId(footerName);

			if(_.isUndefined(self.viewControllers[footerName])) {
				var menuLoadOpts = {
					callingMenu	: self,
					formId		: formId,
					mciMap		: artData.mciMap
				};

				self.addViewController(
					footerName,
					new ViewController( { client : self.client, formId : formId } )
				).loadFromMenuConfig(menuLoadOpts, function footerReady(err) {
					cb(err);
				});
			} else {
				self.viewControllers[footerName].redrawAll();
				cb(null);
			}
		});
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
				function displayHeaderAndBodyArt(callback) {
					assert(_.isString(art.header));
					assert(_.isString(art.body));

					async.eachSeries( [ 'header', 'body' ], function dispArt(n, next) {
						theme.displayThemedAsset(
							art[n],
							self.client,
							{ font : self.menuConfig.font },
							function displayed(err, artData) {
								mciData[n] = artData;
								next(err);
							}
						);
					}, function complete(err) {
						callback(err);
					});
				},
				function displayFooter(callback) {
					var footerName = self.getFooterName();
					self.redrawFooter( { footerName : footerName }, function artDisplayed(err, artData) {
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
				if(err) {					
					console.log(err)
				}
			}
		);	
	};

	this.createInitialViews = function(mciData, cb) {
		
		var menuLoadOpts = { callingMenu : self };

		async.series(
			[
				function header(callback) {
					menuLoadOpts.formId = self.getFormId('header');
					menuLoadOpts.mciMap	= mciData.header.mciMap;

					self.addViewController(
						'header', 
						new ViewController( { client : self.client, formId : menuLoadOpts.formId } )
					).loadFromMenuConfig(menuLoadOpts, function headerReady(err) {
						callback(err);
					});
				},
				function body(callback) {
					menuLoadOpts.formId	= self.getFormId('body');
					menuLoadOpts.mciMap	= mciData.body.mciMap;

					self.addViewController(
						'body',
						new ViewController( { client : self.client, formId : menuLoadOpts.formId } )
					).loadFromMenuConfig(menuLoadOpts, function bodyReady(err) {
						callback(err);
					});
				},
				function footer(callback) {
					var footerName = self.getFooterName();

					menuLoadOpts.formId = self.getFormId(footerName);
					menuLoadOpts.mciMap = mciData[footerName].mciMap;

					self.addViewController(
						footerName,
						new ViewController( { client : self.client, formId : menuLoadOpts.formId } )
					).loadFromMenuConfig(menuLoadOpts, function footerReady(err) {
						callback(err);
					});
				},
				function prepareViewStates(callback) {
					var header = self.viewControllers.header;
					var from = header.getView(1);
					from.acceptsFocus = false;
					//from.setText(self.client.user.username);

					//	:TODO: make this a method
					var body = self.viewControllers.body.getView(1);
					self.updateTextEditMode(body.getTextEditMode());
					self.updateEditModePosition(body.getEditPosition());

					//	:TODO: If view mode, set body to read only... which needs an impl...

					callback(null);
				},
				function setInitialData(callback) {
					
					switch(self.editorMode) {
						case 'view' :
							if(self.message) {
								self.initHeaderFromMessage();

								var bodyMessageView = self.viewControllers.body.getView(1);
								if(bodyMessageView && _.has(self, 'message.message')) {
									bodyMessageView.setText(self.message.message);
								}
							}
							break;
							
						case 'edit' :
							self.viewControllers.header.getView(1).setText(self.client.user.username);	//	from
							break;
					}

					callback(null);
				},
				function setInitialFocus(callback) {
					
					switch(self.editorMode) {
						case 'edit' :
							self.switchToHeader();
							break;

						case 'view' :
							self.switchToBody();
							break;
					}

					callback(null);
				}
			],
			function complete(err) {
				cb(err);
			}
		);
	};

	this.mciReadyHandler = function(mciData) {

		self.createInitialViews(mciData, function viewsCreated(err) {
			self.viewControllers.header.on('leave', function headerViewLeave(view) {

				if(2 === view.id) {	//	"to" field
					self.validateToUserName(view.getData(), function result(err) {
						if(err) {
							//	:TODO: display a error in a %TL area or such
							view.clearText();
							self.viewControllers.headers.switchFocus(2);
						}
					});				
				}
			});
		});
	};

	this.updateEditModePosition = function(pos) {
		if('edit' === this.editorMode) {
			var posView = self.viewControllers.footerEdit.getView(1);
			if(posView) {
				self.client.term.rawWrite(ansi.savePos());
				posView.setText(_.padLeft(String(pos.row + 1), 2, '0') + ',' + _.padLeft(String(pos.col + 1), 2, '0'));
				self.client.term.rawWrite(ansi.restorePos());
			}
		}
	};

	this.updateTextEditMode = function(mode) {
		if('edit' === this.editorMode) {
			var modeView = self.viewControllers.footerEdit.getView(2);
			if(modeView) {
				self.client.term.rawWrite(ansi.savePos());
				modeView.setText('insert' === mode ? 'INS' : 'OVR');
				self.client.term.rawWrite(ansi.restorePos());	
			}
		}
	};

	this.initHeaderFromMessage = function() {
		assert(_.isObject(self.message));

		var fromView	= self.viewControllers.header.getView(1);	//	TL
		var toView		= self.viewControllers.header.getView(2);	//	TL
		var subjView	= self.viewControllers.header.getView(3);	//	TL
		var tsView		= self.viewControllers.header.getView(5);	//	TL

		fromView.setText(self.message.fromUserName);
		toView.setText(self.message.toUserName);
		subjView.setText(self.message.subject);

		tsView.setText(moment(self.message.modTimestamp).format(self.client.currentTheme.helpers.getDateTimeFormat()));

		
	};

	this.displayHelp = function() {
		self.client.term.rawWrite(ansi.resetScreen());

		theme.displayThemeArt( { name : self.menuConfig.config.art.help, client	: self.client },
			function helpDisplayed(err, artData) {
				self.client.waitForKeyPress(function keyPress(ch, key) {
					self.redrawScreen();
					self.viewControllers.footerEditMenu.setFocus(true);
				});
			}
		);
	};

	this.observeEditorEvents = function() {
		var bodyView = self.viewControllers.body.getView(1);

		bodyView.on('edit position', function cursorPosUpdate(pos) {
			self.updateEditModePosition(pos);
		});

		bodyView.on('text edit mode', function textEditMode(mode) {
			self.updateTextEditMode(mode);
		});
	};

	this.switchToHeader = function() {
		self.viewControllers.body.setFocus(false);
		self.viewControllers.header.switchFocus(2);	//	to
	};

	this.switchToBody = function() {
		self.viewControllers.header.setFocus(false);
		self.viewControllers.body.switchFocus(1);

		self.observeEditorEvents();
	};


	this.menuMethods = {
		headerSubmit : function(formData, extraArgs) {
			self.switchToBody();
		},
		editModeEscPressed : function(formData, extraArgs) {
			self.editorMode = 'edit' === self.editorMode ? 'editMenu' : 'edit';

			self.switchFooter(function next(err) {
				if(err) {
					//	:TODO:... what now?
					console.log(err)
				} else {
					switch(self.editorMode) {
						case 'edit' :
							if(!_.isUndefined(self.viewControllers.footerEditMenu)) {
								self.viewControllers.footerEditMenu.setFocus(false);
							}
							self.viewControllers.body.switchFocus(1);
							self.observeEditorEvents();
							break;

						case 'editMenu' :
							self.viewControllers.body.setFocus(false);
							self.viewControllers.footerEditMenu.switchFocus(1);
							break;

						default : throw new Error('Unexpected mode');
					}
					
				}
			});
		},
		/*
		editModeMenuSave : function(formData, extraArgs) {
			var msg = self.getMessage();
			console.log(msg);
		},*/
		editModeMenuQuote : function(formData, extraArgs) {

		},
		editModeMenuHelp : function(formData, extraArgs) {
			self.viewControllers.footerEditMenu.setFocus(false);
			self.displayHelp();
		}
	};

	if(_.isObject(options.extraArgs.message)) {
		this.setMessage(options.extraArgs.message);
	}
}

require('util').inherits(FullScreenEditorModule, MenuModule);

FullScreenEditorModule.prototype.enter = function(client) {	
	FullScreenEditorModule.super_.prototype.enter.call(this, client);
};

FullScreenEditorModule.prototype.mciReady = function(mciData) {
	this.mciReadyHandler(mciData);
	//this['mciReadyHandler' + _.capitalize(this.editorType)](mciData);
};

FullScreenEditorModule.prototype.validateToUserName = function(un, cb) {
	cb(null);	//	note: to be implemented by sub classes
};

