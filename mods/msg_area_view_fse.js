/* jslint node: true */
'use strict';

//	ENiGMA½
const FullScreenEditorModule		= require('../core/fse.js').FullScreenEditorModule;
const Message						= require('../core/message.js');

//	deps
const _							= require('lodash');

exports.getModule				= AreaViewFSEModule;

exports.moduleInfo = {
	name	: 'Message Area View',
	desc	: 'Module for viewing an area message',
	author	: 'NuSkooler',
};

function AreaViewFSEModule(options) {
	FullScreenEditorModule.call(this, options);

	const self		= this;

	this.editorType			= 'area';
	this.editorMode			= 'view';

	if(_.isObject(options.extraArgs)) {
		this.messageList		= options.extraArgs.messageList;
		this.messageIndex		= options.extraArgs.messageIndex;
	}

	this.messageList	= this.messageList || [];
	this.messageIndex	= this.messageIndex || 0;
	this.messageTotal	= this.messageList.length;

	this.menuMethods.nextMessage = function(formData, extraArgs, cb) {
		if(self.messageIndex + 1 < self.messageList.length) {
			self.messageIndex++;

			return self.loadMessageByUuid(self.messageList[self.messageIndex].messageUuid, cb);
		}

		return cb(null);
	};

	this.menuMethods.prevMessage = function(formData, extraArgs, cb) {
		if(self.messageIndex > 0) {
			self.messageIndex--;

			return self.loadMessageByUuid(self.messageList[self.messageIndex].messageUuid, cb);
		}

		return cb(null);
	};

	this.menuMethods.movementKeyPressed = function(formData, extraArgs, cb) {
		const bodyView = self.viewControllers.body.getView(1);	//	:TODO: use const here vs magic #

		//	:TODO: Create methods for up/down vs using keyPressXXXXX
		switch(formData.key.name) {
			case 'down arrow'	: bodyView.scrollDocumentUp(); break;
			case 'up arrow'		: bodyView.scrollDocumentDown(); break;
			case 'page up'		: bodyView.keyPressPageUp(); break;
			case 'page down'	: bodyView.keyPressPageDown(); break;			
		}

		//	:TODO: need to stop down/page down if doing so would push the last
		//	visible page off the screen at all .... this should be handled by MLTEV though...

		return cb(null);

	};

	this.menuMethods.replyMessage = function(formData, extraArgs, cb) {
		if(_.isString(extraArgs.menu)) {
			const modOpts = {
				extraArgs : {
					messageAreaTag		: self.messageAreaTag,
					replyToMessage		: self.message,	
				}				
			};

			return self.gotoMenu(extraArgs.menu, modOpts, cb);
		}
		
		self.client.log(extraArgs, 'Missing extraArgs.menu');
		return cb(null);
	};

	this.loadMessageByUuid = function(uuid, cb) {
		const msg = new Message();
		msg.load( { uuid : uuid, user : self.client.user }, () => {
			self.setMessage(msg);
			if(cb) {
				return cb(null);
			}
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
	};
};

AreaViewFSEModule.prototype.restoreSavedState = function(savedState) {
	AreaViewFSEModule.super_.prototype.restoreSavedState.call(this, savedState);

	this.messageList	= savedState.messageList;
	this.messageIndex	= savedState.messageIndex;
	this.messageTotal	= savedState.messageTotal;
};

AreaViewFSEModule.prototype.getMenuResult = function() {
	return this.messageIndex;
};
