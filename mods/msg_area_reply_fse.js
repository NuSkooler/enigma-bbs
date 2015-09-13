/* jslint node: true */
'use strict';

var FullScreenEditorModule		= require('../core/fse.js').FullScreenEditorModule;
var Message						= require('../core/message.js');
var messageArea					= require('../core/message_area.js');
var user						= require('../core/user.js');

var _							= require('lodash');
var async					 	= require('async');
var assert						= require('assert');

exports.getModule				= AreaReplyFSEModule;

exports.moduleInfo = {
	name	: 'Message Area Reply',
	desc	: 'Module for replying to an area message',
	author	: 'NuSkooler',
};

function AreaReplyFSEModule(options) {
	FullScreenEditorModule.call(this, options);
}

require('util').inherits(AreaReplyFSEModule, FullScreenEditorModule);
