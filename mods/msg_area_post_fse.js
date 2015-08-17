/* jslint node: true */
'use strict';

var FullScreenEditorModule		= require('../core/fse.js').FullScreenEditorModule;
var Message						= require('../core/message.js').Message;

var _							= require('lodash');

exports.getModule				= AreaPostFSEModule;

exports.moduleInfo = {
	name	: 'Message Area Post',
	desc	: 'Module posting a new message to an area',
	author	: 'NuSkooler',
};

function AreaPostFSEModule(options) {
	FullScreenEditorModule.call(this, options);

	var self = this;

	//	we're posting, so always start with 'edit' mode
	this.editorMode = 'edit';

	//
	//	If messageAreaId is passed in extraArgs, use it. Otherwise, look
	//	to the client user for current area ID
	//
	if(_.isNumber(client.user.properties.message_area_id)) {
		this.messageAreaId = client.user.properties.message_area_id;	
	}

	this.menuMethods.editModeMenuSave = function(formData, extraArgs) {
		var msg = self.getMessage();
		console.log(msg);
	};
}

require('util').inherits(AreaPostFSEModule, FullScreenEditorModule);

