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
			TL6 - Message number
			TL7 - Mesage total (in area)
			TL8 - View Count
			TL9 - Hash tags
			TL10 - Message ID
			TL11 - Reply to message ID

			TL12 - User1
			TL13 - User2

		Footer - Viewing
			HM1 - Menu (prev/next/etc.)

			TL6 - Message number
			TL7 - Message total (in area)

			TL12 - User1 (fmt message object)
			TL13 - User2

			
*/
var MCICodeIds = {
	ViewModeHeader : {
		From			: 1,
		To				: 2,
		Subject			: 3,

		DateTime		: 5,
		MsgNum			: 6,
		MsgTotal		: 7,
		ViewCount		: 8,
		HashTags		: 9,
		MessageID		: 10,
		ReplyToMsgID	: 11
	},
	ViewModeFooter : {
		MsgNum			: 6,
		MsgTotal		: 7,
	},

	ReplyEditModeHeader : {
		From			: 1,
		To				: 2,
		Subject			: 3,

	}
};

function FullScreenEditorModule(options) {
	MenuModule.call(this, options);

	var self		= this;
	var config		= this.menuConfig.config;

	//
	//	menuConfig.config:
	//		editorType				: email | area
	//		editorMode				: view | edit | quote
	//
	//	extraArgs - view mode
	//		messageAreaName
	//		messageIndex / messageTotal
	//
	//
	this.editorType	= config.editorType;
	this.editorMode	= config.editorMode;

	if(_.isObject(options.extraArgs)) {
		this.messageAreaName	= options.extraArgs.messageAreaName || Message.WellKnownAreaNames.Private;
		this.messageIndex		= options.extraArgs.messageIndex || 0;
		this.messageTotal		= options.extraArgs.messageTotal || 0;
	}

	this.isReady				= false;
	
	this.isEditMode = function() {
		return 'edit' === self.editorMode;
	};
	
	this.isViewMode = function() {
		return 'view' === self.editorMode;
	};

	this.isLocalEmail = function() {
		return 'email' === self.editorType && Message.WellKnownAreaNames.Private === self.messageAreaName;
	};

	this.getFooterName = function() {
		return 'footer' + _.capitalize(self.footerMode);	//	e.g. 'footerEditor', 'footerEditorMenu', ...
	};

	this.getFormId = function(name) {
		return {
			header				: 0,
			body				: 1,
			footerEditor		: 2,
			footerEditorMenu	: 3,
			footerView			: 4,
			quoteBuilder		: 5,

			help				: 50,
		}[name];
	};

	this.setInitialFooterMode = function() {
		switch(self.editorMode) {
			case 'edit' : self.footerMode = 'editor'; break;
			case 'view' : self.footerMode = 'view'; break;
		}
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
		self.message = message;

		if(self.isReady) {
			self.initHeaderViewMode();
			self.initFooterViewMode();

			var bodyMessageView = self.viewControllers.body.getView(1);
			if(bodyMessageView && _.has(self, 'message.message')) {
				bodyMessageView.setText(self.message.message);
				//bodyMessageView.redraw();
			}
		}

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
					//	Calculate footer starting position
					//
					//	row = (header height + body height)
					//
					var footerRow = self.header.height + self.body.height;
					self.client.term.rawWrite(ansi.goto(footerRow, 1));
					callback(null);
				},
				function clearFooterArea(callback) {
					if(options.clear) {
						//	footer up to 3 rows in height
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

								self[n] = { height : artData.height };

								next(err);
							}
						);
					}, function complete(err) {
						callback(err);
					});
				},
				function displayFooter(callback) {
					self.setInitialFooterMode();

					var footerName = self.getFooterName();

					self.redrawFooter( { footerName : footerName }, function artDisplayed(err, artData) {
						mciData[footerName] = artData;
						callback(err);
					});
				},
				function afterArtDisplayed(callback) {
					self.mciReady(mciData, callback);
				}
			],
			function complete(err) {
				if(err) {					
					console.log(err)
				} else {
					self.isReady = true;
					self.finishedLoading();
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
								self.initHeaderViewMode();
								self.initFooterViewMode();

								var bodyMessageView = self.viewControllers.body.getView(1);
								if(bodyMessageView && _.has(self, 'message.message')) {
									bodyMessageView.setText(self.message.message);
								}
							}
							break;
							
						case 'edit' :
							self.viewControllers.header.getView(1).setText(self.client.user.username);	//	from

							if(self.replyToMessage) {
								self.initHeaderReplyEditMode();
							}
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
							self.switchToFooter();
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

	this.mciReadyHandler = function(mciData, cb) {

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

			cb(err);
		});
	};

	this.updateEditModePosition = function(pos) {
		if(self.isEditMode()) {
			var posView = self.viewControllers.footerEditor.getView(1);
			if(posView) {
				self.client.term.rawWrite(ansi.savePos());
				posView.setText(_.padLeft(String(pos.row + 1), 2, '0') + ',' + _.padLeft(String(pos.col + 1), 2, '0'));
				self.client.term.rawWrite(ansi.restorePos());
			}
		}
	};

	this.updateTextEditMode = function(mode) {
		if(self.isEditMode()) {
			var modeView = self.viewControllers.footerEditor.getView(2);
			if(modeView) {
				self.client.term.rawWrite(ansi.savePos());
				modeView.setText('insert' === mode ? 'INS' : 'OVR');
				self.client.term.rawWrite(ansi.restorePos());	
			}
		}
	};

	this.initHeaderViewMode = function() {
		assert(_.isObject(self.message));

		function setHeaderText(id, text) {
			var v = self.viewControllers.header.getView(id);
			if(v) {
				v.setText(text);
			}
		}

		setHeaderText(MCICodeIds.ViewModeHeader.From,			self.message.fromUserName);
		setHeaderText(MCICodeIds.ViewModeHeader.To,				self.message.toUserName);
		setHeaderText(MCICodeIds.ViewModeHeader.Subject,		self.message.subject);
		setHeaderText(MCICodeIds.ViewModeHeader.DateTime,		moment(self.message.modTimestamp).format(self.client.currentTheme.helpers.getDateTimeFormat()));
		setHeaderText(MCICodeIds.ViewModeHeader.MsgNum,			(self.messageIndex + 1).toString());
		setHeaderText(MCICodeIds.ViewModeHeader.MsgTotal,		self.messageTotal.toString());
		setHeaderText(MCICodeIds.ViewModeHeader.ViewCount,		self.message.viewCount);
		setHeaderText(MCICodeIds.ViewModeHeader.HashTags,		'TODO hash tags');
		setHeaderText(MCICodeIds.ViewModeHeader.MessageID,		self.message.messageId);
		setHeaderText(MCICodeIds.ViewModeHeader.ReplyToMsgID,	self.message.replyToMessageId);
	};

	this.initHeaderReplyEditMode = function() {
		assert(_.isObject(self.replyToMessage));

		function setHeaderText(id, text) {
			var v = self.viewControllers.header.getView(id);
			if(v) {
				v.setText(text);
			}
		}

		setHeaderText(MCICodeIds.ReplyEditModeHeader.To,		self.replyToMessage.fromUserName);
		setHeaderText(MCICodeIds.ReplyEditModeHeader.Subject,	'RE: ' + self.replyToMessage.subject);

	};

	this.initFooterViewMode = function() {
		
		function setFooterText(id, text) {
			var v = self.viewControllers.footerView.getView(id);
			if(v) {
				v.setText(text);
			}
		}

		setFooterText(MCICodeIds.ViewModeFooter.MsgNum,			(self.messageIndex + 1).toString());
		setFooterText(MCICodeIds.ViewModeFooter.MsgTotal,		self.messageTotal.toString());
	};

	this.displayHelp = function() {
		self.client.term.rawWrite(ansi.resetScreen());

		theme.displayThemeArt( { name : self.menuConfig.config.art.help, client	: self.client },
			function helpDisplayed(err, artData) {
				self.client.waitForKeyPress(function keyPress(ch, key) {
					self.redrawScreen();
					self.viewControllers.footerEditorMenu.setFocus(true);
				});
			}
		);
	};

	this.displayQuoteBuilder = function() {
		//
		//	Clear body area
		//
		async.waterfall(
			[
				function clearAndDisplayArt(callback) {
					console.log(self.header.height);
					self.client.term.rawWrite(
						ansi.goto(self.header.height + 1, 1) +
						ansi.deleteLine(24 - self.header.height));
						//ansi.eraseLine(2));
						
					theme.displayThemeArt( { name : self.menuConfig.config.art.quote, client : self.client }, function displayed(err, artData) {
						callback(err, artData);
					});
				},
				function createViewsIfNecessary(artData, callback) {
					var formId = self.getFormId('quoteBuilder');
					
					if(_.isUndefined(self.viewControllers.quoteBuilder)) {
						var menuLoadOpts = {
							callingMenu	: self,
							formId		: formId,
							mciMap		: artData.mciMap,	
						};
						
						self.addViewController(
							'quoteBuilder', 
							new ViewController( { client : self.client, formId : formId } )
						).loadFromMenuConfig(menuLoadOpts, function quoteViewsReady(err) {
							callback(err);
						});
					} else {
						self.viewControllers.quoteBuilder.redrawAll();
						callback(null);
					}
				},
				function loadQuoteLines(callback) {
					//	:TODO: MLTEV's word wrapping -> line[] stuff needs to be made a public API. This can then be used here and elsewhere.
					//	...should not be too bad to do at all
					//	...probably do want quote markers in place here though, e.g. " Nu> Said some things"
					//	...this could be handled via message.getQuoteLines(...) => []
					//self.viewControllers.quoteBuilder.getView(3).setItems(['Someone said some shit', 'then they said more shit', 'and what not...', 'hurp durp']);
					var quoteView = self.viewControllers.quoteBuilder.getView(3);
					var quoteWidth = quoteView.dimens.width;
					console.log(quoteWidth)
					var quoteLines = self.replyToMessage.getQuoteLines(quoteWidth);
					console.log(quoteLines)
					quoteView.setItems(quoteLines);
					callback(null);
				},
				function setViewFocus(callback) {
					self.viewControllers.quoteBuilder.getView(1).setFocus(false);
					self.viewControllers.quoteBuilder.switchFocus(3);

					callback(null);
				}
			],
			function complete(err) {
				if(err) {
					console.log(err)	//	:TODO: needs real impl.
				}
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

	this.switchToFooter = function() {
		self.viewControllers.header.setFocus(false);
		self.viewControllers.body.setFocus(false);

		self.viewControllers[self.getFooterName()].switchFocus(1);	//	HM1
	};


	this.menuMethods = {
		//	:TODO: rename to editModeHeaderSubmit
		headerSubmit : function(formData, extraArgs) {
			self.switchToBody();
		},
		editModeEscPressed : function(formData, extraArgs) {
			self.footerMode = 'editor' === self.footerMode ? 'editorMenu' : 'editor';

			self.switchFooter(function next(err) {
				if(err) {
					//	:TODO:... what now?
					console.log(err)
				} else {
					switch(self.footerMode) {
						case 'editor' :
							if(!_.isUndefined(self.viewControllers.footerEditorMenu)) {
								self.viewControllers.footerEditorMenu.setFocus(false);
							}
							self.viewControllers.body.switchFocus(1);
							self.observeEditorEvents();
							break;

						case 'editorMenu' :
							self.viewControllers.body.setFocus(false);
							self.viewControllers.footerEditorMenu.switchFocus(1);
							break;

						default : throw new Error('Unexpected mode');
					}
					
				}
			});
		},
		editModeMenuQuote : function(formData, extraArgs) {
			self.viewControllers.footerEditorMenu.setFocus(false);
			self.displayQuoteBuilder();
		},
		editModeMenuHelp : function(formData, extraArgs) {
			self.viewControllers.footerEditorMenu.setFocus(false);
			self.displayHelp();
		},
		///////////////////////////////////////////////////////////////////////
		//	View Mode
		///////////////////////////////////////////////////////////////////////
		viewModeEscPressed : function(formData, extraArgs) {
			//
			//	MLTEV won't get key events -- we need to handle them all here?
			//	...up/down, page up/page down... both should go by pages
			//	...Next/Prev/Etc. here
		}
	};

	if(_.has(options, 'extraArgs.message')) {
		this.setMessage(options.extraArgs.message);
	} else if(_.has(options, 'extraArgs.replyToMessage')) {
		this.replyToMessage = options.extraArgs.replyToMessage;
	}
}

require('util').inherits(FullScreenEditorModule, MenuModule);

FullScreenEditorModule.prototype.enter = function(client) {	
	FullScreenEditorModule.super_.prototype.enter.call(this, client);
};

FullScreenEditorModule.prototype.mciReady = function(mciData, cb) {
	this.mciReadyHandler(mciData, cb);
	//this['mciReadyHandler' + _.capitalize(this.editorType)](mciData);
};

FullScreenEditorModule.prototype.validateToUserName = function(un, cb) {
	cb(null);	//	note: to be implemented by sub classes
};
