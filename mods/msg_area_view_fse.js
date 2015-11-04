/* jslint node: true */
'use strict';

var FullScreenEditorModule		= require('../core/fse.js').FullScreenEditorModule;
var Message						= require('../core/message.js');
var messageArea					= require('../core/message_area.js');
var user						= require('../core/user.js');

var _							= require('lodash');
var async					 	= require('async');
var assert						= require('assert');

exports.getModule				= AreaViewFSEModule;

exports.moduleInfo = {
	name	: 'Message Area View',
	desc	: 'Module for viewing an area message',
	author	: 'NuSkooler',
};

function AreaViewFSEModule(options) {
	FullScreenEditorModule.call(this, options);

	var self		= this;
	var config		= this.menuConfig.config;

	this.editorType			= 'area';
	this.editorMode			= 'view';

	if(_.isObject(options.extraArgs)) {
		this.messageList		= options.extraArgs.messageList;
		this.messageIndex		= options.extraArgs.messageIndex;
	}

	this.messageList	= this.messageList || [];
	this.messageIndex	= this.messageIndex || 0;
	this.messageTotal	= this.messageList.length;

	this.menuMethods.nextMessage = function(formData, extraArgs) {
		if(self.messageIndex + 1 < self.messageList.length) {
			self.messageIndex++;

			self.loadMessageByUuid(self.messageList[self.messageIndex].messageUuid);
		}
	};

	this.menuMethods.prevMessage = function(formData, extraArgs) {
		if(self.messageIndex > 0) {
			self.messageIndex--;

			self.loadMessageByUuid(self.messageList[self.messageIndex].messageUuid);
		}
	};

	this.menuMethods.movementKeyPressed = function(formData, extraArgs) {
		var bodyView = self.viewControllers.body.getView(1);

		//	:TODO: Create methods for up/down vs using keyPressXXXXX
		switch(formData.key.name) {
			case 'down arrow'	: bodyView.scrollDocumentUp(); break;
			case 'up arrow'		: bodyView.scrollDocumentDown(); break;
			case 'page up'		: bodyView.keyPressPageUp(); break;
			case 'page down'	: bodyView.keyPressPageDown(); break;			
		}

		//	:TODO: need to stop down/page down if doing so would push the last
		//	visible page off the screen at all

	};

	this.menuMethods.replyMessage = function(formData, extraArgs) {
		if(_.isString(extraArgs.menu)) {
			var modOpts = {
				extraArgs : {
					messageAreaName		: self.messageAreaName,
					replyToMessage		: self.message,	
				}				
			};

			self.gotoMenu(extraArgs.menu, modOpts);
		} else {
			self.client.log(extraArgs, 'Missing extraArgs.menu');
		}
	};

	this.loadMessageByUuid = function(uuid) {
		var msg = new Message();
		msg.load( { uuid : uuid, user : self.client.user }, function loaded(err) {
			self.setMessage(msg);
		});
	};
}

require('util').inherits(AreaViewFSEModule, FullScreenEditorModule);

AreaViewFSEModule.prototype.finishedLoading = function() {
	if(this.messageList.length) {
		this.loadMessageByUuid(this.messageList[this.messageIndex].messageUuid);
	}
};

AreaViewFSEModule.prototype.getSaveState = function() {
	AreaViewFSEModule.super_.prototype.getSaveState.call(this);

	return {
		messageList		: this.messageList,
		messageIndex	: this.messageIndex,
		messageTotal	: this.messageList.length,
	}
};

AreaViewFSEModule.prototype.restoreSavedState = function(savedState) {
	AreaViewFSEModule.super_.prototype.restoreSavedState.call(this, savedState);

	this.messageList	= savedState.messageList;
	this.messageIndex	= savedState.messageIndex;
	this.messageTotal	= savedState.messageTotal;
};