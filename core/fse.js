/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule					= require('./menu_module.js').MenuModule;
const ViewController				= require('./view_controller.js').ViewController;
const ansi							= require('./ansi_term.js');
const theme							= require('./theme.js');
const Message						= require('./message.js');
const updateMessageAreaLastReadId	= require('./message_area.js').updateMessageAreaLastReadId;
const getMessageAreaByTag			= require('./message_area.js').getMessageAreaByTag;
const User							= require('./user.js');
const StatLog						= require('./stat_log.js');
const stringFormat					= require('./string_format.js');
const MessageAreaConfTempSwitcher	= require('./mod_mixins.js').MessageAreaConfTempSwitcher;
const { isAnsi, cleanControlCodes, insert }	= require('./string_util.js');
const Config						= require('./config.js').config;

//	deps
const async							= require('async');
const assert						= require('assert');
const _								= require('lodash');
const moment						= require('moment');

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
const MciCodeIds = {
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

//	:TODO: convert code in this class to newer styles, conventions, etc. There is a lot of experimental stuff here that has better (DRY) alternatives

exports.FullScreenEditorModule = exports.getModule = class FullScreenEditorModule extends MessageAreaConfTempSwitcher(MenuModule) {

	constructor(options) {
		super(options);

		const self		= this;
		const config	= this.menuConfig.config;

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

		this.isReady = false;

		if(_.has(options, 'extraArgs.message')) {
			this.setMessage(options.extraArgs.message);
		} else if(_.has(options, 'extraArgs.replyToMessage')) {
			this.replyToMessage = options.extraArgs.replyToMessage;
		}

		this.menuMethods = {
			//
			//	Validation stuff
			//
			viewValidationListener : function(err, cb) {
				var errMsgView = self.viewControllers.header.getView(MciCodeIds.ReplyEditModeHeader.ErrorMsg);
				var newFocusViewId;
				if(errMsgView) {
					if(err) {
						errMsgView.setText(err.message);
						
						if(MciCodeIds.ViewModeHeader.Subject === err.view.getId()) {
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
				const quoteMsgView = self.viewControllers.quoteBuilder.getView(1);
				
				if(self.newQuoteBlock) {
					self.newQuoteBlock = false;

					//	:TODO: If replying to ANSI, add a blank sepration line here

					quoteMsgView.addText(self.getQuoteByHeader());
				}
				
				const quoteText = self.viewControllers.quoteBuilder.getView(3).getItem(formData.value.quote);
				quoteMsgView.addText(quoteText);

				//
				//	If this is *not* the last item, advance. Otherwise, do nothing as we
				//	don't want to jump back to the top and repeat already quoted lines
				//
				const quoteListView = self.viewControllers.quoteBuilder.getView(3);
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
	}

	isEditMode() {
		return 'edit' === this.editorMode;
	}
	
	isViewMode() {
		return 'view' === this.editorMode;
	}

	isLocalEmail() {
		return Message.WellKnownAreaTags.Private === this.messageAreaTag;
	}

	isReply() {
		return !_.isUndefined(this.replyToMessage);
	}

	getFooterName() {
		return 'footer' + _.upperFirst(this.footerMode);	//	e.g. 'footerEditor', 'footerEditorMenu', ...
	}

	getFormId(name) {
		return {
			header				: 0,
			body				: 1,
			footerEditor		: 2,
			footerEditorMenu	: 3,
			footerView			: 4,
			quoteBuilder		: 5,

			help				: 50,
		}[name];
	}

	//	:TODO: convert to something like this for all view acces:
	getHeaderViews() {
		var vc = this.viewControllers.header;

		if(this.isViewMode()) {
			return {
				from		: vc.getView(1),
				to			: vc.getView(2),
				subject		: vc.getView(3),

				dateTime	: vc.getView(5),
				msgNum		: vc.getView(7),
				//	...

			};
		}
	}

	setInitialFooterMode() {
		switch(this.editorMode) {
			case 'edit' : this.footerMode = 'editor'; break;
			case 'view' : this.footerMode = 'view'; break;
		}
	}

	buildMessage(cb) {
		const headerValues = this.viewControllers.header.getFormData().value;

		const msgOpts = {
			areaTag			: this.messageAreaTag,
			toUserName		: headerValues.to,
			fromUserName	: this.client.user.username,
			subject			: headerValues.subject,
			//	:TODO: don't hard code 1 here:
			message			: this.viewControllers.body.getView(1).getData( { forceLineTerms : this.replyIsAnsi } ),
		};

		if(this.isReply()) {
			msgOpts.replyToMsgId	= this.replyToMessage.messageId;

			if(this.replyIsAnsi) {
				//
				//	Ensure first characters indicate ANSI for detection down
				//	the line (other boards/etc.). We also set explicit_encoding
				//	to packetAnsiMsgEncoding (generally cp437) as various boards 
				//	really don't like ANSI messages in UTF-8 encoding (they should!)
				//
				msgOpts.meta		= { System : { 'explicit_encoding' : Config.scannerTossers.ftn_bso.packetAnsiMsgEncoding || 'cp437' } };
				//	:TODO: change to <ansi>\r\nESC[A<message>
				//msgOpts.message		= `${ansi.reset()}${ansi.eraseData(2)}${ansi.goto(1,1)}${msgOpts.message}`;
				msgOpts.message		= `${ansi.reset()}${ansi.eraseData(2)}${ansi.goto(1,1)}\r\n${ansi.up()}${msgOpts.message}`;
			}
		}

		this.message = new Message(msgOpts);

		return cb(null);
	}
	
	setMessage(message) {
		this.message = message;

		updateMessageAreaLastReadId(
			this.client.user.userId, this.messageAreaTag, this.message.messageId, () => {

				if(this.isReady) {
					this.initHeaderViewMode();
					this.initFooterViewMode();

					const bodyMessageView	= this.viewControllers.body.getView(1);
					let msg					= this.message.message;

					if(bodyMessageView && _.has(this, 'message.message')) {
						//
						//	We handle ANSI messages differently than standard messages -- this is required as
						//	we don't want to do things like word wrap ANSI, but instead, trust that it's formatted
						//	how the author wanted it
						//
						if(isAnsi(msg)) {
							//
							//	Find tearline - we want to color it differently.
							//
							const tearLinePos = this.message.getTearLinePosition(msg);

							if(tearLinePos > -1) {
								msg = insert(msg, tearLinePos, bodyMessageView.getSGRFor('text'));
							}

							bodyMessageView.setAnsi(
								msg.replace(/\r?\n/g, '\r\n'),	//	messages are stored with CRLF -> LF
								{
									prepped				: false,
									forceLineTerm		: true,
								}
							);
						} else {
							bodyMessageView.setText(cleanControlCodes(msg));
						}
					}
				}
			}
		);
	}

	getMessage(cb) {
		const self = this;

		async.series(
			[
				function buildIfNecessary(callback) {
					if(self.isEditMode()) {
						return self.buildMessage(callback);	//	creates initial self.message
					}

					return callback(null);
				},
				function populateLocalUserInfo(callback) {
					if(self.isLocalEmail()) {
						self.message.setLocalFromUserId(self.client.user.userId);
						
						if(self.toUserId > 0) {
							self.message.setLocalToUserId(self.toUserId);
							callback(null);
						} else {
							//	we need to look it up
							User.getUserIdAndName(self.message.toUserName, function userInfo(err, toUserId) {
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
	}

	updateUserStats(cb) {
		if(Message.isPrivateAreaTag(this.message.areaTag)) {
			if(cb) {
				cb(null);
			}
			return;	//	don't inc stats for private messages
		}

		return StatLog.incrementUserStat(this.client.user, 'post_count', 1, cb);
	}

	redrawFooter(options, cb) {
		const self = this;

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
					const footerArt = self.menuConfig.config.art[options.footerName];

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
	}

	redrawScreen(cb) {
		var comps	= [ 'header', 'body' ];
		const self	= this;
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
	}

	switchFooter(cb) {
		var footerName = this.getFooterName();

		this.redrawFooter( { footerName : footerName, clear : true }, (err, artData) => {
			if(err) {
				cb(err);
				return;
			}

			var formId = this.getFormId(footerName);

			if(_.isUndefined(this.viewControllers[footerName])) {
				var menuLoadOpts = {
					callingMenu	: this,
					formId		: formId,
					mciMap		: artData.mciMap
				};

				this.addViewController(
					footerName,
					new ViewController( { client : this.client, formId : formId } )
				).loadFromMenuConfig(menuLoadOpts, err => {
					cb(err);
				});
			} else {
				this.viewControllers[footerName].redrawAll();
				cb(null);
			}
		});
	}

	initSequence() {
		var mciData = { };
		const self	= this;
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
	}

	createInitialViews(mciData, cb) {
		const self = this;
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
							{
								const fromView = self.viewControllers.header.getView(1);
								const area = getMessageAreaByTag(self.messageAreaTag);
								if(area && area.realNames) {
									fromView.setText(self.client.user.properties.real_name || self.client.user.username);
								} else {
									fromView.setText(self.client.user.username);
								}

								if(self.replyToMessage) {
									self.initHeaderReplyEditMode();
								}
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
	}

	mciReadyHandler(mciData, cb) {

		this.createInitialViews(mciData, err => {
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
	}

	updateEditModePosition(pos) {
		if(this.isEditMode()) {
			var posView = this.viewControllers.footerEditor.getView(1);
			if(posView) {
				this.client.term.rawWrite(ansi.savePos());
				//	:TODO: Use new formatting techniques here, e.g. state.cursorPositionRow, cursorPositionCol and cursorPositionFormat
				posView.setText(_.padStart(String(pos.row + 1), 2, '0') + ',' + _.padEnd(String(pos.col + 1), 2, '0'));
				this.client.term.rawWrite(ansi.restorePos());
			}
		}
	}

	updateTextEditMode(mode) {
		if(this.isEditMode()) {
			var modeView = this.viewControllers.footerEditor.getView(2);
			if(modeView) {
				this.client.term.rawWrite(ansi.savePos());
				modeView.setText('insert' === mode ? 'INS' : 'OVR');
				this.client.term.rawWrite(ansi.restorePos());	
			}
		}
	}

	setHeaderText(id, text) {
		this.setViewText('header', id, text);
	}

	initHeaderViewMode() {
		assert(_.isObject(this.message));
		
		this.setHeaderText(MciCodeIds.ViewModeHeader.From,			this.message.fromUserName);
		this.setHeaderText(MciCodeIds.ViewModeHeader.To,			this.message.toUserName);
		this.setHeaderText(MciCodeIds.ViewModeHeader.Subject,		this.message.subject);
		this.setHeaderText(MciCodeIds.ViewModeHeader.DateTime,		moment(this.message.modTimestamp).format(this.client.currentTheme.helpers.getDateTimeFormat()));
		this.setHeaderText(MciCodeIds.ViewModeHeader.MsgNum,		(this.messageIndex + 1).toString());
		this.setHeaderText(MciCodeIds.ViewModeHeader.MsgTotal,		this.messageTotal.toString());
		this.setHeaderText(MciCodeIds.ViewModeHeader.ViewCount,		this.message.viewCount);
		this.setHeaderText(MciCodeIds.ViewModeHeader.HashTags,		'TODO hash tags');
		this.setHeaderText(MciCodeIds.ViewModeHeader.MessageID,		this.message.messageId);
		this.setHeaderText(MciCodeIds.ViewModeHeader.ReplyToMsgID,	this.message.replyToMessageId);
	}

	initHeaderReplyEditMode() {
		assert(_.isObject(this.replyToMessage));

		this.setHeaderText(MciCodeIds.ReplyEditModeHeader.To, this.replyToMessage.fromUserName);

		//
		//	We want to prefix the subject with "RE: " only if it's not already
		//	that way -- avoid RE: RE: RE: RE: ...
		//
		let newSubj = this.replyToMessage.subject;
		if(false === /^RE:\s+/i.test(newSubj)) {
			newSubj = `RE: ${newSubj}`;
		}

		this.setHeaderText(MciCodeIds.ReplyEditModeHeader.Subject,	newSubj);
	}

	initFooterViewMode() {
		this.setViewText('footerView', MciCodeIds.ViewModeFooter.MsgNum, (this.messageIndex + 1).toString() );
		this.setViewText('footerView', MciCodeIds.ViewModeFooter.MsgTotal, this.messageTotal.toString() );
	}

	displayHelp(cb) {
		this.client.term.rawWrite(ansi.resetScreen());

		theme.displayThemeArt(
			{ name : this.menuConfig.config.art.help, client : this.client },
			() => {
				this.client.waitForKeyPress( () => {
					this.redrawScreen( () => {
						this.viewControllers[this.getFooterName()].setFocus(true);
						return cb(null);
					});
				});
			}
		);
	}

	displayQuoteBuilder() {
		//
		//	Clear body area
		//
		this.newQuoteBlock = true;
		const self = this;
		
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
					const quoteView = self.viewControllers.quoteBuilder.getView(3);
					const bodyView	= self.viewControllers.body.getView(1);

					self.replyToMessage.getQuoteLines(
						{
							termWidth			: self.client.term.termWidth,
							termHeight			: self.client.term.termHeight,
							cols				: quoteView.dimens.width,
							startCol			: quoteView.position.col,
							ansiResetSgr		: bodyView.styleSGR1,
							ansiFocusPrefixSgr	: quoteView.styleSGR2,
						},
						(err, quoteLines, focusQuoteLines, replyIsAnsi) => {
							if(err) {
								return callback(err);
							}

							self.replyIsAnsi = replyIsAnsi;

							quoteView.setItems(quoteLines);
							quoteView.setFocusItems(focusQuoteLines);

							return callback(null);
						}
					);
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
	}

	observeEditorEvents() {
		const bodyView = this.viewControllers.body.getView(1);

		bodyView.on('edit position', pos => {
			this.updateEditModePosition(pos);
		});

		bodyView.on('text edit mode', mode => {
			this.updateTextEditMode(mode);
		});
	}

	/*
	this.observeViewPosition = function() {
		self.viewControllers.body.getView(1).on('edit position', function positionUpdate(pos) {
			console.log(pos.percent + ' / ' + pos.below)
		});
	};
	*/

	switchToHeader() {
		this.viewControllers.body.setFocus(false);
		this.viewControllers.header.switchFocus(2);	//	to
	}

	switchToBody() {
		this.viewControllers.header.setFocus(false);
		this.viewControllers.body.switchFocus(1);

		this.observeEditorEvents();
	};

	switchToFooter() {
		this.viewControllers.header.setFocus(false);
		this.viewControllers.body.setFocus(false);

		this.viewControllers[this.getFooterName()].switchFocus(1);	//	HM1
	}

	switchFromQuoteBuilderToBody() {
		this.viewControllers.quoteBuilder.setFocus(false);
		var body = this.viewControllers.body.getView(1);
		body.redraw();
		this.viewControllers.body.switchFocus(1);
		
		//	:TODO: create method (DRY)
		
		this.updateTextEditMode(body.getTextEditMode());
		this.updateEditModePosition(body.getEditPosition());

		this.observeEditorEvents();
	}
	
	quoteBuilderFinalize() {
		//	:TODO: fix magic #'s
		const quoteMsgView	= this.viewControllers.quoteBuilder.getView(1);
		const msgView		= this.viewControllers.body.getView(1);
				
		let quoteLines 		= quoteMsgView.getData().trim();
		
		if(quoteLines.length > 0) {
			if(this.replyIsAnsi) {
				const bodyMessageView = this.viewControllers.body.getView(1);
				quoteLines += `${ansi.normal()}${bodyMessageView.getSGRFor('text')}`;
			}
			msgView.addText(`${quoteLines}\n\n`);
		}
		
		quoteMsgView.setText('');

		this.footerMode = 'editor';

		this.switchFooter( () => {
			this.switchFromQuoteBuilderToBody();
		});
	}

	getQuoteByHeader() {
		let quoteFormat = this.menuConfig.config.quoteFormats;

		if(Array.isArray(quoteFormat)) {			
			quoteFormat =  quoteFormat[ Math.floor(Math.random() * quoteFormat.length) ];
		} else if(!_.isString(quoteFormat)) {
			quoteFormat = 'On {dateTime} {userName} said...';
		}

		const dtFormat = this.menuConfig.config.quoteDateTimeFormat || this.client.currentTheme.helpers.getDateTimeFormat();	
		return stringFormat(quoteFormat, { 
			dateTime	: moment(this.replyToMessage.modTimestamp).format(dtFormat),
			userName	: this.replyToMessage.fromUserName,
		});
	}

	enter() {
		if(this.messageAreaTag) {
			this.tempMessageConfAndAreaSwitch(this.messageAreaTag);
		}

		super.enter();
	}

	leave() {
		this.tempMessageConfAndAreaRestore();
		super.leave();
	}

	mciReady(mciData, cb) {
		return this.mciReadyHandler(mciData, cb);
	}
};
