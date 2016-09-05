/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule					= require('./menu_module.js').MenuModule;
const ViewController				= require('./view_controller.js').ViewController;
const ansi							= require('./ansi_term.js');
const theme							= require('./theme.js');
const Message						= require('./message.js');
const updateMessageAreaLastReadId	= require('./message_area.js').updateMessageAreaLastReadId;
const getUserIdAndName				= require('./user.js').getUserIdAndName;
const cleanControlCodes				= require('./string_util.js').cleanControlCodes;
const StatLog						= require('./stat_log.js');
const stringFormat					= require('./string_format.js');

//	deps
const async							= require('async');
const assert						= require('assert');
const _								= require('lodash');
const moment						= require('moment');

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
			TL4 - Area name
			
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
		ReplyToMsgID	: 11,

		//	:TODO: ConfName
		
	},
	
	ViewModeFooter : {
		MsgNum			: 6,
		MsgTotal		: 7,
	},

	ReplyEditModeHeader : {
		From			: 1,
		To				: 2,
		Subject			: 3,
		
		ErrorMsg		: 13,
	},
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
	//	menuConfig.config or extraArgs
	//		messageAreaTag
	//		messageIndex / messageTotal
	//		toUserId
	//
	this.editorType			= config.editorType;
	this.editorMode			= config.editorMode;	
	
	if(config.messageAreaTag) {
		this.messageAreaTag	= config.messageAreaTag;
	}
	
	this.messageIndex		= config.messageIndex || 0;
	this.messageTotal		= config.messageTotal || 0;
	this.toUserId			= config.toUserId || 0;

	//	extraArgs can override some config
	if(_.isObject(options.extraArgs)) {
		if(options.extraArgs.messageAreaTag) {
			this.messageAreaTag = options.extraArgs.messageAreaTag;
		}
		if(options.extraArgs.messageIndex) {
			this.messageIndex = options.extraArgs.messageIndex;
		}
		if(options.extraArgs.messageTotal) {
			this.messageTotal = options.extraArgs.messageTotal;
		}
		if(options.extraArgs.toUserId) {
			this.toUserId = options.extraArgs.toUserId;
		}
	}

	this.isReady				= false;
	
	this.isEditMode = function() {
		return 'edit' === self.editorMode;
	};
	
	this.isViewMode = function() {
		return 'view' === self.editorMode;
	};

	this.isLocalEmail = function() {
		return Message.WellKnownAreaTags.Private === self.messageAreaTag;
	};

	this.isReply = function() {
		return !_.isUndefined(self.replyToMessage);
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

	/*ViewModeHeader : {
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
	},*/

	//	:TODO: convert to something like this for all view acces:
	this.getHeaderViews = function() {
		var vc = self.viewControllers.header;

		if(self.isViewMode()) {
			return {
				from		: vc.getView(1),
				to			: vc.getView(2),
				subject		: vc.getView(3),

				dateTime	: vc.getView(5),
				msgNum		: vc.getView(7),
				//	...

			};
		}
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
			areaTag			: self.messageAreaTag,
			toUserName		: headerValues.to,
			fromUserName	: headerValues.from,
			subject			: headerValues.subject,
			message			: self.viewControllers.body.getFormData().value.message,
		};

		if(self.isReply()) {
			msgOpts.replyToMsgId	= self.replyToMessage.messageId;
		}

		self.message = new Message(msgOpts);
	};
	
	/*
	this.setBodyMessageViewText = function() {
		self.bodyMessageView.setText(cleanControlCodes(self.message.message));	
	};
	*/

	this.setMessage = function(message) {
		self.message = message;

		updateMessageAreaLastReadId(
			self.client.user.userId, self.messageAreaTag, self.message.messageId, () => {

				if(self.isReady) {
					self.initHeaderViewMode();
					self.initFooterViewMode();

					var bodyMessageView = self.viewControllers.body.getView(1);
					if(bodyMessageView && _.has(self, 'message.message')) {
						//self.setBodyMessageViewText();
						bodyMessageView.setText(cleanControlCodes(self.message.message));
						//bodyMessageView.redraw();
					}
				}
			}
		);
	};

	this.getMessage = function(cb) {
		async.series(
			[
				function buildIfNecessary(callback) {
					if(self.isEditMode()) {
						self.buildMessage();	//	creates initial self.message
					}
					callback(null);
				},
				function populateLocalUserInfo(callback) {
					if(self.isLocalEmail()) {
						self.message.setLocalFromUserId(self.client.user.userId);
						
						if(self.toUserId > 0) {
							self.message.setLocalToUserId(self.toUserId);
							callback(null);
						} else {
							//	we need to look it up
							getUserIdAndName(self.message.toUserName, function userInfo(err, toUserId) {
								if(err) {
									callback(err);
								} else {
									self.message.setLocalToUserId(toUserId);
									callback(null);
								}
							});							
						}
					} else {
						callback(null);
					}
				}
			],
			function complete(err) {
				cb(err, self.message);
			}
		);
	};

	this.updateUserStats = function(cb) {
		if(Message.isPrivateAreaTag(this.message.areaTag)) {
			if(cb) {
				return cb(null);
			}
		}

		StatLog.incrementUserStat(
			self.client.user,
			'post_count',
			1,
			cb
		);
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

						//	:TODO: We'd like to delete up to N rows, but this does not work
						//	in NetRunner:
						self.client.term.rawWrite(ansi.reset() + ansi.deleteLine(3));
						
						self.client.term.rawWrite(ansi.reset() + ansi.eraseLine(2));
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

	this.redrawScreen = function(cb) {
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

					callback(null);
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
					self.beforeArt(callback);
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
								if(artData) {
									mciData[n] = artData;
									self[n] = { height : artData.height };
								}

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
					//	:TODO: This needs properly handled!
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
									//self.setBodyMessageViewText();
									bodyMessageView.setText(cleanControlCodes(self.message.message));
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
							//self.observeViewPosition();
							break;
					}

					callback(null);
				}
			],
			function complete(err) {
				if(err) {
					console.error(err)
				}
				cb(err);
			}
		);
	};

	this.mciReadyHandler = function(mciData, cb) {

		self.createInitialViews(mciData, function viewsCreated(err) {
			//	:TODO: Can probably be replaced with @systemMethod:validateUserNameExists when the framework is in 
			//	place - if this is for existing usernames else validate spec

			/*
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
			});*/

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

	this.setHeaderText = function(id, text) {
		var v = self.viewControllers.header.getView(id);
		if(v) {
			v.setText(text);
		}
	};

	this.initHeaderViewMode = function() {
		assert(_.isObject(self.message));
		
		self.setHeaderText(MCICodeIds.ViewModeHeader.From,			self.message.fromUserName);
		self.setHeaderText(MCICodeIds.ViewModeHeader.To,			self.message.toUserName);
		self.setHeaderText(MCICodeIds.ViewModeHeader.Subject,		self.message.subject);
		self.setHeaderText(MCICodeIds.ViewModeHeader.DateTime,		moment(self.message.modTimestamp).format(self.client.currentTheme.helpers.getDateTimeFormat()));
		self.setHeaderText(MCICodeIds.ViewModeHeader.MsgNum,		(self.messageIndex + 1).toString());
		self.setHeaderText(MCICodeIds.ViewModeHeader.MsgTotal,		self.messageTotal.toString());
		self.setHeaderText(MCICodeIds.ViewModeHeader.ViewCount,		self.message.viewCount);
		self.setHeaderText(MCICodeIds.ViewModeHeader.HashTags,		'TODO hash tags');
		self.setHeaderText(MCICodeIds.ViewModeHeader.MessageID,		self.message.messageId);
		self.setHeaderText(MCICodeIds.ViewModeHeader.ReplyToMsgID,	self.message.replyToMessageId);
	};

	this.initHeaderReplyEditMode = function() {
		assert(_.isObject(self.replyToMessage));

		self.setHeaderText(MCICodeIds.ReplyEditModeHeader.To,		self.replyToMessage.fromUserName);

		//
		//	We want to prefix the subject with "RE: " only if it's not already
		//	that way -- avoid RE: RE: RE: RE: ...
		//
		let newSubj = self.replyToMessage.subject;
		if(false === /^RE:\s+/i.test(newSubj)) {
			newSubj = `RE: ${newSubj}`;
		}

		self.setHeaderText(MCICodeIds.ReplyEditModeHeader.Subject,	newSubj);
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

	this.displayHelp = function(cb) {
		self.client.term.rawWrite(ansi.resetScreen());

		theme.displayThemeArt(
			{ name : self.menuConfig.config.art.help, client : self.client },
			() => {
				self.client.waitForKeyPress( () => {
					self.redrawScreen( () => {
						self.viewControllers[self.getFooterName()].setFocus(true);
						return cb(null);
					});
				});
			}
		);
	};

	this.displayQuoteBuilder = function() {
		//
		//	Clear body area
		//
		self.newQuoteBlock = true;
		
		async.waterfall(
			[
				function clearAndDisplayArt(callback) {

					//	:TODO: use termHeight, not hard coded 24 here:

					//	:TODO: NetRunner does NOT support delete line, so this does not work:
					self.client.term.rawWrite(
						ansi.goto(self.header.height + 1, 1) +
						ansi.deleteLine(24 - self.header.height));
	
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
					var quoteView = self.viewControllers.quoteBuilder.getView(3);
					quoteView.setItems(self.replyToMessage.getQuoteLines(quoteView.dimens.width));
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

	/*
	this.observeViewPosition = function() {
		self.viewControllers.body.getView(1).on('edit position', function positionUpdate(pos) {
			console.log(pos.percent + ' / ' + pos.below)
		});
	};
	*/

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

	this.switchFromQuoteBuilderToBody = function() {
		self.viewControllers.quoteBuilder.setFocus(false);
		var body = self.viewControllers.body.getView(1);
		body.redraw();
		self.viewControllers.body.switchFocus(1);
		
		//	:TODO: create method (DRY)
		
		self.updateTextEditMode(body.getTextEditMode());
		self.updateEditModePosition(body.getEditPosition());

		self.observeEditorEvents();
	};
	
	this.quoteBuilderFinalize = function() {
		//	:TODO: fix magic #'s
		var quoteMsgView	= self.viewControllers.quoteBuilder.getView(1);
		var msgView			= self.viewControllers.body.getView(1);
		
		var quoteLines 		= quoteMsgView.getData();
		
		if(quoteLines.trim().length > 0) {
			msgView.addText(quoteMsgView.getData() + '\n');
		
		}
		
		quoteMsgView.setText('');

		var footerName = self.getFooterName();

		self.footerMode = 'editor';

		self.switchFooter(function switched(err) {
			self.switchFromQuoteBuilderToBody();
		});
	};

	this.getQuoteByHeader = function() {
		let quoteFormat = this.menuConfig.config.quoteFormats;
		if(Array.isArray(quoteFormat)) {			
			quoteFormat =  quoteFormat[ Math.floor(Math.random() * quoteFormat.length) ];
		} else if(!_.isString(quoteFormat)) {
			quoteFormat = 'On {dateTime} {userName} said...';
		}

		const dtFormat = this.menuConfig.config.quoteDateTimeFormat || self.client.currentTheme.helpers.getDateTimeFormat();	
		return stringFormat(quoteFormat, { 
			dateTime	: moment(self.replyToMessage.modTimestamp).format(dtFormat),
			userName	: self.replyToMessage.fromUserName,
		});
	};

	this.menuMethods = {
		//
		//	Validation stuff
		//
		viewValidationListener : function(err, cb) {
			var errMsgView = self.viewControllers.header.getView(MCICodeIds.ReplyEditModeHeader.ErrorMsg);
			var newFocusViewId;
			if(errMsgView) {
				if(err) {
					errMsgView.setText(err.message);
					
					if(MCICodeIds.ViewModeHeader.Subject === err.view.getId()) {
						//	:TODO: for "area" mode, should probably just bail if this is emtpy (e.g. cancel)
					}
				} else {
					errMsgView.clearText();
				}
			}
			cb(newFocusViewId);
		},
		
		headerSubmit : function(formData, extraArgs, cb) {
			self.switchToBody();
			return cb(null);
		},
		editModeEscPressed : function(formData, extraArgs, cb) {
			self.footerMode = 'editor' === self.footerMode ? 'editorMenu' : 'editor';

			self.switchFooter(function next(err) {
				if(err) {
					//	:TODO:... what now?
					console.log(err)
				} else {
					switch(self.footerMode) {
						case 'editor' :
							if(!_.isUndefined(self.viewControllers.footerEditorMenu)) {
								//self.viewControllers.footerEditorMenu.setFocus(false);
								self.viewControllers.footerEditorMenu.detachClientEvents();
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

				return cb(null);
			});
		},
		editModeMenuQuote : function(formData, extraArgs, cb) {
			self.viewControllers.footerEditorMenu.setFocus(false);
			self.displayQuoteBuilder();
			return cb(null);
		},
		appendQuoteEntry: function(formData, extraArgs, cb) {
			//	:TODO: Dont' use magic # ID's here			
			var quoteMsgView = self.viewControllers.quoteBuilder.getView(1);

			if(self.newQuoteBlock) {
				self.newQuoteBlock = false;
				quoteMsgView.addText(self.getQuoteByHeader());
			}
			
			var quoteText = self.viewControllers.quoteBuilder.getView(3).getItem(formData.value.quote);
			quoteMsgView.addText(quoteText);

			//
			//	If this is *not* the last item, advance. Otherwise, do nothing as we
			//	don't want to jump back to the top and repeat already quoted lines
			//
			var quoteListView = self.viewControllers.quoteBuilder.getView(3);
			if(quoteListView.getData() !== quoteListView.getCount() - 1) {
				quoteListView.focusNext();
			} else {
				self.quoteBuilderFinalize();
			}

			return cb(null);
		},
		quoteBuilderEscPressed : function(formData, extraArgs, cb) {
			self.quoteBuilderFinalize();
			return cb(null);
		},
		/*
		replyDiscard : function(formData, extraArgs) {
			//	:TODO: need to prompt yes/no
			//	:TODO: @method for fallback would be better
			self.prevMenu();
		},
		*/
		editModeMenuHelp : function(formData, extraArgs, cb) {
			self.viewControllers.footerEditorMenu.setFocus(false);
			return self.displayHelp(cb);
		},
		///////////////////////////////////////////////////////////////////////
		//	View Mode
		///////////////////////////////////////////////////////////////////////
		viewModeMenuHelp : function(formData, extraArgs, cb) {
			self.viewControllers.footerView.setFocus(false);
			return self.displayHelp(cb);
		}
	};

	if(_.has(options, 'extraArgs.message')) {
		this.setMessage(options.extraArgs.message);
	} else if(_.has(options, 'extraArgs.replyToMessage')) {
		this.replyToMessage = options.extraArgs.replyToMessage;
	}
}

require('util').inherits(FullScreenEditorModule, MenuModule);

require('./mod_mixins.js').MessageAreaConfTempSwitcher.call(FullScreenEditorModule.prototype);

FullScreenEditorModule.prototype.enter = function() {

	if(this.messageAreaTag) {
		this.tempMessageConfAndAreaSwitch(this.messageAreaTag);
	}

	FullScreenEditorModule.super_.prototype.enter.call(this);
};

FullScreenEditorModule.prototype.leave = function() {
	this.tempMessageConfAndAreaRestore();
	FullScreenEditorModule.super_.prototype.leave.call(this);
};

FullScreenEditorModule.prototype.mciReady = function(mciData, cb) {
	this.mciReadyHandler(mciData, cb);
};
