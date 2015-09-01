/* jslint node: true */
'use strict';

var FullScreenEditorModule		= require('../core/fse.js').FullScreenEditorModule;
var Message						= require('../core/message.js').Message;
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

	//assert(_.isString(options.extraArgs.messageAreaName),	'messageAreaName must be supplied!');
	//assert(options.extraArgs.messageId,						'messageId must be supplied!');
	//assert(_.isString(options.extraArgs.messageUuid),		'messageUuid must be supplied!');
	//this.messageUuid		= options.extraArgs.messageUuid;
	/*
	this.loadMessage = function(uuid) {
		var msg = new Message();
		msg.load( { uuid : uuid, user : self.client.user }, function loaded(err) {
			//	:TODO: Hrm... if error...
			self.setMessage(msg);
		});
	};
	*/


}

require('util').inherits(AreaViewFSEModule, FullScreenEditorModule);

/*
AreaViewFSEModule.prototype.enter = function(client) {	
	AreaViewFSEModule.super_.prototype.enter.call(this, client);
};

*/

AreaViewFSEModule.prototype.finishedLoading = function() {
	//AreaViewFSEModule.super_.prototype.finishedLoading.call(this);

	this.loadMessage(this.messageUuid);
};