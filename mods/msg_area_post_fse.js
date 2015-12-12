/* jslint node: true */
'use strict';

var FullScreenEditorModule		= require('../core/fse.js').FullScreenEditorModule;
var Message						= require('../core/message.js').Message;
var user						= require('../core/user.js');

var _							= require('lodash');
var async					 	= require('async');

exports.getModule				= AreaPostFSEModule;

exports.moduleInfo = {
	name	: 'Message Area Post',
	desc	: 'Module for posting a new message to an area',
	author	: 'NuSkooler',
};

function AreaPostFSEModule(options) {
	FullScreenEditorModule.call(this, options);

	var self = this;

	//	we're posting, so always start with 'edit' mode
	this.editorMode = 'edit';

	this.menuMethods.editModeMenuSave = function(formData, extraArgs) {

		var msg;
		async.series(
			[
				function getMessageObject(callback) {
					self.getMessage(function gotMsg(err, msgObj) {
						msg = msgObj;
						callback(err);
					});
				},
				function saveMessage(callback) {
					msg.persist(function persisted(err) {
						callback(err);
					});
				}
			],
			function complete(err) {
				if(err) {
					//	:TODO:... sooooo now what?
				} else {
					console.log(msg);
				}

				self.nextMenu();
			}
		);
	};
}

require('util').inherits(AreaPostFSEModule, FullScreenEditorModule);

AreaPostFSEModule.prototype.enter = function(client) {	

	if(_.isString(client.user.properties.message_area_name) && !_.isString(this.messageAreaName)) {
		this.messageAreaName = client.user.properties.message_area_name;
	}
	
	AreaPostFSEModule.super_.prototype.enter.call(this, client);
};
