/* jslint node: true */
'use strict';

let FullScreenEditorModule		= require('../core/fse.js').FullScreenEditorModule;
//var Message						= require('../core/message.js').Message;
let persistMessage				= require('../core/message_area.js').persistMessage; 
let user						= require('../core/user.js');

let _							= require('lodash');
let async					 	= require('async');

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
					persistMessage(msg, callback);
					/*
					msg.persist(function persisted(err) {
						callback(err);
					});
					*/
				}
			],
			function complete(err) {
				if(err) {
					//	:TODO:... sooooo now what?
				} else {
					console.log(msg);	//	:TODO: remove me -- probably log that one was saved, however.
				}

				self.nextMenu();
			}
		);
	};
}

require('util').inherits(AreaPostFSEModule, FullScreenEditorModule);

AreaPostFSEModule.prototype.enter = function() {	

	if(_.isString(this.client.user.properties.message_area_tag) && !_.isString(this.messageAreaTag)) {
		this.messageAreaTag = this.client.user.properties.message_area_tag;
	}
	
	AreaPostFSEModule.super_.prototype.enter.call(this);
};
