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

	this.menuMethods.editModeMenuSave = function(formData, extraArgs) {
		var msg = self.getMessage();
		console.log(msg);
	};
}

require('util').inherits(AreaPostFSEModule, FullScreenEditorModule);

